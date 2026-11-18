"""Google sign-up and account linking for the apps.

Why this shape: Google forbids its sign-in page in embedded WebViews, and custom URL schemes are
not allowed redirect URIs for web clients. So the app opens Google in the system browser, this
service is the OAuth client (authorization code + PKCE + nonce, redirect URI on this service),
and the app learns the result by polling with a verifier only it holds (RFC 7636 style). No
data travels through the billieweather:// link (the success page only offers billieweather://open),
so another app that registers the same scheme learns nothing.

Account rules are the website's (app/services/google_sign_in.rb):
- Only a verified Google email is accepted; the Google `sub` is the identity, never the email alone.
- A Google identity already linked -> the account exists; sign in normally.
- An existing account with that email -> linking requires that account's password (and is refused
  for two-factor, locked, agent or differently linked accounts, as on the website).
- Otherwise a new account is created (region required). Google profile names are not stored.

Interim limitation (see README "Compatibility blockers"): the apps' session tokens are issued only
by Rails, so a Google sign-up in the app also sets a BillieWeather password, and the app then signs
in through the existing email/password endpoint.
"""
from __future__ import annotations

import hmac
import html
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urlencode

import httpx
import jwt

from . import accounts, tokens
from .db import Database
from .errors import ApiError, invalid
from .passwords import PwnedChecker, hash_password, verify_password
from .registration import utcnow
from .validation import email_errors, normalize_email, normalize_locale, password_errors, validate_profile

log = logging.getLogger("identity_api.google")

FLOW_TTL = timedelta(minutes=10)
MAX_LINK_ATTEMPTS = 5
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")


class ProviderError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class GoogleIdentity:
    uid: str
    email: str


class GoogleClient:
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, http: httpx.Client | None = None, clock=time.time):  # noqa: ANN001
        self.client_id = client_id.strip()
        self.client_secret = client_secret.strip()
        self.redirect_uri = redirect_uri
        self.http = http or httpx.Client(timeout=10.0)
        self.clock = clock
        self._jwks: tuple[float, dict] | None = None

    def authorization_url(self, state: str, nonce: str, code_challenge: str) -> str:
        return AUTH_URL + "?" + urlencode({
            "client_id": self.client_id, "redirect_uri": self.redirect_uri, "response_type": "code",
            "scope": "openid email", "state": state, "nonce": nonce, "code_challenge": code_challenge,
            "code_challenge_method": "S256", "prompt": "select_account", "access_type": "online",
        })

    def _keys(self, refresh: bool = False) -> dict:
        if not refresh and self._jwks and self._jwks[0] > self.clock():
            return self._jwks[1]
        response = self.http.get(JWKS_URL)
        response.raise_for_status()
        keys = {key["kid"]: key for key in response.json().get("keys", []) if "kid" in key}
        self._jwks = (self.clock() + 3600, keys)
        return keys

    def exchange(self, code: str, verifier: str, nonce: str) -> GoogleIdentity:
        try:
            response = self.http.post(TOKEN_URL, data={
                "code": code, "client_id": self.client_id, "client_secret": self.client_secret,
                "redirect_uri": self.redirect_uri, "grant_type": "authorization_code", "code_verifier": verifier,
            })
        except httpx.HTTPError:
            raise ProviderError("provider_unreachable") from None
        if response.status_code != 200:
            raise ProviderError("token_exchange_failed")
        id_token = response.json().get("id_token")
        if not isinstance(id_token, str):
            raise ProviderError("token_exchange_failed")
        return self.verify_id_token(id_token, nonce)

    def verify_id_token(self, id_token: str, nonce: str) -> GoogleIdentity:
        try:
            kid = jwt.get_unverified_header(id_token).get("kid")
            keys = self._keys()
            if kid not in keys:
                keys = self._keys(refresh=True)
            if kid not in keys:
                raise ProviderError("unverified_identity")
            key = jwt.PyJWK(keys[kid]).key
            claims = jwt.decode(id_token, key=key, algorithms=["RS256"], audience=self.client_id, issuer=list(ISSUERS),
                                options={"require": ["exp", "iat", "iss", "aud", "sub"]}, leeway=30)
        except (jwt.PyJWTError, httpx.HTTPError, ValueError, KeyError):
            raise ProviderError("unverified_identity") from None
        if not hmac.compare_digest(nonce.encode(), str(claims.get("nonce", "")).encode()):
            raise ProviderError("unverified_identity")
        uid = claims.get("sub")
        if not (isinstance(uid, str) and 1 <= len(uid) <= 255 and not any(ch.isspace() for ch in uid)):
            raise ProviderError("unverified_identity")
        if claims.get("email_verified") not in (True, "true"):
            raise ProviderError("unverified_email")
        email = normalize_email(claims.get("email"))
        if email_errors(email):
            raise ProviderError("unverified_email")
        return GoogleIdentity(uid=uid, email=email)


