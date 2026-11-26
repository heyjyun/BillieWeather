"""EMAIL_VERIFICATION_REQUIRED=false (temporary testing bypass) and switching it back on.

The account is created immediately and signs in like any other, but its address is recorded as
UNVERIFIED (identity.email_verifications). Only Google (email_verified) or the emailed code can
make it verified. Non-production environments can limit immediate signup to specific test addresses.
"""
from __future__ import annotations

import logging

import httpx
import pytest

from conftest import VALID, code_from
from identity_api import accounts
from identity_api.config import Settings
from identity_api.google import GoogleClient
from identity_api.passwords import verify_password
from test_google import CLIENT_ID, AppFlow, FakeGoogle, existing_user, signed_in_to_google

BYPASS = {"email_verification_required": False}
JYUN = {**VALID, "email": "Jyun.Test@Example.org", "nickname": "Jyun", "locale": "en", "usage_region": "XG"}


def register(client, **changes):
    return client.post("/v1/registrations", json={**JYUN, **changes})


def users(sql):
    return sql.execute("SELECT * FROM public.users ORDER BY id").fetchall()


def verification(sql, user_id):
    return sql.execute("SELECT status, method, verified_at IS NOT NULL AS has_time FROM identity.email_verifications WHERE user_id = %s", (user_id,)).fetchone()


@pytest.fixture
def bypass(make_client):
    return make_client(**BYPASS)


# Creating an account without email verification ---------------------------------------------

def test_account_is_created_immediately_without_email_or_pending_state(bypass, mail, sql, caplog):
    caplog.set_level(logging.INFO, logger="identity_api")
    response = register(bypass)
    assert response.status_code == 201, response.text
    assert response.json() == {"status": "created", "email": "jyun.test@example.org", "nickname": "Jyun", "email_verified": False}
    assert mail.sent == []  # nothing is emailed in this mode
    assert sql.execute("SELECT count(*) AS n FROM identity.pending_registrations").fetchone()["n"] == 0  # cannot get stuck pending

    [user] = users(sql)
    assert (user["email"], user["nickname"], user["usage_region"], user["locale"]) == ("jyun.test@example.org", "Jyun", "XG", "en")
    # Secure password handling: Devise-compatible bcrypt, never the plain text.
    assert user["encrypted_password"].startswith("$2a$04$") and verify_password("a unique passphrase", user["encrypted_password"])
    assert "a unique passphrase" not in response.text and "a unique passphrase" not in caplog.text
    # The same complete account the website creates (team + admin membership).
    [team] = sql.execute("SELECT * FROM public.teams").fetchall()
    assert user["current_team_id"] == team["id"]
    assert sql.execute("SELECT role_ids FROM public.memberships WHERE user_id = %s", (user["id"],)).fetchone()["role_ids"] == ["admin"]
    # Authenticated account != verified address.
    assert verification(sql, user["id"]) == {"status": "unverified", "method": None, "has_time": False}
    assert "signup_unverified_email" in caplog.text


def test_nickname_is_still_required(bypass, sql):
    for blank in ("", "   ", None):
        response = register(bypass, nickname=blank)
        assert response.status_code == 422 and response.json()["fields"] == {"nickname": ["blank"]}
    assert users(sql) == []


def test_other_validation_and_breached_passwords_still_apply(bypass, pwned_list, sql):
    response = register(bypass, email="not-an-email", password="abc", password_confirmation="abd", usage_region="ZZ")
    assert response.status_code == 422
    assert set(response.json()["fields"]) == {"email", "password", "password_confirmation", "usage_region"}
    pwned_list.add("password123")
    assert register(bypass, password="password123", password_confirmation="password123").json() == {"error": "invalid", "fields": {"password": ["pwned"]}}
    assert users(sql) == []


def test_duplicate_email_is_refused_and_the_existing_account_is_untouched(bypass, mail, sql):
    assert register(bypass).status_code == 201
    [before] = users(sql)
    again = register(bypass, email="  JYUN.test@example.ORG ", password="another passphrase", password_confirmation="another passphrase", nickname="Other")
    assert again.status_code == 409 and again.json() == {"error": "email_taken"}
    [after] = users(sql)
    assert after == before and verify_password("a unique passphrase", after["encrypted_password"])
    assert sql.execute("SELECT count(*) AS n FROM public.teams").fetchone()["n"] == 1  # the failed attempt left nothing behind
    assert mail.sent == []


