"""FastAPI application: versioned registration endpoints for the BillieWeather apps.

    uv run uvicorn identity_api.main:app --port 8100 --no-access-log
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict

from . import logs
from .config import Settings, get_settings
from .db import Database
from .errors import ApiError
from .google import GoogleClient, GoogleFlows, callback_page
from .mailer import Mailer, build_mailer
from .passwords import PwnedChecker
from .ratelimit import RateLimited, RateLimiter
from .registration import RegistrationInput, RegistrationService
from .schema import compatibility_problems, identity_schema_ready
from .validation import PASSWORD_MAX, PASSWORD_MIN

log = logging.getLogger("identity_api")
MAX_BODY_BYTES = 16 * 1024


@dataclass
class Services:
    settings: Settings
    db: Database
    registrations: RegistrationService
    google: GoogleFlows
    limiter: RateLimiter
    ready: bool = False
    problems: tuple[str, ...] = ()


def build_services(settings: Settings, *, mail: Mailer | None = None, pwned: PwnedChecker | None = None,
                   google_client: GoogleClient | None = None, db: Database | None = None) -> Services:
    db = db or Database(settings.database_url, settings.db_pool_max, environment=settings.identity_env, env=settings.database_target_env)
    pwned = pwned or PwnedChecker(settings.pwned_enabled, timeout=settings.pwned_timeout_seconds)
    if google_client is None and settings.google_configured:
        google_client = GoogleClient(settings.google_client_id, settings.google_client_secret, settings.google_redirect_uri)
    return Services(
        settings=settings, db=db,
        registrations=RegistrationService(db, settings, mail or build_mailer(settings), pwned),
        google=GoogleFlows(db, settings, google_client, pwned),
        limiter=RateLimiter(),
    )


def check_ready(services: Services) -> None:
    try:
        with services.db.transaction() as conn:
            problems = compatibility_problems(conn)
            if not identity_schema_ready(conn):
                problems.append("identity schema not migrated (apply the approved schema release before starting)")
    except Exception as error:  # noqa: BLE001 - reported, never raised at startup
        problems = [f"database unavailable ({type(error).__name__})"]
    services.problems = tuple(problems)
    services.ready = not problems
    if problems:
        log.error("identity_api_not_ready problems=%s", "; ".join(problems))


# --- request bodies (loosely typed: validation and messages are ours) ---------------------------

class Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


class RegisterBody(Body):
    email: str | None = None
    password: str | None = None
    password_confirmation: str | None = None
    usage_region: str | None = None
    nickname: str | None = None
    locale: str | None = None


class SecretBody(Body):
    registration_secret: str | None = None


class ConfirmBody(SecretBody):
    code: str | None = None


class FlowStartBody(Body):
    code_challenge: str | None = None
    code_challenge_method: str | None = None
    locale: str | None = None


class VerifierBody(Body):
    code_verifier: str | None = None


class FlowCompleteBody(VerifierBody):
    password: str | None = None
    password_confirmation: str | None = None
    usage_region: str | None = None
    nickname: str | None = None


class FlowLinkBody(VerifierBody):
    password: str | None = None


def client_ip(request: Request, hops: int) -> str:
    if hops > 0:
        forwarded = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",") if part.strip()]
        if len(forwarded) >= hops:
            return forwarded[-hops]
    return request.client.host if request.client else "unknown"


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    settings = settings or (services.settings if services else get_settings())
    settings.validate_for_runtime()
    logs.configure(settings.log_level)
    if not settings.email_verification_required:
        log.warning("verification_bypass_on mode=%s env=%s allowlisted=%d (accounts are created with UNVERIFIED email)",
                    settings.email_verification_mode, settings.identity_env, len(settings.bypass_allowlist))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        svc: Services = app.state.services
        svc.db.open()
        check_ready(svc)
        yield
        svc.db.close()

    app = FastAPI(title="BillieWeather Identity API", version="1.0.0", lifespan=lifespan,
                  docs_url=None if settings.production else "/docs", redoc_url=None,
                  openapi_url=None if settings.production else "/openapi.json")
    app.state.services = services or build_services(settings)

    def svc() -> Services:
        return app.state.services

    def require_ready() -> None:
        if not svc().ready:
            check_ready(svc())  # the database may have come up since startup
        if not svc().ready:
            raise ApiError(503, "service_not_ready")

    def limit(request: Request, name: str, key: str | None = None) -> None:
        svc().limiter.hit(name, key if key is not None else client_ip(request, settings.trusted_proxy_hops))

    app.add_middleware(
        CORSMiddleware, allow_origins=settings.origins, allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "Accept"], max_age=600,
    )

    @app.middleware("http")
    async def guard(request: Request, call_next):
        started = time.perf_counter()
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
            response: Response = JSONResponse({"error": "payload_too_large"}, status_code=413)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if settings.production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        route = request.scope.get("route")
        log.info("request method=%s route=%s status=%s ms=%d", request.method, getattr(route, "path", "unmatched"),
                 response.status_code, (time.perf_counter() - started) * 1000)
        return response

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, error: ApiError):
        headers = {"Retry-After": str(error.extra["retry_after"])} if "retry_after" in error.extra else None
        return JSONResponse(error.body(), status_code=error.status, headers=headers)

    @app.exception_handler(RateLimited)
    async def rate_limited(_request: Request, error: RateLimited):
        return JSONResponse({"error": "rate_limited", "retry_after": error.retry_after}, status_code=429,
                            headers={"Retry-After": str(error.retry_after)})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, error: RequestValidationError):
        # FastAPI's default echoes the submitted input (passwords included); never do that.
        fields: dict[str, list[str]] = {}
        for problem in error.errors():
            location = [str(part) for part in problem.get("loc", ()) if part not in ("body", "path", "query")]
            fields.setdefault(".".join(location) or "body", []).append("invalid")
        return JSONResponse({"error": "invalid", "fields": fields}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(_request: Request, error: Exception):
        log.error("unhandled_error type=%s", type(error).__name__)
        return JSONResponse({"error": "server_error"}, status_code=500)

    # --- routes ---------------------------------------------------------------------------

    @app.get("/health")
    def health():
        state = svc()
        body = {"status": "ok" if state.ready else "not_ready"}
        if not settings.production:
            body["problems"] = list(state.problems)
        return JSONResponse(body, status_code=200 if state.ready else 503)

    @app.get("/v1/config")
    def config():
        return {"registration_open": settings.registration_enabled, "google_available": svc().google.client is not None,
                "password": {"min": PASSWORD_MIN, "max": PASSWORD_MAX}, "code_length": 8,
                # Lets a development client say "not emailed, see the outbox" instead of "we emailed".
                "mail_delivery": "postmark" if settings.production else settings.mail_delivery,
                # required | allowlist | disabled. The allowlist itself is never published; the
                # register response (201 created vs 202 pending) is what decides the client's next screen.
                "email_verification": settings.email_verification_mode}

    @app.post("/v1/registrations", status_code=202)
    def register(body: RegisterBody, request: Request, response: Response):
        require_ready()
        limit(request, "register_ip")
        if body.email:
            limit(request, "register_email", body.email.strip().lower())
        result = svc().registrations.register(RegistrationInput(**body.model_dump()))
        if result.get("status") == "created":  # verification bypass: the account exists now
            response.status_code = 201
        return result

    @app.post("/v1/registrations/{registration_id}/confirmation", status_code=201)
    def confirm(registration_id: str, body: ConfirmBody, request: Request):
        require_ready()
        limit(request, "confirm_ip")
        return svc().registrations.confirm(registration_id, body.registration_secret, body.code)

    @app.post("/v1/registrations/{registration_id}/resend", status_code=202)
    def resend(registration_id: str, body: SecretBody, request: Request):
        require_ready()
        limit(request, "resend_ip")
        return svc().registrations.resend(registration_id, body.registration_secret)

    @app.post("/v1/google/flows", status_code=201)
    def google_start(body: FlowStartBody, request: Request):
        require_ready()
        limit(request, "google_start_ip")
        return svc().google.start(body.code_challenge, body.code_challenge_method, body.locale)

    @app.get("/v1/google/callback", response_class=HTMLResponse)
    def google_callback(request: Request, state: str | None = None, code: str | None = None, error: str | None = None):
        page, locale = ("failed", None)
        if svc().ready:
            try:
                limit(request, "google_finish_ip")
                page, locale = svc().google.callback(state, code, error)
            except RateLimited:
                page = "failed"
        status = 200 if page in ("done", "cancelled") else 400
        return HTMLResponse(callback_page(page, locale), status_code=status, headers={
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"})

    @app.post("/v1/google/flows/{flow_id}/status")
    def google_status(flow_id: str, body: VerifierBody, request: Request):
        require_ready()
        limit(request, "google_poll_ip")
        return svc().google.status(flow_id, body.code_verifier)

    @app.post("/v1/google/flows/{flow_id}/complete", status_code=201)
    def google_complete(flow_id: str, body: FlowCompleteBody, request: Request):
        require_ready()
        limit(request, "google_finish_ip")
        return svc().google.complete(flow_id, body.code_verifier, body.password, body.password_confirmation, body.usage_region, body.nickname)

    @app.post("/v1/google/flows/{flow_id}/link")
    def google_link(flow_id: str, body: FlowLinkBody, request: Request):
        require_ready()
        limit(request, "google_finish_ip")
        return svc().google.link(flow_id, body.code_verifier, body.password)

    @app.post("/v1/google/flows/{flow_id}/cancel", status_code=204)
    def google_cancel(flow_id: str, body: VerifierBody, request: Request):
        require_ready()
        limit(request, "google_poll_ip")
        svc().google.cancel(flow_id, body.code_verifier)
        return Response(status_code=204)

    return app


def __getattr__(name: str):
    # `uvicorn identity_api.main:app` builds the app lazily, so importing this module (tests) needs no environment.
    if name == "app":
        return create_app()
    raise AttributeError(name)
