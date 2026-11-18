"""Email/password registration: validation, confirmation, resend, limits, enumeration safety."""
from __future__ import annotations

import logging

import pytest

from conftest import VALID, code_from
from identity_api.passwords import verify_password


def register(client, **changes):
    return client.post("/v1/registrations", json={**VALID, **changes})


def confirm(client, started, code):
    return client.post(f"/v1/registrations/{started['registration_id']}/confirmation",
                       json={"registration_secret": started["registration_secret"], "code": code})


def users(sql):
    return sql.execute("SELECT * FROM public.users ORDER BY id").fetchall()


# 1. Successful email registration --------------------------------------------------------------

def test_register_then_confirm_creates_a_complete_rails_account(client, mail, sql):
    response = register(client)
    assert response.status_code == 202
    started = response.json()
    assert started["email"] == "new.person@example.org"
    assert set(started) == {"registration_id", "registration_secret", "email", "code_length", "code_expires_at", "resend_available_at", "expires_at"}
    assert users(sql) == []  # nothing can sign in before the code is confirmed

    assert len(mail.sent) == 1 and mail.sent[0].to == "new.person@example.org" and mail.sent[0].kind == "signup_code"
    assert "確認コード" in mail.sent[0].subject  # the registrant's language (ja)
    pending = sql.execute("SELECT * FROM identity.pending_registrations").fetchone()
    assert started["registration_secret"] not in str(pending.values()) and code_from(mail) not in str(pending.values())

    response = confirm(client, started, code_from(mail)[:4] + "-" + code_from(mail)[4:])  # the formatted code works too
    assert response.status_code == 201, response.text
    assert response.json() == {"status": "confirmed", "email": "new.person@example.org"}

    [user] = users(sql)
    assert user["email"] == "new.person@example.org"
    assert user["nickname"] == "Billie Fan"  # squished like Rails
    assert user["usage_region"] == "JP" and user["usage_region_pending"] is False
    assert user["locale"] == "ja"
    assert user["encrypted_password"].startswith("$2a$04$")  # Devise format (cost 4 in tests, 11 in production)
    assert verify_password("a unique passphrase", user["encrypted_password"])
    assert user["finance_owner_uid"] is not None and user["ability_cache"] == {}
    assert user["sign_in_count"] == 0 and user["failed_attempts"] == 0 and user["google_uid"] is None
    [team] = sql.execute("SELECT * FROM public.teams").fetchall()
    assert team["name"] == "Your Team" and user["current_team_id"] == team["id"]
    [membership] = sql.execute("SELECT * FROM public.memberships").fetchall()
    assert (membership["user_id"], membership["team_id"], membership["user_email"], membership["role_ids"]) == (user["id"], team["id"], user["email"], ["admin"])
    assert sql.execute("SELECT status, encrypted_password FROM identity.pending_registrations").fetchone() == {"status": "confirmed", "encrypted_password": ""}


def test_confirming_twice_is_idempotent(client, mail, sql):
    started = register(client).json()
    code = code_from(mail)
    assert confirm(client, started, code).status_code == 201
    again = confirm(client, started, code)
    assert again.status_code == 201 and again.json()["status"] == "confirmed"
    assert len(users(sql)) == 1


# 2. Duplicate email ------------------------------------------------------------------------

def test_existing_address_gets_an_identical_response_and_a_notice_instead_of_a_code(client, mail, sql):
    started = register(client).json()
    assert confirm(client, started, code_from(mail)).status_code == 201
    mail.sent.clear()

    second = register(client, email="NEW.person@example.org", password="another passphrase", password_confirmation="another passphrase")
    assert second.status_code == 202
    assert set(second.json()) == set(started)  # indistinguishable from a fresh sign-up
    [notice] = mail.sent
    assert notice.kind == "existing_account" and notice.to == "new.person@example.org"
    assert not any(ch.isdigit() for ch in notice.text)  # no code to type
    # No code can ever confirm it, and the existing password is untouched.
    for guess in ("00000000", "12345678"):
        assert confirm(client, second.json(), guess).json()["error"] == "invalid_code"
    [user] = users(sql)
    assert verify_password("a unique passphrase", user["encrypted_password"])
    assert sql.execute("SELECT encrypted_password FROM identity.pending_registrations WHERE existing_account").fetchone()["encrypted_password"] == ""


