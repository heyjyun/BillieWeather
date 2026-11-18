"""Google sign-up / linking: PKCE flow, ID-token verification, cancellation, failure, linking rules."""
from __future__ import annotations

import json
import time
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from identity_api import tokens
from identity_api.google import GoogleClient
from identity_api.passwords import hash_password, verify_password

CLIENT_ID = "google-client-id.apps.googleusercontent.com"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeGoogle:
    """Google's token and JWKS endpoints."""

    def __init__(self):
        self.claims: dict = {}
        self.token_status = 200
        self.signing_key = KEY
        self.exchanges: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth2/v3/certs":
            jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
            return httpx.Response(200, json={"keys": [{**jwk, "kid": "k1", "alg": "RS256", "use": "sig"}]})
        if request.url.path == "/token":
            form = parse_qs(request.content.decode())
            self.exchanges.append({key: value[0] for key, value in form.items()})
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant"})
            now = int(time.time())
            claims = {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "1098765", "email": "Person@Gmail.com",
                      "email_verified": True, "iat": now, "exp": now + 600, **self.claims}
            token = jwt.encode({k: v for k, v in claims.items() if v is not None}, self.signing_key, algorithm="RS256", headers={"kid": "k1"})
            return httpx.Response(200, json={"id_token": token, "access_token": "unused"})
        return httpx.Response(404)


@pytest.fixture
def google():
    return FakeGoogle()


@pytest.fixture
def gclient(make_client, settings, google):
    client = GoogleClient(CLIENT_ID, "google-secret", settings.google_redirect_uri, http=httpx.Client(transport=httpx.MockTransport(google.handler)))
    return make_client(google_client=client)


class AppFlow:
    """What the app does: verifier in memory, challenge to the server, browser to Google, then poll."""

    def __init__(self, http):
        self.http = http
        self.verifier = tokens.new_verifier()
        started = http.post("/v1/google/flows", json={"code_challenge": tokens.s256(self.verifier), "code_challenge_method": "S256", "locale": "zh-CN"})
        assert started.status_code == 201, started.text
        self.flow_id = started.json()["flow_id"]
        self.url = urlparse(started.json()["authorization_url"])
        self.query = {key: value[0] for key, value in parse_qs(self.url.query).items()}

    def google_returns(self, **params):
        return self.http.get("/v1/google/callback", params={"state": self.query["state"], **params})

    def post(self, action, **body):
        return self.http.post(f"/v1/google/flows/{self.flow_id}/{action}", json={"code_verifier": self.verifier, **body})


def signed_in_to_google(google: FakeGoogle, flow: AppFlow, **claims):
    google.claims = {"nonce": flow.query["nonce"], **claims}
    return flow.google_returns(code="auth-code-123")


# 8. Success --------------------------------------------------------------------------------

def test_authorization_request_uses_pkce_state_nonce_and_minimal_scope(gclient, settings):
    flow = AppFlow(gclient)
    assert flow.url.netloc == "accounts.google.com"
    q = flow.query
    assert q["client_id"] == CLIENT_ID and q["redirect_uri"] == "http://identity.test/v1/google/callback"
    assert q["response_type"] == "code" and q["scope"] == "openid email" and q["code_challenge_method"] == "S256"
    assert len(q["state"]) >= 43 and len(q["nonce"]) >= 43 and len(q["code_challenge"]) == 43
    assert q["code_challenge"] != tokens.s256(flow.verifier)  # the app's verifier never goes to Google