class GoogleFlows:
    def __init__(self, db: Database, settings, client: GoogleClient | None, pwned: PwnedChecker, clock=utcnow):  # noqa: ANN001
        self.db = db
        self.settings = settings
        self.client = client
        self.pwned = pwned
        self.clock = clock

    def _key(self) -> bytes:
        return self.settings.hmac_key

    def _require_client(self) -> GoogleClient:
        if self.client is None:
            raise ApiError(503, "google_unavailable")
        return self.client

    def _load(self, conn, flow_id: str, verifier: object) -> dict:  # noqa: ANN001
        try:
            uuid.UUID(str(flow_id))
        except ValueError:
            raise ApiError(404, "not_found") from None
        if not tokens.valid_verifier(verifier):
            raise ApiError(404, "not_found")
        row = conn.execute("SELECT * FROM identity.oauth_flows WHERE id = %s FOR UPDATE", (flow_id,)).fetchone()
        if row is None or not hmac.compare_digest(row["client_challenge"].encode(), tokens.s256(verifier).encode()):
            raise ApiError(404, "not_found")
        return row

    # -- start -------------------------------------------------------------------------------

    def start(self, code_challenge: object, method: object, locale: object) -> dict:
        client = self._require_client()
        if method != "S256" or not tokens.valid_challenge(code_challenge):
            raise invalid({"code_challenge": ["invalid"]})
        now = self.clock()
        state, nonce, verifier = tokens.new_secret(), tokens.new_secret(), tokens.new_verifier()
        with self.db.transaction() as conn:
            row = conn.execute(
                "INSERT INTO identity.oauth_flows (id, state_digest, nonce, provider_verifier, client_challenge, locale, expires_at, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, expires_at",
                (str(uuid.uuid4()), tokens.digest(self._key(), "oauth-state", state), nonce, verifier, code_challenge,
                 normalize_locale(locale), now + FLOW_TTL, now, now),
            ).fetchone()
        return {"flow_id": str(row["id"]), "authorization_url": client.authorization_url(state, nonce, tokens.s256(verifier)),
                "expires_at": row["expires_at"].isoformat()}

    # -- callback (system browser) ---------------------------------------------------------------

    def callback(self, state: str | None, code: str | None, error: str | None) -> tuple[str, str | None]:
        """Returns (page, locale) where page is one of done / cancelled / failed / expired."""
        if not state:
            return "failed", None
        now = self.clock()
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM identity.oauth_flows WHERE state_digest = %s FOR UPDATE",
                (tokens.digest(self._key(), "oauth-state", state),),
            ).fetchone()
            if row is None:
                return "expired", None
            if row["status"] in ("verified", "completed"):
                return "done", row["locale"]
            if row["status"] != "started":
                return row["status"], row["locale"]  # cancelled / failed
            if row["expires_at"] <= now:
                return "expired", row["locale"]
            if error or not code:
                status, failure = ("cancelled", "cancelled") if error == "access_denied" else ("failed", "provider_error")
                conn.execute("UPDATE identity.oauth_flows SET status = %s, failure = %s, provider_verifier = '', updated_at = %s WHERE id = %s",
                             (status, failure, now, row["id"]))
                return status, row["locale"]
            # Single use: the provider verifier is consumed before talking to Google.
            conn.execute("UPDATE identity.oauth_flows SET provider_verifier = '', updated_at = %s WHERE id = %s", (now, row["id"]))
            verifier, nonce, flow_id, locale = row["provider_verifier"], row["nonce"], row["id"], row["locale"]
        if not verifier:
            return "failed", locale
        try:
            identity = self._require_client().exchange(code, verifier, nonce)
        except (ProviderError, ApiError) as failure:
            reason = failure.reason if isinstance(failure, ProviderError) else failure.code
            log.warning("google_callback_failed reason=%s", reason)
            with self.db.transaction() as conn:
                conn.execute("UPDATE identity.oauth_flows SET status = 'failed', failure = %s, updated_at = %s WHERE id = %s AND status = 'started'",
                             (reason, self.clock(), flow_id))
            return "failed", locale
        with self.db.transaction() as conn:
            outcome, failure_reason, account_email = self._outcome(conn, identity)
            conn.execute(
                "UPDATE identity.oauth_flows SET status = 'verified', outcome = %s, failure = %s, provider_uid = %s, email = %s, updated_at = %s "
                "WHERE id = %s AND status = 'started'",
                (outcome, failure_reason, identity.uid, account_email, self.clock(), flow_id),
            )
        return "done", locale

    def _outcome(self, conn, identity: GoogleIdentity) -> tuple[str, str | None, str]:  # noqa: ANN001
        """(outcome, failure, email of the BillieWeather account the app should sign in to)."""
        linked = accounts.find_by_google_uid(conn, identity.uid)
        if linked:
            return "already_linked", None, linked["email"]
        existing = accounts.find_by_email(conn, identity.email)
        if existing is None:
            return "new_account", None, identity.email
        return (*(self._link_blocker(existing) or ("link_required", None)), identity.email)

    @staticmethod
    def _link_blocker(user: dict) -> tuple[str, str] | None:
        if user["platform_agent_of_id"] is not None:
            return "unavailable", "account_unavailable"
        if user["otp_required_for_login"]:
            return "unavailable", "otp_required"
        if user["locked"] or user["failed_attempts"] >= accounts.MAXIMUM_ATTEMPTS:
            return "unavailable", "locked"
        if user["google_uid"]:
            return "unavailable", "google_other_account"
        return None

    # -- app-side calls (need the verifier) --------------------------------------------------------

    def status(self, flow_id: str, verifier: object) -> dict:
        with self.db.transaction() as conn:
            row = self._load(conn, flow_id, verifier)
        now = self.clock()
        status = row["status"]
        if status in ("started", "verified") and row["expires_at"] <= now:
            status = "expired"
        body: dict = {"status": status, "expires_at": row["expires_at"].isoformat()}
        if status in ("verified", "completed"):
            body.update(outcome=row["outcome"], email=row["email"])
        if row["failure"] and status in ("failed", "verified", "cancelled"):
            body["failure"] = row["failure"]
        return body

    def _ready(self, row: dict, outcome: str) -> None:
        if row["status"] != "verified" or row["expires_at"] <= self.clock():
            raise ApiError(409, "flow_not_ready", flow_status="expired" if row["status"] == "verified" else row["status"])
        if row["outcome"] != outcome:
            raise ApiError(409, "flow_not_ready", outcome=row["outcome"])

    def complete(self, flow_id: str, verifier: object, password: object, password_confirmation: object,
                 usage_region: object, nickname: object) -> dict:
        if not self.settings.registration_enabled:
            raise ApiError(403, "registration_closed")
        password_text = password if isinstance(password, str) else ""
        errors = password_errors(password_text, password_confirmation if isinstance(password_confirmation, str) else "")
        nick, region, profile_errors = validate_profile(nickname, usage_region)
        errors.update(profile_errors)
        with self.db.transaction() as conn:  # verify the flow before spending a bcrypt hash or an HIBP call
            self._ready(self._load(conn, flow_id, verifier), "new_account")
        if errors:
            raise invalid(errors)
        if self.pwned.is_pwned(password_text):
            raise invalid({"password": ["pwned"]})
        encrypted = hash_password(password_text, self.settings.bcrypt_cost)
        failure: ApiError | None = None
        with self.db.transaction() as conn:
            row = self._load(conn, flow_id, verifier)
            self._ready(row, "new_account")
            now = self.clock()
            try:
                created = accounts.create_account(conn, email=row["email"], encrypted_password=encrypted, usage_region=region,
                                                  nickname=nick, locale=row["locale"], google_uid=row["provider_uid"])
            except (accounts.EmailTaken, accounts.GoogleIdentityTaken) as error:
                code = "email_taken" if isinstance(error, accounts.EmailTaken) else "google_taken"
                conn.execute("UPDATE identity.oauth_flows SET status = 'failed', failure = %s, updated_at = %s WHERE id = %s", (code, now, row["id"]))
                failure = ApiError(409, code)
            else:
                # Google asserted email_verified for this exact address (checked in the callback).
                accounts.record_email_verified(conn, created.user_id, created.email, "google")
                conn.execute("UPDATE identity.oauth_flows SET status = 'completed', user_id = %s, updated_at = %s WHERE id = %s", (created.user_id, now, row["id"]))
        if failure:
            raise failure
        return {"status": "created", "email": created.email}

    def link(self, flow_id: str, verifier: object, password: object) -> dict:
        password_text = password if isinstance(password, str) else ""
        failure: ApiError | None = None
        with self.db.transaction() as conn:
            row = self._load(conn, flow_id, verifier)
            self._ready(row, "link_required")
            now = self.clock()
            if row["link_attempts"] >= MAX_LINK_ATTEMPTS:
                raise ApiError(429, "too_many_attempts")
            user = accounts.find_by_email(conn, row["email"], lock=True)
            blocker = ("unavailable", "account_unavailable") if user is None else self._link_blocker(user)
            if blocker:
                conn.execute("UPDATE identity.oauth_flows SET status = 'failed', failure = %s, updated_at = %s WHERE id = %s", (blocker[1], now, row["id"]))
                failure = ApiError(409, blocker[1])
            elif not password_text or not verify_password(password_text, user["encrypted_password"]):
                attempts = row["link_attempts"] + 1
                total = accounts.record_failed_password(conn, user["id"])
                exhausted = attempts >= MAX_LINK_ATTEMPTS or total >= accounts.MAXIMUM_ATTEMPTS
                conn.execute("UPDATE identity.oauth_flows SET link_attempts = %s, status = %s, failure = %s, updated_at = %s WHERE id = %s",
                             (attempts, "failed" if exhausted else "verified", "too_many_attempts" if exhausted else None, now, row["id"]))
                failure = ApiError(429, "too_many_attempts") if exhausted else ApiError(422, "invalid_password", attempts_remaining=MAX_LINK_ATTEMPTS - attempts)
            elif not accounts.link_google(conn, user["id"], row["provider_uid"]):
                conn.execute("UPDATE identity.oauth_flows SET status = 'failed', failure = 'google_other_account', updated_at = %s WHERE id = %s", (now, row["id"]))
                failure = ApiError(409, "google_other_account")
            else:
                # Password (account) + Google email_verified for the same address (mailbox): an
                # account created unverified during the testing bypass becomes verified only here.
                accounts.record_email_verified(conn, user["id"], row["email"], "google")
                conn.execute("UPDATE identity.oauth_flows SET status = 'completed', user_id = %s, updated_at = %s WHERE id = %s", (user["id"], now, row["id"]))
        if failure:
            raise failure
        return {"status": "linked", "email": row["email"]}

    def cancel(self, flow_id: str, verifier: object) -> None:
        with self.db.transaction() as conn:
            row = self._load(conn, flow_id, verifier)
            if row["status"] in ("started", "verified"):
                conn.execute("UPDATE identity.oauth_flows SET status = 'cancelled', failure = 'cancelled', provider_verifier = '', updated_at = %s WHERE id = %s",
                             (self.clock(), row["id"]))