def test_account_created_elsewhere_while_pending_is_reported_after_the_code(client, mail, sql):
    started = register(client).json()
    # The website creates the same address before the app confirms.
    sql.execute("INSERT INTO public.users (email, usage_region, created_at, updated_at) VALUES ('new.person@example.org', 'US', now(), now())")
    response = confirm(client, started, code_from(mail))
    assert response.status_code == 409 and response.json() == {"error": "email_taken"}
    assert len(users(sql)) == 1


# 3./4./5. Validation --------------------------------------------------------------------------

@pytest.mark.parametrize(("changes", "fields"), [
    ({"email": ""}, {"email": ["blank"]}),
    ({"email": "no-at-sign"}, {"email": ["invalid"]}),
    ({"email": "two@@example.org"}, {"email": ["invalid"]}),
    ({"email": "space in@example.org"}, {"email": ["invalid"]}),
    ({"email": "a" * 250 + "@x.org"}, {"email": ["invalid"]}),
    ({"password": "short", "password_confirmation": "short"}, {"password": ["too_short"]}),
    ({"password": "x" * 129, "password_confirmation": "x" * 129}, {"password": ["too_long"]}),
    ({"password_confirmation": "different"}, {"password_confirmation": ["mismatch"]}),
    ({"usage_region": None}, {"usage_region": ["blank"]}),
    ({"usage_region": "  "}, {"usage_region": ["blank"]}),
    ({"usage_region": "ZZ"}, {"usage_region": ["inclusion"]}),
    ({"usage_region": "Japan"}, {"usage_region": ["inclusion"]}),
    ({"nickname": "n" * 41}, {"nickname": ["too_long"]}),
])
def test_invalid_input_is_rejected_with_field_codes(client, mail, sql, changes, fields):
    response = register(client, **changes)
    assert response.status_code == 422
    assert response.json() == {"error": "invalid", "fields": fields}
    assert mail.sent == [] and sql.execute("SELECT count(*) AS n FROM identity.pending_registrations").fetchone()["n"] == 0


def test_errors_never_echo_submitted_values(client):
    response = client.post("/v1/registrations", json={**VALID, "password": ["not", "a", "string"]})
    assert response.status_code == 422
    assert "not" not in response.text and "a unique passphrase" not in response.text
    assert response.json() == {"error": "invalid", "fields": {"password": ["invalid"]}}


def test_global_citizen_and_lowercase_regions_are_accepted(client, mail, sql):
    started = register(client, usage_region="xg", nickname="").json()
    assert confirm(client, started, code_from(mail)).status_code == 201
    [user] = users(sql)
    assert user["usage_region"] == "XG" and user["nickname"] is None


def test_unknown_locale_falls_back_to_english_mail_and_no_saved_locale(client, mail, sql):
    started = register(client, locale="fr").json()
    assert "verification code" in mail.sent[0].subject
    confirm(client, started, code_from(mail))
    assert users(sql)[0]["locale"] is None


def test_breached_passwords_are_refused_like_devise_pwned_password(client, pwned_list, mail):
    pwned_list.add("password123")
    response = register(client, password="password123", password_confirmation="password123")
    assert response.status_code == 422 and response.json()["fields"] == {"password": ["pwned"]}
    assert mail.sent == []


def test_closed_registration(make_client):
    response = register(make_client(registration_enabled=False))
    assert response.status_code == 403 and response.json() == {"error": "registration_closed"}


def test_mail_outage_is_reported_and_leaves_nothing_usable(client, mail, sql):
    mail.fail = True
    response = register(client)
    assert response.status_code == 503 and response.json() == {"error": "mail_unavailable"}
    assert sql.execute("SELECT status, encrypted_password FROM identity.pending_registrations").fetchone() == {"status": "failed", "encrypted_password": ""}


# 6. Confirmation, attempts and expiration -----------------------------------------------------

