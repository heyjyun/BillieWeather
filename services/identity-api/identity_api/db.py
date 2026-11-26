"""Database access: one psycopg 3 connection pool, explicit transactions, plain SQL.

`prepare_threshold=None` keeps the connections safe behind Neon's PgBouncer pooler.
"""
from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .database_target import local_target, release_target, verify_development, verify_target


class Database:
    def __init__(self, url: str, max_size: int = 5, *, environment: str = "test", env: Mapping[str, str] | None = None):
        configure = None
        if environment == "production":
            target = release_target(url, migration=False)

            def configure(conn: psycopg.Connection) -> None:
                verify_target(conn, target, migration=False)
        else:
            development = local_target(url, environment, env)
            if development is not None:
                def configure(conn: psycopg.Connection) -> None:
                    verify_development(conn, development)
        self.pool = ConnectionPool(
            url,
            min_size=0,
            max_size=max_size,
            kwargs={"autocommit": True, "prepare_threshold": None, "row_factory": dict_row, "application_name": "billieweather-identity-api"},
            configure=configure,
            open=False,
        )

    def open(self) -> None:
        self.pool.open(wait=False)

    def close(self) -> None:
        self.pool.close()

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Connection]:
        """One transaction: committed when the block succeeds, rolled back on any exception."""
        with self.pool.connection() as conn:
            with conn.transaction():
                yield conn
