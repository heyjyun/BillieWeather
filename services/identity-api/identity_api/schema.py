"""Migrations for the `identity` schema and the Rails compatibility check.

    uv run python -m identity_api.schema migrate   # apply pending identity migrations (additive)
    uv run python -m identity_api.schema check     # verify the Rails tables this service writes

The service refuses to create accounts unless `check` passes: every column it writes must exist
with the expected type, and the constraints it relies on must be present.
"""
from __future__ import annotations

import sys
from importlib import resources

import psycopg

MIGRATION_LOCK = 0x1D_E7_17_A1  # pg_advisory_xact_lock key, unique to this service

# (table, column) -> acceptable information_schema data_type values
REQUIRED_COLUMNS: dict[tuple[str, str], set[str]] = {
    ("users", "id"): {"integer", "bigint"},
    ("users", "email"): {"character varying"},
    ("users", "encrypted_password"): {"character varying"},
    ("users", "nickname"): {"character varying"},
    ("users", "usage_region"): {"character varying"},
    ("users", "usage_region_pending"): {"boolean"},
    ("users", "locale"): {"character varying"},
    ("users", "google_uid"): {"character varying"},
    ("users", "ability_cache"): {"jsonb"},
    ("users", "current_team_id"): {"integer", "bigint"},
    ("users", "failed_attempts"): {"integer"},
    ("users", "locked_at"): {"timestamp without time zone"},
    ("users", "otp_required_for_login"): {"boolean"},
    ("users", "platform_agent_of_id"): {"integer", "bigint"},
    ("users", "finance_owner_uid"): {"uuid"},
    ("users", "created_at"): {"timestamp without time zone"},
    ("users", "updated_at"): {"timestamp without time zone"},
    ("teams", "id"): {"integer", "bigint"},
    ("teams", "name"): {"character varying"},
    ("teams", "time_zone"): {"character varying"},
    ("teams", "created_at"): {"timestamp without time zone"},
    ("teams", "updated_at"): {"timestamp without time zone"},
    ("memberships", "user_id"): {"integer", "bigint"},
    ("memberships", "team_id"): {"integer", "bigint"},
    ("memberships", "user_email"): {"character varying"},
    ("memberships", "role_ids"): {"jsonb"},
    ("memberships", "created_at"): {"timestamp without time zone"},
    ("memberships", "updated_at"): {"timestamp without time zone"},
}
REQUIRED_INDEXES = {"index_users_on_email", "index_users_on_google_uid", "index_users_on_finance_owner_uid"}
REQUIRED_CHECKS = {"users_usage_region_required", "users_usage_region_allowed"}


def compatibility_problems(conn: psycopg.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT table_name, column_name, data_type, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name IN ('users', 'teams', 'memberships')"
    ).fetchall()
    found = {(row["table_name"], row["column_name"]): row for row in rows}
    problems = []
    for key, types in REQUIRED_COLUMNS.items():
        row = found.get(key)
        if row is None:
            problems.append(f"missing column {key[0]}.{key[1]}")
        elif row["data_type"] not in types:
            problems.append(f"{key[0]}.{key[1]} is {row['data_type']}, expected {sorted(types)}")
    owner = found.get(("users", "finance_owner_uid"))
    if owner is not None and "gen_random_uuid" not in (owner["column_default"] or ""):
        problems.append("users.finance_owner_uid has no gen_random_uuid() default")
    indexes = {r["indexname"] for r in conn.execute("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users'")}
    problems += [f"missing index {name}" for name in sorted(REQUIRED_INDEXES - indexes)]
    checks = {r["conname"] for r in conn.execute("SELECT conname FROM pg_constraint WHERE conrelid = 'public.users'::regclass AND contype = 'c'")}
    problems += [f"missing check constraint {name}" for name in sorted(REQUIRED_CHECKS - checks)]
    return problems


def migrations() -> list[tuple[str, str]]:
    folder = resources.files("identity_api") / "migrations"
    files = sorted(entry for entry in folder.iterdir() if entry.name.endswith(".sql"))
    return [(entry.name.removesuffix(".sql"), entry.read_text()) for entry in files]


def migrate(conn: psycopg.Connection) -> list[str]:
    """Applies pending migrations in one transaction; returns the versions applied."""
    applied: list[str] = []
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
        conn.execute("CREATE SCHEMA IF NOT EXISTS identity")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS identity.schema_migrations (version varchar(64) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        done = {r["version"] for r in conn.execute("SELECT version FROM identity.schema_migrations")}
        for version, sql in migrations():
            if version in done:
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO identity.schema_migrations (version) VALUES (%s)", (version,))
            applied.append(version)
    return applied


def identity_schema_ready(conn: psycopg.Connection) -> bool:
    expected = {version for version, _ in migrations()}
    try:
        with conn.transaction():
            done = {r["version"] for r in conn.execute("SELECT version FROM identity.schema_migrations")}
    except psycopg.errors.UndefinedTable:
        return False
    return expected <= done


def main(argv: list[str]) -> int:
    from psycopg.rows import dict_row

    from .config import get_settings

    command = argv[1] if len(argv) > 1 else "check"
    settings = get_settings()
    with psycopg.connect(settings.database_url, row_factory=dict_row, prepare_threshold=None, autocommit=True) as conn:
        problems = compatibility_problems(conn)
        if problems:
            print("Rails schema is NOT compatible:\n  " + "\n  ".join(problems))
            return 1
        print("Rails schema compatible.")
        if command == "migrate":
            applied = migrate(conn)
            print("Applied: " + (", ".join(applied) if applied else "nothing (up to date)"))
        elif command != "check":
            print(f"unknown command {command!r}; use migrate or check")
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
