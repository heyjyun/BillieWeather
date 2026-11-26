"""Environment configuration. Every credential comes from the environment; nothing is hardcoded.

Production refuses to start with unsafe settings (http public URL, wildcard CORS, missing
secrets, development mail delivery) instead of silently running insecurely.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_ORIGINS = "http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", env_file=".env", extra="ignore")

    identity_env: Literal["development", "test", "production"] = "development"

    # The existing BillieWeather Postgres (Neon in production). Python writes only the
    # users/teams/memberships rows of a new account and its own `identity` schema.
    database_url: str = Field(..., repr=False)
    db_pool_max: int = 5
    # Database pinning (read here so values in .env count too). Production: see docs/audits/
    # render-neon-release-runbook.md. Development on the Neon development branch: BILLIE_DB_ENV=development.
    billie_db_env: str = ""
    billie_db_host: str = ""
    billie_db_name: str = ""
    billie_db_target_id: str = ""
    billie_production_db_endpoints: str = ""

    # Public https origin of this service (Google redirect URI and links in emails).
    public_url: str = "http://localhost:8100"

    # Comma-separated origins of the Universal Client (Tauri WebViews and the dev server).
    cors_allowed_origins: str = DEV_ORIGINS

    # HMAC key for verification codes, registration secrets and OAuth state digests (>= 32 bytes).
    token_hmac_key: str = Field("", repr=False)

    # Devise uses bcrypt with 11 stretches outside the Rails test environment.
    bcrypt_cost: int = 11

    # Same policy as Devise's pwned_password module (enabled unless development).
    pwned_check: bool | None = None
    pwned_timeout_seconds: float = 5.0

    # Mirrors the website: when INVITATION_KEYS is set there, set this to false.
    registration_enabled: bool = True

    # TEMPORARY testing switch. true (default) = the normal flow: the account is created only after
    # the emailed code is confirmed. false = eligible sign-ups create the account immediately, send
    # no email, and are recorded as `unverified` in identity.email_verifications (never "verified").
    # Who is eligible while false:
    #   - EMAIL_VERIFICATION_BYPASS_EMAILS set: only those addresses ("@domain" entries match a whole
    #     domain), in every environment; everyone else still verifies by email.
    #   - not set: every address in development/test; production refuses to start (no open,
    #     unverified public registration).
    # Addresses in DEVELOPER_EMAILS (Rails grants them admin by address) are never eligible.
    email_verification_required: bool = True
    email_verification_bypass_emails: str = ""
    # The same variable Rails reads (Bullet Train `developer?`). Set it here too.
    developer_emails: str = ""

    # Email delivery: postmark (production), outbox (writes .json files locally), memory (tests).
    mail_delivery: Literal["postmark", "outbox", "memory"] = "outbox"
    postmark_api_token: str = Field("", repr=False)
    mail_from: str = ""
    mail_outbox_dir: str = "tmp/outbox"

    # Google OAuth "Web application" client; register {PUBLIC_URL}/v1/google/callback.
    google_client_id: str = ""
    google_client_secret: str = Field("", repr=False)

    # Number of reverse proxies in front of the app that append to X-Forwarded-For (Render: 1).
    trusted_proxy_hops: int = 0

    log_level: str = "INFO"

    @field_validator("token_hmac_key")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @property
    def database_target_env(self) -> dict[str, str]:
        return {"BILLIE_DB_ENV": self.billie_db_env, "BILLIE_DB_HOST": self.billie_db_host, "BILLIE_DB_NAME": self.billie_db_name,
                "BILLIE_DB_TARGET_ID": self.billie_db_target_id, "BILLIE_PRODUCTION_DB_ENDPOINTS": self.billie_production_db_endpoints}

    @property
    def production(self) -> bool:
        return self.identity_env == "production"

    @property
    def origins(self) -> list[str]:
        return [origin.strip().rstrip("/") for origin in self.cors_allowed_origins.split(",") if origin.strip()]

    @property
    def public_origin(self) -> str:
        return self.public_url.rstrip("/")

    @property
    def google_redirect_uri(self) -> str:
        return f"{self.public_origin}/v1/google/callback"

    @property
    def google_configured(self) -> bool:
        return bool(self.google_client_id.strip() and self.google_client_secret.strip())

    @property
    def pwned_enabled(self) -> bool:
        if self.pwned_check is not None:
            return self.pwned_check
        return self.identity_env == "production"

    @staticmethod
    def _addresses(value: str) -> frozenset[str]:
        return frozenset(entry.strip().lower() for entry in value.split(",") if entry.strip())

    @property
    def bypass_allowlist(self) -> frozenset[str]:
        return self._addresses(self.email_verification_bypass_emails)

    @property
    def email_verification_mode(self) -> Literal["required", "allowlist", "disabled"]:
        if self.email_verification_required:
            return "required"
        return "allowlist" if self.bypass_allowlist else "disabled"

    def skips_email_verification(self, email: str) -> bool:
        """Whether this (normalized) address may be registered without proving it owns the mailbox."""
        if self.email_verification_required or not email:
            return False
        if email in self._addresses(self.developer_emails):
            return False  # Rails grants admin by address: such an account must prove ownership
        allowlist = self.bypass_allowlist
        if allowlist:
            return email in allowlist or ("@" + email.rpartition("@")[2]) in allowlist
        return not self.production

    @property
    def hmac_key(self) -> bytes:
        if self.token_hmac_key:
            return self.token_hmac_key.encode()
        # Development/test only: a fixed, clearly non-secret key. validate() forbids this in production.
        return b"identity-api-development-key-not-secret-0000"

    def validate_for_runtime(self) -> None:
        problems: list[str] = []
        if self.production:
            if urlparse(self.public_url).scheme != "https":
                problems.append("PUBLIC_URL must be https in production")
            if len(self.token_hmac_key) < 32:
                problems.append("TOKEN_HMAC_KEY must be at least 32 characters in production")
            if any(origin == "*" for origin in self.origins):
                problems.append("CORS_ALLOWED_ORIGINS must list origins explicitly")
            if any("localhost:" in origin and origin.startswith("http://localhost") for origin in self.origins):
                problems.append("CORS_ALLOWED_ORIGINS must not include the localhost dev server in production")
            if self.mail_delivery != "postmark" or not self.postmark_api_token or not self.mail_from:
                problems.append("production needs MAIL_DELIVERY=postmark, POSTMARK_API_TOKEN and MAIL_FROM")
            if self.bcrypt_cost < 11:
                problems.append("BCRYPT_COST must be at least 11 (Devise's production setting)")
            if not self.email_verification_required and not self.bypass_allowlist:
                problems.append("EMAIL_VERIFICATION_REQUIRED=false in production needs EMAIL_VERIFICATION_BYPASS_EMAILS "
                                "(explicitly authorized test addresses); unverified public registration is refused")
        elif self.mail_delivery == "postmark" and (not self.postmark_api_token or not self.mail_from):
            # Development end-to-end testing with real email is opt-in and must be complete.
            problems.append("MAIL_DELIVERY=postmark needs POSTMARK_API_TOKEN and MAIL_FROM")
        if not 4 <= self.bcrypt_cost <= 15:
            problems.append("BCRYPT_COST must be between 4 and 15")
        if problems:
            raise RuntimeError("Unsafe identity-api configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