def test_new_google_account_is_created_with_a_password_for_the_app(gclient, google, sql):
    flow = AppFlow(gclient)
    page = signed_in_to_google(google, flow)
    assert page.status_code == 200 and "验证完成" in page.text and 'href="billieweather://open"' in page.text
    assert "auth-code-123" not in page.text and "default-src 'none'" in page.headers["content-security-policy"]
    assert google.exchanges[0]["code_verifier"] and google.exchanges[0]["redirect_uri"] == "http://identity.test/v1/google/callback"

    status = flow.post("status").json()
    assert status["status"] == "verified" and status["outcome"] == "new_account" and status["email"] == "person@gmail.com"

    # A nickname is required here too: Google's profile name is never used in its place.
    missing = flow.post("complete", password="app passphrase", password_confirmation="app passphrase", usage_region="XG", nickname="  ")
    assert missing.status_code == 422 and missing.json()["fields"] == {"nickname": ["blank"]}
    created = flow.post("complete", password="app passphrase", password_confirmation="app passphrase", usage_region="XG", nickname=" 小雨 ")
    assert created.status_code == 201, created.text
    assert created.json() == {"status": "created", "email": "person@gmail.com"}
    [user] = sql.execute("SELECT * FROM public.users").fetchall()
    assert user["google_uid"] == "1098765" and user["usage_region"] == "XG" and user["locale"] == "zh-CN" and user["nickname"] == "小雨"
    assert verify_password("app passphrase", user["encrypted_password"])
    assert sql.execute("SELECT count(*) AS n FROM public.memberships").fetchone()["n"] == 1
    # Single use.
    assert flow.post("complete", password="app passphrase", password_confirmation="app passphrase", usage_region="XG").status_code == 409
    assert flow.post("status").json()["status"] == "completed"
    stored = sql.execute("SELECT provider_verifier FROM identity.oauth_flows").fetchone()
    assert stored["provider_verifier"] == ""


def test_complete_validates_region_and_password(gclient, google):
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    response = flow.post("complete", password="abc", password_confirmation="abd", usage_region="ZZ")
    assert response.status_code == 422
    assert response.json()["fields"] == {"password": ["too_short"], "password_confirmation": ["mismatch"], "usage_region": ["inclusion"], "nickname": ["blank"]}


def test_already_linked_google_identity(gclient, google, sql):
    sql.execute("INSERT INTO public.users (email, usage_region, google_uid, created_at, updated_at) VALUES ('linked@example.org', 'US', '1098765', now(), now())")
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    status = flow.post("status").json()
    assert status["outcome"] == "already_linked" and status["email"] == "linked@example.org"
    assert flow.post("complete", password="xxxxxxxx", password_confirmation="xxxxxxxx", usage_region="US").status_code == 409


# Linking -------------------------------------------------------------------------------------

def existing_user(sql, **columns):
    values = {"email": "person@gmail.com", "usage_region": "US", "encrypted_password": hash_password("website password", 4), **columns}
    names = ", ".join(values)
    sql.execute(f"INSERT INTO public.users ({names}, created_at, updated_at) VALUES ({', '.join(['%s'] * len(values))}, now(), now())", list(values.values()))


def test_linking_an_existing_account_requires_its_password(gclient, google, sql):
    existing_user(sql)
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    assert flow.post("status").json()["outcome"] == "link_required"
    wrong = flow.post("link", password="guess")
    assert wrong.status_code == 422 and wrong.json() == {"error": "invalid_password", "attempts_remaining": 4}
    assert sql.execute("SELECT failed_attempts FROM public.users").fetchone()["failed_attempts"] == 1  # shared with Devise lockout
    linked = flow.post("link", password="website password")
    assert linked.status_code == 200 and linked.json() == {"status": "linked", "email": "person@gmail.com"}
    user = sql.execute("SELECT google_uid, failed_attempts FROM public.users").fetchone()
    assert user == {"google_uid": "1098765", "failed_attempts": 0}


def test_link_attempts_are_limited(gclient, google, sql):
    existing_user(sql)
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    for _ in range(4):
        assert flow.post("link", password="nope").status_code == 422
    assert flow.post("link", password="nope").json() == {"error": "too_many_attempts"}
    assert flow.post("link", password="website password").status_code == 409
    assert sql.execute("SELECT google_uid FROM public.users").fetchone()["google_uid"] is None


@pytest.mark.parametrize(("columns", "reason"), [
    ({"otp_required_for_login": True}, "otp_required"),
    ({"google_uid": "someone-else"}, "google_other_account"),
    ({"failed_attempts": 20}, "locked"),
])
def test_accounts_the_website_would_not_link_are_refused(gclient, google, sql, columns, reason):
    existing_user(sql, **columns)
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    status = flow.post("status").json()
    assert status["outcome"] == "unavailable" and status["failure"] == reason
    assert flow.post("link", password="website password").status_code == 409