def test_wrong_codes_are_limited_then_the_registration_ends(client, mail, sql):
    started = register(client).json()
    real = code_from(mail)
    wrong = "00000000" if real != "00000000" else "11111111"
    for remaining in (4, 3, 2, 1):
        response = confirm(client, started, wrong)
        assert response.status_code == 422 and response.json() == {"error": "invalid_code", "attempts_remaining": remaining}
    assert confirm(client, started, wrong).json() == {"error": "too_many_attempts"}
    assert confirm(client, started, real).status_code == 410  # even the right code no longer works
    assert users(sql) == []


def test_malformed_code_is_not_counted(client, mail, sql):
    started = register(client).json()
    assert confirm(client, started, "12ab").json() == {"error": "invalid", "fields": {"code": ["invalid"]}}
    assert sql.execute("SELECT code_attempts FROM identity.pending_registrations").fetchone()["code_attempts"] == 0


def test_code_expires_after_30_minutes_and_resend_issues_a_new_one(client, mail, clock, sql):
    started = register(client).json()
    old = code_from(mail)
    clock.advance(minutes=31)
    assert confirm(client, started, old).json() == {"error": "code_expired"}
    resent = client.post(f"/v1/registrations/{started['registration_id']}/resend", json={"registration_secret": started["registration_secret"]})
    assert resent.status_code == 202 and resent.json()["resends_remaining"] == 3  # 5 sends in total
    new = code_from(mail)
    if new != old:
        assert confirm(client, started, old).json()["error"] == "invalid_code"  # the old code is replaced
    assert confirm(client, started, new).status_code == 201


def test_registration_expires_after_24_hours(client, mail, clock):
    started = register(client).json()
    code = code_from(mail)
    clock.advance(hours=24, seconds=1)
    assert confirm(client, started, code).json() == {"error": "registration_expired"}
    resend = client.post(f"/v1/registrations/{started['registration_id']}/resend", json={"registration_secret": started["registration_secret"]})
    assert resend.json() == {"error": "registration_expired"}


def test_the_secret_is_required(client, mail):
    started = register(client).json()
    code = code_from(mail)
    for secret in ("wrong", "", None):
        response = client.post(f"/v1/registrations/{started['registration_id']}/confirmation", json={"registration_secret": secret, "code": code})
        assert response.status_code == 404 and response.json() == {"error": "not_found"}
    assert client.post("/v1/registrations/not-a-uuid/confirmation", json={"registration_secret": "x", "code": code}).status_code == 404


def test_someone_else_starting_a_signup_for_my_address_cannot_finish_it_with_my_code(client, mail, sql):
    """Pre-account-takeover: an attacker registers the victim's address with the attacker's password."""
    attacker = register(client, password="attacker password", password_confirmation="attacker password").json()
    victim = register(client).json()
    victim_code = code_from(mail)
    # The victim's code only fits the victim's registration (and the attacker never sees it anyway).
    assert confirm(client, attacker, victim_code).json()["error"] == "invalid_code"
    assert confirm(client, victim, victim_code).status_code == 201
    [user] = users(sql)
    assert verify_password("a unique passphrase", user["encrypted_password"])
    assert not verify_password("attacker password", user["encrypted_password"])
    # The attacker's pending registration is closed once the address is confirmed.
    assert sql.execute("SELECT status FROM identity.pending_registrations WHERE id = %s", (attacker["registration_id"],)).fetchone()["status"] == "superseded"


# 7. Resend and rate limits --------------------------------------------------------------------

def test_resend_is_spaced_and_capped(client, mail, clock):
    started = register(client).json()
    url = f"/v1/registrations/{started['registration_id']}/resend"
    body = {"registration_secret": started["registration_secret"]}
    too_soon = client.post(url, json=body)
    assert too_soon.status_code == 429 and too_soon.json()["error"] == "resend_too_soon"
    assert 1 <= int(too_soon.headers["Retry-After"]) <= 60
    for _ in range(4):
        clock.advance(seconds=61)
        assert client.post(url, json=body).status_code == 202
    clock.advance(seconds=61)
    assert client.post(url, json=body).json() == {"error": "resend_limit"}
    assert len(mail.sent) == 5