def test_website_accounts_count_as_duplicates(bypass, sql):
    existing_user(sql, email="jyun.test@example.org")
    assert register(bypass).json() == {"error": "email_taken"}
    assert sql.execute("SELECT count(*) AS n FROM identity.email_verifications").fetchone()["n"] == 0


def test_abuse_limits_still_apply(bypass):
    statuses = [register(bypass, email=f"tester{i}@example.org").status_code for i in range(11)]
    assert statuses[:10] == [201] * 10 and statuses[10] == 429  # register_ip: 10 per 10 minutes


def test_config_reports_the_mode(make_client):
    assert make_client().get("/v1/config").json()["email_verification"] == "required"
    assert make_client(**BYPASS).get("/v1/config").json()["email_verification"] == "disabled"
    allow = make_client(**BYPASS, email_verification_bypass_emails="tester@example.org").get("/v1/config").json()
    assert allow["email_verification"] == "allowlist" and "tester@example.org" not in str(allow)  # never published


# Re-enabling email verification -------------------------------------------------------------

def test_flag_on_restores_the_code_flow_and_records_a_verified_address(client, mail, sql):
    started = register(client)
    assert started.status_code == 202 and "registration_secret" in started.json()
    assert users(sql) == [] and len(mail.sent) == 1
    confirmed = client.post(f"/v1/registrations/{started.json()['registration_id']}/confirmation",
                            json={"registration_secret": started.json()["registration_secret"], "code": code_from(mail)})
    assert confirmed.status_code == 201
    [user] = users(sql)
    assert verification(sql, user["id"]) == {"status": "verified", "method": "email_code", "has_time": True}


def test_legacy_pending_sign_up_ends_when_the_bypass_creates_the_account(make_client, mail, sql):
    normal = make_client()
    started = register(normal).json()
    code = code_from(mail)
    assert register(make_client(**BYPASS)).status_code == 201
    pending = sql.execute("SELECT status, encrypted_password FROM identity.pending_registrations").fetchone()
    assert pending == {"status": "superseded", "encrypted_password": ""}
    late = normal.post(f"/v1/registrations/{started['registration_id']}/confirmation", json={"registration_secret": started["registration_secret"], "code": code})
    assert late.status_code == 410 and late.json() == {"error": "registration_expired"}
    assert normal.post(f"/v1/registrations/{started['registration_id']}/resend", json={"registration_secret": started["registration_secret"]}).status_code == 410
    assert len(users(sql)) == 1


def test_expired_legacy_session_does_not_block_a_fresh_registration(make_client, mail, clock, sql):
    normal = make_client()
    started = register(normal).json()
    clock.advance(hours=25)
    expired = normal.post(f"/v1/registrations/{started['registration_id']}/confirmation",
                          json={"registration_secret": started["registration_secret"], "code": code_from(mail)})
    assert expired.status_code == 410 and expired.json() == {"error": "registration_expired"}
    assert register(make_client(**BYPASS)).status_code == 201
    assert len(users(sql)) == 1


# Limited to controlled environments / authorized test users ---------------------------------

def test_allowlist_limits_who_skips_verification(make_client, mail, sql):
    client = make_client(**BYPASS, email_verification_bypass_emails=" Jyun.Test@example.org , @qa.example.org")
    assert register(client).status_code == 201
    assert register(client, email="someone@qa.example.org").status_code == 201
    other = register(client, email="stranger@example.com")
    assert other.status_code == 202 and [m.to for m in mail.sent] == ["stranger@example.com"]  # verifies by email as usual
    assert register(client, email="x@sub.qa.example.org").status_code == 202  # exact domain only
    assert {u["email"] for u in users(sql)} == {"jyun.test@example.org", "someone@qa.example.org"}