def test_linking_never_trusts_the_email_alone_when_google_says_unverified(gclient, google, sql):
    existing_user(sql)
    flow = AppFlow(gclient)
    page = signed_in_to_google(google, flow, email_verified=False)
    assert page.status_code == 400
    assert flow.post("status").json() == {"status": "failed", "failure": "unverified_email", "expires_at": flow.post("status").json()["expires_at"]}
    assert sql.execute("SELECT google_uid FROM public.users").fetchone()["google_uid"] is None


# Failure and cancellation ---------------------------------------------------------------------

def test_cancelled_at_google(gclient, google, sql):
    flow = AppFlow(gclient)
    page = flow.google_returns(error="access_denied")
    assert page.status_code == 200 and "已取消" in page.text
    assert flow.post("status").json()["status"] == "cancelled"
    assert google.exchanges == [] and sql.execute("SELECT count(*) AS n FROM public.users").fetchone()["n"] == 0


def test_cancelled_in_the_app(gclient, google):
    flow = AppFlow(gclient)
    assert flow.post("cancel").status_code == 204
    assert flow.post("status").json()["status"] == "cancelled"
    # Google returning afterwards changes nothing.
    signed_in_to_google(google, flow)
    assert flow.post("status").json()["status"] == "cancelled" and google.exchanges == []


@pytest.mark.parametrize(("setup", "failure"), [
    (lambda g, f: setattr(g, "token_status", 400), "token_exchange_failed"),
    (lambda g, f: g.claims.update(aud="another-client"), "unverified_identity"),
    (lambda g, f: g.claims.update(iss="https://evil.example"), "unverified_identity"),
    (lambda g, f: g.claims.update(exp=int(time.time()) - 3600), "unverified_identity"),
    (lambda g, f: setattr(g, "signing_key", OTHER_KEY), "unverified_identity"),
    (lambda g, f: g.claims.update(nonce="replayed-nonce"), "unverified_identity"),
    (lambda g, f: g.claims.update(email="not-an-email"), "unverified_email"),
])
def test_provider_failures_never_create_or_link(gclient, google, sql, setup, failure):
    existing_user(sql, email="someone@example.org")
    flow = AppFlow(gclient)
    google.claims = {"nonce": flow.query["nonce"]}
    setup(google, flow)
    page = flow.google_returns(code="auth-code-123")
    assert page.status_code == 400 and "auth-code-123" not in page.text
    status = flow.post("status").json()
    assert status["status"] == "failed" and status["failure"] == failure
    assert sql.execute("SELECT count(*) AS n FROM public.users WHERE google_uid IS NOT NULL").fetchone()["n"] == 0


def test_state_is_single_use(gclient, google):
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    signed_in_to_google(google, flow)  # replayed callback
    assert len(google.exchanges) == 1
    assert flow.http.get("/v1/google/callback", params={"state": "forged", "code": "x"}).status_code == 400


def test_only_the_app_holding_the_verifier_can_read_or_finish(gclient, google):
    flow = AppFlow(gclient)
    signed_in_to_google(google, flow)
    for verifier in (tokens.new_verifier(), "short", None):
        response = gclient.post(f"/v1/google/flows/{flow.flow_id}/status", json={"code_verifier": verifier})
        assert response.status_code == 404 and response.json() == {"error": "not_found"}


def test_flows_expire_after_ten_minutes(gclient, google, clock):
    flow = AppFlow(gclient)
    clock.advance(minutes=11)
    assert "已过期" in signed_in_to_google(google, flow).text
    assert flow.post("status").json()["status"] == "expired"
    assert google.exchanges == []


def test_challenge_must_be_s256(gclient):
    response = gclient.post("/v1/google/flows", json={"code_challenge": "plain-verifier", "code_challenge_method": "plain"})
    assert response.status_code == 422 and response.json() == {"error": "invalid", "fields": {"code_challenge": ["invalid"]}}


def test_unconfigured_google_is_reported(make_client):
    client = make_client(google_client_id="", google_client_secret="")
    assert client.get("/v1/config").json()["google_available"] is False
    response = client.post("/v1/google/flows", json={"code_challenge": "a" * 43, "code_challenge_method": "S256"})
    assert response.status_code == 503 and response.json() == {"error": "google_unavailable"}
