"""Verify the PostgreSQL target before startup or an explicit schema release."""
from __future__ import annotations

import os
import re

import psycopg
from psycopg.conninfo import conninfo_to_dict

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
URL_OPTIONS = {"host", "port", "dbname", "user", "password", "sslmode", "sslrootcert", "channel_binding", "connect_timeout"}
OVERRIDES = ("PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGOPTIONS")


def local_host(host: str) -> bool:
    return host in LOCAL_HOSTS or (host.startswith("/") and "," not in host)


def connection_options(url: str) -> dict[str, str]:
    if any(os.getenv(key) for key in OVERRIDES):
        raise RuntimeError("Unsafe libpq environment override")
    if not url.startswith(("postgresql://", "postgres://")):
        raise RuntimeError("Expected a PostgreSQL connection URL")
    try:
        target = conninfo_to_dict(url)
    except psycopg.Error:
        raise RuntimeError("Invalid PostgreSQL connection URL") from None
    if target.keys() - URL_OPTIONS:
        raise RuntimeError("Unexpected option in PostgreSQL connection URL")
    return target


def local_target(url: str, environment: str) -> None:
    target = connection_options(url)
    hosts = (target.get("host", ""), os.getenv("PGHOST", ""))
    suffix = r"_(?:test|compat)" if environment == "test" else r"_development"
    if (os.getenv("BILLIE_DB_ENV", "local") != "local"
        or not all(not host or local_host(host) for host in hosts)
        or not re.search(suffix + r"\Z", target.get("dbname", ""))):
        raise RuntimeError(f"Refusing a non-local or incorrectly named {environment} database")


def release_target(url: str, *, migration: bool) -> dict[str, str]:
    target = connection_options(url)
    environment = os.getenv("BILLIE_DB_ENV", "")
    pinned_host = os.getenv("BILLIE_DB_HOST", "")
    name = os.getenv("BILLIE_DB_NAME", "")
    identity = os.getenv("BILLIE_DB_TARGET_ID", "")
    # Each failed condition is named (never a value), so a refused start says what to fix.
    problems: list[str] = []
    if environment in {"staging", "production"}:
        endpoint, _, suffix = pinned_host.partition(".")
        expected_neon = re.fullmatch(r"ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech", pinned_host) and not endpoint.endswith("-pooler")
        allowed_hosts = {pinned_host} if migration else {pinned_host, f"{endpoint}-pooler.{suffix}"}
        if not expected_neon:
            problems.append("BILLIE_DB_HOST must be the direct Neon endpoint hostname (without -pooler)")
        if target.get("sslmode") != "verify-full":
            problems.append("the URL must set sslmode=verify-full")
        if target.get("host") not in allowed_hosts:
            problems.append("the URL host must equal BILLIE_DB_HOST" if migration
                            else "the URL host must be BILLIE_DB_HOST or its -pooler form")
    elif environment == "local":
        if os.getenv("RENDER") == "true":
            problems.append("BILLIE_DB_ENV=local is refused on Render")
        if not (local_host(pinned_host) and target.get("host") == pinned_host):
            problems.append("BILLIE_DB_HOST must be a local host equal to the URL host")
    else:
        problems.append("BILLIE_DB_ENV must be production, staging or local")
    if not name:
        problems.append("BILLIE_DB_NAME is missing")
    elif target.get("dbname") != name:
        problems.append("the URL database must equal BILLIE_DB_NAME")
    if not target.get("user"):
        problems.append("the URL has no user")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{12,128}", identity):
        problems.append("BILLIE_DB_TARGET_ID must be 12-128 letters, digits, _ or -")
    if problems:
        raise RuntimeError("PostgreSQL URL does not match the approved database target: " + "; ".join(problems))
    return target


def verify_target(conn: psycopg.Connection, target: dict[str, str], *, migration: bool) -> None:
    actual = conn.execute("""
        SELECT current_database() AS database_name, current_user AS database_role,
               target_id, environment
        FROM billie_release.target
        WHERE singleton
    """).fetchone()
    if actual is None or tuple(actual.values()) != (
        target["dbname"], target["user"], os.environ["BILLIE_DB_TARGET_ID"], os.environ["BILLIE_DB_ENV"]
    ):
        raise RuntimeError("Connected PostgreSQL server did not confirm the approved database target")
    if migration:
        return
    row = conn.execute("""
        SELECT has_database_privilege(current_database(), 'CREATE')
          OR has_table_privilege('billie_release.target', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
          OR has_any_column_privilege('billie_release.target', 'INSERT, UPDATE')
          OR EXISTS (
            SELECT 1 FROM pg_roles r
            WHERE (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
              AND pg_has_role(current_user, r.oid, 'MEMBER')
          )
          OR EXISTS (
            SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public', 'identity', 'billie_release')
              AND (has_schema_privilege(n.oid, 'CREATE') OR pg_has_role(current_user, n.nspowner, 'MEMBER'))
          )
          OR EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'identity', 'billie_release') AND pg_has_role(current_user, c.relowner, 'MEMBER')
          ) AS writable_schema
    """).fetchone()
    if row is None or row["writable_schema"]:
        raise RuntimeError("Runtime database role has schema or target-marker write privileges")