# --- the page shown in the system browser after Google ---------------------------------------

_PAGES = {
    "en": {"done": ("You're verified", "Return to the BillieWeather app to finish. You can close this tab."),
           "cancelled": ("Google sign-up cancelled", "Nothing was created. Return to BillieWeather to try again."),
           "failed": ("Google sign-up didn't work", "Return to BillieWeather and try again, or sign up with email."),
           "expired": ("This link has expired", "Start again from the BillieWeather app."), "open": "Open BillieWeather"},
    "zh-CN": {"done": ("验证完成", "请返回 BillieWeather 应用完成注册。你可以关闭此页面。"),
              "cancelled": ("已取消 Google 注册", "没有创建任何内容。返回 BillieWeather 重试。"),
              "failed": ("Google 注册未成功", "请返回 BillieWeather 重试，或使用邮箱注册。"),
              "expired": ("此链接已过期", "请在 BillieWeather 应用中重新开始。"), "open": "打开 BillieWeather"},
    "zh-TW": {"done": ("驗證完成", "請返回 BillieWeather 應用程式完成註冊。你可以關閉此頁面。"),
              "cancelled": ("已取消 Google 註冊", "沒有建立任何內容。返回 BillieWeather 重試。"),
              "failed": ("Google 註冊未成功", "請返回 BillieWeather 重試，或使用電子信箱註冊。"),
              "expired": ("此連結已過期", "請在 BillieWeather 應用程式中重新開始。"), "open": "開啟 BillieWeather"},
    "ja": {"done": ("確認が完了しました", "BillieWeather アプリに戻って完了してください。このタブは閉じてかまいません。"),
           "cancelled": ("Google での登録をキャンセルしました", "何も作成されていません。BillieWeather に戻ってやり直してください。"),
           "failed": ("Google での登録に失敗しました", "BillieWeather に戻ってやり直すか、メールで登録してください。"),
           "expired": ("このリンクは期限切れです", "BillieWeather アプリからもう一度始めてください。"), "open": "BillieWeather を開く"},
    "ko": {"done": ("인증되었습니다", "BillieWeather 앱으로 돌아가 완료하세요. 이 탭은 닫아도 됩니다."),
           "cancelled": ("Google 가입이 취소되었습니다", "아무것도 만들어지지 않았습니다. BillieWeather로 돌아가 다시 시도하세요."),
           "failed": ("Google 가입에 실패했습니다", "BillieWeather로 돌아가 다시 시도하거나 이메일로 가입하세요."),
           "expired": ("링크가 만료되었습니다", "BillieWeather 앱에서 다시 시작하세요."), "open": "BillieWeather 열기"},
    "es": {"done": ("Verificación completada", "Vuelve a la aplicación BillieWeather para terminar. Puedes cerrar esta pestaña."),
           "cancelled": ("Registro con Google cancelado", "No se creó nada. Vuelve a BillieWeather para intentarlo de nuevo."),
           "failed": ("El registro con Google no funcionó", "Vuelve a BillieWeather e inténtalo de nuevo, o regístrate con tu correo."),
           "expired": ("Este enlace ha caducado", "Empieza de nuevo desde la aplicación BillieWeather."), "open": "Abrir BillieWeather"},
}


def callback_page(page: str, locale: str | None) -> str:
    copy = _PAGES.get(locale or "en", _PAGES["en"])
    title, body = copy.get(page, copy["failed"])
    lang = json.dumps(locale or "en")[1:-1]
    return f"""<!doctype html><html lang="{html.escape(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} · BillieWeather</title><style>body{{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f5f1;color:#1d1d1b;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}}main{{max-width:420px;background:#fff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}h1{{font-size:1.4rem;margin:0 0 12px}}p{{color:#5c5c57;line-height:1.5}}a{{display:inline-block;margin-top:12px;background:#1d1d1b;color:#fff;border-radius:999px;padding:10px 18px;text-decoration:none}}</style></head>
<body><main><h1>{html.escape(title)}</h1><p>{html.escape(body)}</p><a href="billieweather://open">{html.escape(copy["open"])}</a></main></body></html>"""
