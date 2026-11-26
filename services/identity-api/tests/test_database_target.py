import pytest

from identity_api.database_target import local_target, release_target, verify_target

ENDPOINT = "ep-synthetic.us-east-2.aws.neon.tech"
DIRECT = f"postgresql://identity@{ENDPOINT}/finance?sslmode=verify-full"
POOLED = DIRECT.replace("ep-synthetic.", "ep-synthetic-pooler.")


def test_local_database_cannot_use_neon_or_a_libpq_override(monkeypatch):
    with pytest.raises(RuntimeError, match="non-local"):
        local_target(DIRECT, "development")
    monkeypatch.setenv("PGHOSTADDR", "192.0.2.4")
    with pytest.raises(RuntimeError, match="override"):
        local_target("postgresql://localhost/finance_test", "test")


def test_release_target_matches_direct_host_and_requires_verified_tls(monkeypatch):
    monkeypatch.setenv("BILLIE_DB_ENV", "staging")
    monkeypatch.setenv("BILLIE_DB_HOST", ENDPOINT)
    monkeypatch.setenv("BILLIE_DB_NAME", "finance")
    monkeypatch.setenv("BILLIE_DB_TARGET_ID", "synthetic_target_51")
    assert release_target(DIRECT, migration=True)["host"] == ENDPOINT
    assert "-pooler." in release_target(POOLED, migration=False)["host"]

    for invalid in (POOLED, DIRECT.replace("ep-synthetic", "ep-other"), DIRECT.replace("verify-full", "require"),
                    DIRECT + "&options=-c%20billie.target_id%3Dsynthetic", DIRECT + "&hostaddr=192.0.2.4"):
        with pytest.raises(RuntimeError):
            release_target(invalid, migration=True)


def test_verified_target_comes_from_database_marker(sql, monkeypatch):
    monkeypatch.setenv("BILLIE_DB_ENV", "staging")
    monkeypatch.setenv("BILLIE_DB_TARGET_ID", "synthetic_target_51")
    with sql.transaction(force_rollback=True):
        sql.execute("CREATE SCHEMA billie_release")
        sql.execute("CREATE TABLE billie_release.target (singleton boolean, target_id text, environment text)")
        sql.execute("INSERT INTO billie_release.target VALUES (true, 'synthetic_target_51', 'staging')")
        connection = sql.execute("SELECT current_database() AS dbname, current_user AS user").fetchone()
        verify_target(sql, connection, migration=True)
        sql.execute("UPDATE billie_release.target SET target_id = 'wrong_target_51'")
        sql.execute("SET LOCAL billie.target_id = 'synthetic_target_51'")
        with pytest.raises(RuntimeError, match="did not confirm the approved database target"):
            verify_target(sql, connection, migration=True)
