"""Reads and writes of the Rails-owned account tables (public.users, teams, memberships).

`create_account` reproduces what the website's sign-up does in one transaction:
  User.create!(email, password, nickname, usage_region)  -> users row (finance_owner_uid from the DB default)
  user.create_default_team                                -> teams "Your Team" + admin membership + current_team_id
Column values match a row produced by Rails itself (see tests/test_compat.py). Timestamps are
UTC without time zone, as ActiveRecord stores them.
"""
from __future__ import annotations

from dataclasses import dataclass

import psycopg

DEFAULT_TEAM_NAME = "Your Team"  # I18n teams.new.default_team_name (en; the only translation Bullet Train ships)
ADMIN_ROLE_ID = "admin"  # Role.admin.id
MAXIMUM_ATTEMPTS = 20  # Devise config.maximum_attempts
UNLOCK_IN_SECONDS = 3600  # Devise config.unlock_in
UTC_NOW = "timezone('utc', now())"


class EmailTaken(Exception):
    pass


class GoogleIdentityTaken(Exception):
    pass


@dataclass(frozen=True)
class CreatedAccount:
    user_id: int
    owner_id: str
    email: str


def find_by_email(conn: psycopg.Connection, email: str, *, lock: bool = False) -> dict | None:
    # Devise downcases on save; lower() also covers any legacy mixed-case row.
    sql = (
        "SELECT id, email, encrypted_password, google_uid, otp_required_for_login, locked_at, failed_attempts, "
        "platform_agent_of_id, (locked_at IS NOT NULL AND locked_at > " + UTC_NOW + " - make_interval(secs => %s)) AS locked "
        "FROM public.users WHERE lower(email) = %s ORDER BY id LIMIT 1" + (" FOR UPDATE" if lock else "")
    )
    return conn.execute(sql, (UNLOCK_IN_SECONDS, email)).fetchone()


def find_by_google_uid(conn: psycopg.Connection, uid: str) -> dict | None:
    return conn.execute("SELECT id, email FROM public.users WHERE google_uid = %s", (uid,)).fetchone()


def email_exists(conn: psycopg.Connection, email: str) -> bool:
    return conn.execute("SELECT 1 FROM public.users WHERE lower(email) = %s", (email,)).fetchone() is not None


def create_account(
    conn: psycopg.Connection,
    *,
    email: str,
    encrypted_password: str,
    usage_region: str,
    nickname: str | None,
    locale: str | None,
    google_uid: str | None = None,
) -> CreatedAccount:
    """Must run inside a transaction; raises EmailTaken / GoogleIdentityTaken on a unique conflict."""
    try:
        with conn.transaction():  # savepoint: a unique violation leaves the outer transaction usable
            user = conn.execute(
                "INSERT INTO public.users (email, encrypted_password, nickname, usage_region, usage_region_pending, locale, "
                "google_uid, ability_cache, created_at, updated_at) "
                f"VALUES (%s, %s, %s, %s, false, %s, %s, '{{}}'::jsonb, {UTC_NOW}, {UTC_NOW}) "
                "RETURNING id, finance_owner_uid",
                (email, encrypted_password, nickname, usage_region, locale, google_uid),
            ).fetchone()
    except psycopg.errors.UniqueViolation as error:
        constraint = getattr(error.diag, "constraint_name", "") or ""
        if "google_uid" in constraint:
            raise GoogleIdentityTaken from None
        raise EmailTaken from None
    team = conn.execute(
        f"INSERT INTO public.teams (name, time_zone, created_at, updated_at) VALUES (%s, NULL, {UTC_NOW}, {UTC_NOW}) RETURNING id",
        (DEFAULT_TEAM_NAME,),
    ).fetchone()
    conn.execute(
        "INSERT INTO public.memberships (user_id, team_id, user_email, role_ids, created_at, updated_at) "
        f"VALUES (%s, %s, %s, %s::jsonb, {UTC_NOW}, {UTC_NOW})",
        (user["id"], team["id"], email, f'["{ADMIN_ROLE_ID}"]'),
    )
    conn.execute(f"UPDATE public.users SET current_team_id = %s, updated_at = {UTC_NOW} WHERE id = %s", (team["id"], user["id"]))
    return CreatedAccount(user_id=user["id"], owner_id=str(user["finance_owner_uid"]), email=email)


def record_email_unverified(conn: psycopg.Connection, user_id: int, email: str) -> None:
    """The account exists but nobody proved the address belongs to its owner (testing bypass)."""
    conn.execute(
        "INSERT INTO identity.email_verifications (user_id, email, status) VALUES (%s, %s, 'unverified') "
        "ON CONFLICT (user_id) DO NOTHING",
        (user_id, email),
    )


def record_email_verified(conn: psycopg.Connection, user_id: int, email: str, method: str) -> None:
    """Ownership of `email` was proven (`email_code` or `google`). Upgrades an unverified record
    only when the proven address is still the account's address."""
    conn.execute(
        "INSERT INTO identity.email_verifications (user_id, email, status, method, verified_at) VALUES (%s, %s, 'verified', %s, now()) "
        "ON CONFLICT (user_id) DO UPDATE SET status = 'verified', method = EXCLUDED.method, verified_at = EXCLUDED.verified_at, updated_at = now() "
        "WHERE identity.email_verifications.status = 'unverified' AND identity.email_verifications.email = EXCLUDED.email",
        (user_id, email, method),
    )


def email_verification_status(conn: psycopg.Connection, user_id: int) -> str | None:
    row = conn.execute("SELECT status FROM identity.email_verifications WHERE user_id = %s", (user_id,)).fetchone()
    return row["status"] if row else None


def record_failed_password(conn: psycopg.Connection, user_id: int) -> int:
    """Counts toward Devise's lockout like a failed website sign-in. Python never sets locked_at
    itself (it cannot mint Devise's unlock email token); at the limit it refuses further tries and
    Rails locks the account and mails the unlock link on the next website/app attempt."""
    row = conn.execute(
        f"UPDATE public.users SET failed_attempts = failed_attempts + 1, updated_at = {UTC_NOW} WHERE id = %s RETURNING failed_attempts",
        (user_id,),
    ).fetchone()
    return int(row["failed_attempts"])


def link_google(conn: psycopg.Connection, user_id: int, uid: str) -> bool:
    """Same conditions as GoogleSignIn.connect_after_password_sign_in!; returns whether it linked."""
    if conn.execute("SELECT 1 FROM public.users WHERE google_uid = %s AND id <> %s", (uid, user_id)).fetchone():
        return False
    try:
        with conn.transaction():
            row = conn.execute(
                f"UPDATE public.users SET google_uid = %s, failed_attempts = 0, updated_at = {UTC_NOW} "
                "WHERE id = %s AND (google_uid IS NULL OR google_uid = %s) RETURNING id",
                (uid, user_id, uid),
            ).fetchone()
    except psycopg.errors.UniqueViolation:
        return False
    return row is not None
