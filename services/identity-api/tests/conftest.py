"""Test harness. Uses a loopback connection or Unix socket and a *_test / *_compat database.

    IDENTITY_TEST_DATABASE_URL=postgresql://localhost/billieweather_identity_compat uv run pytest

If the database has no Rails tables, the users/teams/memberships DDL from tests/fixtures is loaded.
"""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

from identity_api.config import Settings
from identity_api.db import Database
from identity_api.main import build_services, create_app
from identity_api.mailer import MemoryMailer
from identity_api.passwords import PwnedChecker
from identity_api.schema import migrate

# Tests never read the developer's services/identity-api/.env (it may point at Neon or switch
# EMAIL_VERIFICATION_REQUIRED off); every test states the settings it needs.
Settings.model_config["env_file"] = None

TEST_URL = os.environ.get("IDENTITY_TEST_DATABASE_URL", "")
if not TEST_URL:
    # No default: an unset variable must never pick a database on this computer by itself.
    raise pytest.UsageError("Set IDENTITY_TEST_DATABASE_URL to an isolated local *_test or *_compat database (see README)")
FIXTURE = Path(__file__).parent / "fixtures" / "rails_accounts_schema.sql"


def _assert_local(url: str) -> None:
    options = conninfo_to_dict(url)
    name = options.get("dbname", "")
    host = options.get("host") or os.getenv("PGHOST", "")
    address = options.get("hostaddr") or os.getenv("PGHOSTADDR", "")
    loopback = {"127.0.0.1", "::1"}
    local_host = host in loopback | {"localhost"} or (Path(host).is_absolute() and "," not in host)
    local_address = not address or address in loopback
    uses_service = options.get("service") or os.getenv("PGSERVICE")
    if uses_service or not (local_host and local_address and name.endswith(("_test", "_compat"))):
        raise RuntimeError("refusing to run tests outside a local *_test or *_compat database")


def _ensure_database(url: str) -> None:
    name = conninfo_to_dict(url)["dbname"]
    with psycopg.connect(url, dbname="postgres", autocommit=True) as conn:
        if conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone() is None:
            conn.execute(psycopg.sql.SQL("CREATE DATABASE {}").format(psycopg.sql.Identifier(name)))


@pytest.fixture(scope="session")
def database_url() -> str:
    _assert_local(TEST_URL)
    _ensure_database(TEST_URL)
    with psycopg.connect(TEST_URL, autocommit=True, row_factory=dict_row) as conn:
        if conn.execute("SELECT to_regclass('public.users') AS t").fetchone()["t"] is None:
            conn.execute(FIXTURE.read_text())
        migrate(conn)
    return TEST_URL


@pytest.fixture(scope="session")
def rails_full_schema(database_url: str) -> bool:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        return conn.execute("SELECT to_regclass('public.finance_profiles') AS t").fetchone()["t"] is not None


@pytest.fixture
def db(database_url: str):
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute("TRUNCATE public.users, public.teams, public.memberships RESTART IDENTITY CASCADE")
        conn.execute("TRUNCATE identity.pending_registrations, identity.oauth_flows, identity.email_verifications")
    database = Database(database_url, max_size=4)
    database.open()
    yield database
    database.close()


@pytest.fixture
def sql(database_url: str):
    with psycopg.connect(database_url, autocommit=True, row_factory=dict_row) as conn:
        yield conn


class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 17, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta) -> None:
        self.now += timedelta(**delta)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def settings(database_url: str) -> Settings:
    return Settings(identity_env="test", database_url=database_url, bcrypt_cost=4, mail_delivery="memory",
                    public_url="http://identity.test", token_hmac_key="t" * 40, pwned_check=False,
                    google_client_id="google-client-id.apps.googleusercontent.com", google_client_secret="google-secret")


@pytest.fixture
def mail() -> MemoryMailer:
    return MemoryMailer()


@pytest.fixture
def pwned_list() -> set[str]:
    return set()


@pytest.fixture
def pwned(pwned_list: set[str]) -> PwnedChecker:
    import hashlib

    def handler(request: httpx.Request) -> httpx.Response:
        prefix = request.url.path.rsplit("/", 1)[-1]
        lines = []
        for password in pwned_list:
            digest = hashlib.sha1(password.encode()).hexdigest().upper()
            if digest.startswith(prefix):
                lines.append(f"{digest[5:]}:42")
        lines.append("0000000000000000000000000000000000A:0")  # padding entry, as with Add-Padding
        return httpx.Response(200, text="\r\n".join(lines))

    return PwnedChecker(True, client=httpx.Client(transport=httpx.MockTransport(handler)))


@pytest.fixture
def make_client(settings, db, mail, pwned, clock):
    def make(google_client=None, **overrides) -> TestClient:
        current = settings.model_copy(update=overrides) if overrides else settings
        services = build_services(current, mail=mail, pwned=pwned, google_client=google_client, db=db)
        services.registrations.clock = clock
        services.google.clock = clock
        app = create_app(current, services)
        client = TestClient(app, client=("203.0.113.7", 50000))
        client.__enter__()
        return client

    clients: list[TestClient] = []

    def tracked(*args, **kwargs):
        client = make(*args, **kwargs)
        clients.append(client)
        return client

    yield tracked
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


VALID = {"email": "New.Person@Example.org ", "password": "a unique passphrase", "password_confirmation": "a unique passphrase",
         "usage_region": "jp", "nickname": "  Billie   Fan ", "locale": "ja"}


def code_from(mail: MemoryMailer) -> str:
    import re

    message = mail.sent[-1]
    return re.search(r"(\d{4})-(\d{4})", message.text).group(0).replace("-", "")