def test_development_default_creates_an_unverified_account_without_google_or_mail(make_client, mail, sql):
    client = make_client(identity_env="development", google_client_id="", google_client_secret="")
    response = register(client, email="mainland@example.org", usage_region="CN", locale="zh-CN")
    assert response.status_code == 201 and response.json()["email_verified"] is False
    [user] = users(sql)
    assert verification(sql, user["id"])["status"] == "unverified"
    assert mail.sent == []


def test_production_requires_verification_even_with_an_allowlist():
    base = dict(identity_env="production", database_url="postgresql://x/y", public_url="https://id.example.org", token_hmac_key="k" * 40,
                cors_allowed_origins="tauri://localhost", mail_delivery="postmark", postmark_api_token="t", mail_from="BW <a@example.org>")
    default = Settings(**base)
    default.validate_for_runtime()
    assert default.email_verification_mode == "required"
    for allowlist in ("", "tester@example.org"):
        settings = Settings(**base, email_verification_required=False, email_verification_bypass_emails=allowlist)
        with pytest.raises(RuntimeError, match="EMAIL_VERIFICATION_REQUIRED=false"):
            settings.validate_for_runtime()
        assert not settings.skips_email_verification("tester@example.org")


def test_flag_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("EMAIL_VERIFICATION_REQUIRED", "false")
    monkeypatch.setenv("EMAIL_VERIFICATION_BYPASS_EMAILS", "a@example.org")
    settings = Settings(database_url="postgresql://x/y", _env_file=None)
    assert settings.email_verification_mode == "allowlist" and settings.skips_email_verification("a@example.org")
    monkeypatch.delenv("EMAIL_VERIFICATION_REQUIRED")
    monkeypatch.delenv("EMAIL_VERIFICATION_BYPASS_EMAILS")
    assert Settings(identity_env="development", database_url="postgresql://x/y", _env_file=None).email_verification_mode == "disabled"
    assert Settings(identity_env="test", database_url="postgresql://x/y", _env_file=None).email_verification_mode == "required"


# Accounts without verified email ownership --------------------------------------------------

@pytest.fixture
def google():
    return FakeGoogle()


@pytest.fixture
def gbypass(make_client, settings, google):
    client = GoogleClient(CLIENT_ID, "google-secret", settings.google_redirect_uri, http=httpx.Client(transport=httpx.MockTransport(google.handler)))
    return make_client(google_client=client, **BYPASS)


def test_linking_google_needs_the_password_and_then_proves_the_address(gbypass, google, sql):
    assert register(gbypass, email="person@gmail.com").status_code == 201
    [user] = users(sql)
    flow = AppFlow(gbypass)
    signed_in_to_google(google, flow)
    # Owning the Google mailbox alone never takes over an unverified account: its password is required.
    assert flow.post("status").json()["outcome"] == "link_required"
    assert flow.post("link", password="guess").status_code == 422
    assert verification(sql, user["id"])["status"] == "unverified"
    assert flow.post("link", password="a unique passphrase").status_code == 200
    assert verification(sql, user["id"]) == {"status": "verified", "method": "google", "has_time": True}


def test_google_sign_up_is_verified_even_while_the_bypass_is_on(gbypass, google, sql):
    flow = AppFlow(gbypass)
    signed_in_to_google(google, flow)
    assert flow.post("complete", password="app passphrase", password_confirmation="app passphrase", usage_region="XG", nickname="Jyun").status_code == 201
    [user] = users(sql)
    assert verification(sql, user["id"]) == {"status": "verified", "method": "google", "has_time": True}


def test_unverified_record_is_never_upgraded_for_a_different_address(db, sql):
    existing_user(sql, email="owner@example.org")
    user_id = sql.execute("SELECT id FROM public.users").fetchone()["id"]
    with db.transaction() as conn:
        accounts.record_email_unverified(conn, user_id, "owner@example.org")
        accounts.record_email_verified(conn, user_id, "someone.else@example.org", "google")
        assert accounts.email_verification_status(conn, user_id) == "unverified"
        accounts.record_email_verified(conn, user_id, "owner@example.org", "email_code")
        assert accounts.email_verification_status(conn, user_id) == "verified"
        accounts.record_email_unverified(conn, user_id, "owner@example.org")  # never downgrades
        assert accounts.email_verification_status(conn, user_id) == "verified"
