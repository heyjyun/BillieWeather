"""Email/password registration with an emailed verification code.

Lifecycle:
  1. register  -> a pending registration (identity schema). An 8-digit code is emailed, and the
                  app receives a registration secret. No Rails user exists yet, so an unconfirmed
                  address can never sign in.
  2. confirm   -> secret + code. In one transaction: users + teams + memberships rows (exactly
                  as the website's sign-up), then the app signs in through the existing Rails
                  /api/client/v1/session endpoint.
  3. resend    -> a new code (spaced and capped).

Security properties:
- Confirming needs BOTH the emailed code and the secret held by the app that registered, so a
  third party who starts a sign-up for someone else's address cannot finish it with a link
  that the owner clicks, and the owner cannot be tricked into confirming the attacker's password.
- Responses are identical whether or not the address already has an account (the existing owner
  receives a notice email instead of a code), so sign-up cannot be used to discover accounts.
- Only HMAC digests of secrets and codes are stored; attempts are limited per registration and
  per address; the password hash is erased once the registration ends.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from . import accounts, mailer, tokens
from .db import Database
from .errors import ApiError, invalid
from .passwords import PwnedChecker, hash_password
from .validation import email_errors, normalize_email, normalize_locale, password_errors, validate_profile

CODE_TTL = timedelta(minutes=30)
REGISTRATION_TTL = timedelta(hours=24)
RESEND_INTERVAL = timedelta(seconds=60)
MAX_SENDS = 5
MAX_CODE_ATTEMPTS = 5
MAX_PENDING_PER_EMAIL_PER_HOUR = 5
MAX_FAILED_CODES_PER_EMAIL_PER_DAY = 20


def utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class RegistrationInput:
    email: object
    password: object
    password_confirmation: object
    usage_region: object
    nickname: object = None
    locale: object = None


class RegistrationService:
    def __init__(self, db: Database, settings, mail: mailer.Mailer, pwned: PwnedChecker, clock=utcnow):  # noqa: ANN001
        self.db = db
        self.settings = settings
        self.mail = mail
        self.pwned = pwned
        self.clock = clock

    # -- helpers -----------------------------------------------------------------------------

    def _key(self) -> bytes:
        return self.settings.hmac_key

    def _code_digest(self, registration_id: str, code: str) -> str:
        return tokens.digest(self._key(), "signup-code", f"{registration_id}:{code}")

    def _load(self, conn, registration_id: str, secret: object) -> dict:  # noqa: ANN001
        try:
            uuid.UUID(str(registration_id))
        except ValueError:
            raise ApiError(404, "not_found") from None
        row = conn.execute("SELECT * FROM identity.pending_registrations WHERE id = %s FOR UPDATE", (registration_id,)).fetchone()
        if row is None or not isinstance(secret, str) or not tokens.matches(row["secret_digest"], self._key(), "signup-secret", secret):
            raise ApiError(404, "not_found")
        return row

    def _message(self, row: dict, code: str) -> mailer.Message:
        if row["existing_account"]:
            return mailer.existing_account_message(row["email"], row["locale"])
        return mailer.code_message(row["email"], code, int(CODE_TTL.total_seconds() // 60), row["locale"])

    def _deliver(self, row: dict, code: str) -> None:
        try:
            self.mail.send(self._message(row, code))
        except mailer.MailError:
            raise ApiError(503, "mail_unavailable") from None

    # -- 1. register -------------------------------------------------------------------------

    def validate(self, data: RegistrationInput) -> tuple[str, str, str | None, str, str | None]:
        email = normalize_email(data.email)
        password = data.password if isinstance(data.password, str) else ""
        confirmation = data.password_confirmation if isinstance(data.password_confirmation, str) else ""
        errors: dict[str, list[str]] = {}
        if problems := email_errors(email):
            errors["email"] = problems
        errors.update(password_errors(password, confirmation))
        nickname, region, profile_errors = validate_profile(data.nickname, data.usage_region)
        errors.update(profile_errors)
        if errors:
            raise invalid(errors)
        return email, password, nickname, region, normalize_locale(data.locale)

    def register(self, data: RegistrationInput) -> dict:
        if not self.settings.registration_enabled:
            raise ApiError(403, "registration_closed")
        email, password, nickname, region, locale = self.validate(data)
        if self.pwned.is_pwned(password):
            raise invalid({"password": ["pwned"]})
        # Hash before looking at the database: the work is the same whether or not the address is taken.
        encrypted = hash_password(password, self.settings.bcrypt_cost)
        now = self.clock()
        registration_id = str(uuid.uuid4())
        secret, code = tokens.new_secret(), tokens.new_code()
        with self.db.transaction() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('identity-signup:' || %s))", (email,))
            recent = conn.execute(
                "SELECT count(*) AS n FROM identity.pending_registrations WHERE email = %s AND created_at > %s",
                (email, now - timedelta(hours=1)),
            ).fetchone()["n"]
            if recent >= MAX_PENDING_PER_EMAIL_PER_HOUR:
                raise ApiError(429, "rate_limited", retry_after=3600)
            existing = accounts.email_exists(conn, email)
            row = conn.execute(
                "INSERT INTO identity.pending_registrations (id, email, encrypted_password, nickname, usage_region, locale, existing_account, "
                "secret_digest, code_digest, code_expires_at, last_sent_at, expires_at, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
                (registration_id, email, "" if existing else encrypted, nickname, region, locale, existing,
                 tokens.digest(self._key(), "signup-secret", secret),
                 # An existing address gets an unguessable digest: no code can ever match it.
                 self._code_digest(registration_id, tokens.new_secret() if existing else code),
                 now + CODE_TTL, now, now + REGISTRATION_TTL, now, now),
            ).fetchone()
        try:
            self._deliver(row, code)
        except ApiError:
            with self.db.transaction() as conn:
                conn.execute("UPDATE identity.pending_registrations SET status = 'failed', encrypted_password = '', updated_at = %s WHERE id = %s", (now, registration_id))
            raise
        return {
            "registration_id": registration_id,
            "registration_secret": secret,
            "email": email,
            "code_length": tokens.CODE_DIGITS,
            "code_expires_at": (now + CODE_TTL).isoformat(),
            "resend_available_at": (now + RESEND_INTERVAL).isoformat(),
            "expires_at": (now + REGISTRATION_TTL).isoformat(),
        }

    # -- 2. confirm --------------------------------------------------------------------------

    def confirm(self, registration_id: str, secret: object, code: object) -> dict:
        code_text = tokens.normalize_code(code)
        if not code_text.isdigit() or len(code_text) != tokens.CODE_DIGITS:
            raise invalid({"code": ["invalid"]})
        now = self.clock()
        failure: ApiError | None = None
        result: dict | None = None
        with self.db.transaction() as conn:
            row = self._load(conn, registration_id, secret)
            if row["status"] == "confirmed":
                return {"status": "confirmed", "email": row["email"]}
            if row["status"] != "pending" or row["expires_at"] <= now:
                raise ApiError(410, "registration_expired")
            if row["code_attempts"] >= MAX_CODE_ATTEMPTS:
                raise ApiError(429, "too_many_attempts")
            failed_today = conn.execute(
                "SELECT coalesce(sum(code_attempts), 0) AS n FROM identity.pending_registrations WHERE email = %s AND created_at > %s",
                (row["email"], now - timedelta(days=1)),
            ).fetchone()["n"]
            if failed_today >= MAX_FAILED_CODES_PER_EMAIL_PER_DAY:
                raise ApiError(429, "too_many_attempts")
            if row["code_expires_at"] <= now:
                raise ApiError(410, "code_expired")
            if row["existing_account"] or not tokens.matches(row["code_digest"], self._key(), "signup-code", f"{row['id']}:{code_text}"):
                attempts = row["code_attempts"] + 1
                exhausted = attempts >= MAX_CODE_ATTEMPTS
                conn.execute(
                    "UPDATE identity.pending_registrations SET code_attempts = %s, status = %s, "
                    "encrypted_password = CASE WHEN %s THEN '' ELSE encrypted_password END, updated_at = %s WHERE id = %s",
                    (attempts, "failed" if exhausted else "pending", exhausted, now, row["id"]),
                )
                failure = ApiError(429, "too_many_attempts") if exhausted else ApiError(422, "invalid_code", attempts_remaining=MAX_CODE_ATTEMPTS - attempts)
            else:
                try:
                    created = accounts.create_account(
                        conn, email=row["email"], encrypted_password=row["encrypted_password"], usage_region=row["usage_region"],
                        nickname=row["nickname"], locale=row["locale"],
                    )
                except accounts.EmailTaken:
                    conn.execute("UPDATE identity.pending_registrations SET status = 'failed', encrypted_password = '', updated_at = %s WHERE id = %s", (now, row["id"]))
                    failure = ApiError(409, "email_taken")
                else:
                    conn.execute(
                        "UPDATE identity.pending_registrations SET status = 'confirmed', user_id = %s, encrypted_password = '', updated_at = %s WHERE id = %s",
                        (created.user_id, now, row["id"]),
                    )
                    conn.execute(
                        "UPDATE identity.pending_registrations SET status = 'superseded', encrypted_password = '', updated_at = %s "
                        "WHERE email = %s AND status = 'pending' AND id <> %s",
                        (now, row["email"], row["id"]),
                    )
                    result = {"status": "confirmed", "email": created.email}
        if failure:  # raised after commit, so the attempt counter is saved
            raise failure
        assert result is not None
        return result

    # -- 3. resend ---------------------------------------------------------------------------

    def resend(self, registration_id: str, secret: object) -> dict:
        now = self.clock()
        code = tokens.new_code()
        with self.db.transaction() as conn:
            row = self._load(conn, registration_id, secret)
            if row["status"] == "confirmed":
                raise ApiError(409, "already_confirmed")
            if row["status"] != "pending" or row["expires_at"] <= now:
                raise ApiError(410, "registration_expired")
            if row["send_count"] >= MAX_SENDS:
                raise ApiError(429, "resend_limit")
            available = row["last_sent_at"] + RESEND_INTERVAL
            if available > now:
                raise ApiError(429, "resend_too_soon", retry_after=max(1, int((available - now).total_seconds() + 0.999)))
            row = conn.execute(
                "UPDATE identity.pending_registrations SET code_digest = %s, code_expires_at = %s, send_count = send_count + 1, "
                "last_sent_at = %s, updated_at = %s WHERE id = %s RETURNING *",
                (self._code_digest(row["id"], tokens.new_secret() if row["existing_account"] else code), now + CODE_TTL, now, now, row["id"]),
            ).fetchone()
        self._deliver(row, code)
        return {
            "code_expires_at": (now + CODE_TTL).isoformat(),
            "resend_available_at": (now + RESEND_INTERVAL).isoformat(),
            "resends_remaining": MAX_SENDS - row["send_count"],
        }

    # -- maintenance -------------------------------------------------------------------------

    def purge(self) -> int:
        """Deletes finished or expired registrations older than 7 days; erases expired password hashes now."""
        now = self.clock()
        with self.db.transaction() as conn:
            conn.execute("UPDATE identity.pending_registrations SET encrypted_password = '' WHERE expires_at <= %s AND encrypted_password <> ''", (now,))
            deleted = conn.execute("DELETE FROM identity.pending_registrations WHERE expires_at <= %s", (now - timedelta(days=7),)).rowcount
            deleted += conn.execute("DELETE FROM identity.oauth_flows WHERE expires_at <= %s", (now - timedelta(days=1),)).rowcount
        return deleted