def test_resend_after_confirmation(client, mail, clock):
    started = register(client).json()
    confirm(client, started, code_from(mail))
    clock.advance(seconds=61)
    response = client.post(f"/v1/registrations/{started['registration_id']}/resend", json={"registration_secret": started["registration_secret"]})
    assert response.status_code == 409 and response.json() == {"error": "already_confirmed"}


def test_registrations_are_rate_limited_per_address_and_per_ip(client):
    for _ in range(5):
        assert register(client).status_code == 202
    limited = register(client)
    assert limited.status_code == 429 and limited.json()["error"] == "rate_limited" and "Retry-After" in limited.headers
    for index in range(4):  # the refused request above also counted against this IP
        assert register(client, email=f"other{index}@example.org").status_code == 202
    assert register(client, email="one-more@example.org").status_code == 429  # 10 per IP per 10 minutes


def test_trusted_proxy_hops_use_the_proxy_appended_address(make_client):
    client = make_client(trusted_proxy_hops=1)
    # Spoofed left-most entries do not create fresh buckets: the right-most (proxy-added) entry counts.
    responses = [client.post("/v1/registrations", json={**VALID, "email": f"q{i}@example.org"},
                             headers={"X-Forwarded-For": f"10.0.0.{i}, 198.51.100.9"}) for i in range(11)]
    assert [r.status_code for r in responses].count(429) == 1


# Logging, headers, CORS, readiness -----------------------------------------------------------

def test_logs_never_contain_secrets_codes_passwords_or_addresses(client, mail, caplog):
    caplog.set_level(logging.DEBUG)
    started = register(client).json()
    confirm(client, started, code_from(mail))
    text = "\n".join(record.getMessage() for record in caplog.records)
    for secret in ("a unique passphrase", started["registration_secret"], code_from(mail), "new.person@example.org", "example.org"):
        assert secret not in text
    assert "route=/v1/registrations" in text


def test_security_headers_and_cors(client):
    preflight = client.options("/v1/registrations", headers={"Origin": "tauri://localhost", "Access-Control-Request-Method": "POST",
                                                             "Access-Control-Request-Headers": "content-type"})
    assert preflight.status_code == 200 and preflight.headers["access-control-allow-origin"] == "tauri://localhost"
    assert "access-control-allow-credentials" not in preflight.headers
    evil = client.options("/v1/registrations", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in evil.headers
    response = client.get("/v1/config")
    assert response.headers["cache-control"] == "no-store" and response.headers["x-content-type-options"] == "nosniff"
    assert response.json() == {"registration_open": True, "google_available": True, "password": {"min": 6, "max": 128}, "code_length": 8}


def test_oversized_bodies_are_refused(client):
    response = client.post("/v1/registrations", content=b"{" + b" " * 20000 + b"}", headers={"Content-Type": "application/json"})
    assert response.status_code == 413


def test_not_ready_when_the_identity_schema_is_missing(client, sql):
    services = client.app.state.services
    services.ready, services.problems = False, ("identity schema not migrated",)
    sql.execute("ALTER TABLE identity.schema_migrations RENAME TO schema_migrations_hidden")
    try:
        assert register(client).json() == {"error": "service_not_ready"}
        assert client.get("/health").status_code == 503
    finally:
        sql.execute("ALTER TABLE identity.schema_migrations_hidden RENAME TO schema_migrations")
    assert client.get("/health").status_code == 503  # cached until the next write re-checks
    assert register(client).status_code == 202
    assert client.get("/health").json()["status"] == "ok"


def test_purge_erases_expired_password_hashes(client, mail, clock, sql):
    register(client)
    clock.advance(days=2)
    client.app.state.services.registrations.purge()
    assert sql.execute("SELECT encrypted_password FROM identity.pending_registrations").fetchone()["encrypted_password"] == ""
    clock.advance(days=8)
    client.app.state.services.registrations.purge()
    assert sql.execute("SELECT count(*) AS n FROM identity.pending_registrations").fetchone()["n"] == 0
