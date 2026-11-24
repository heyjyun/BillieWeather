import pytest

from identity_api.database_target import local_target, release_target

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
