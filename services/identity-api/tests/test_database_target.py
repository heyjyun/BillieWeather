import pytest

from identity_api.database_target import PRODUCTION_ENDPOINTS, local_target, release_target, verify_development, verify_target

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


def test_refused_release_target_names_what_is_wrong_without_values(monkeypatch):
    for key in ("BILLIE_DB_ENV", "BILLIE_DB_HOST", "BILLIE_DB_NAME", "BILLIE_DB_TARGET_ID"):
        monkeypatch.delenv(key, raising=False)
    url = "postgresql://runtime@ep-synthetic-pooler.us-east-2.aws.neon.tech/finance?sslmode=require"
    with pytest.raises(RuntimeError) as refused:
        release_target(url, migration=False)
    message = str(refused.value)
    for text in ("approved database target", "BILLIE_DB_ENV must be", "BILLIE_DB_NAME is missing", "BILLIE_DB_TARGET_ID must be"):
        assert text in message
    for value in ("ep-synthetic", "finance", "runtime"):
        assert value not in message
    monkeypatch.setenv("BILLIE_DB_ENV", "staging")
    monkeypatch.setenv("BILLIE_DB_HOST", ENDPOINT)
    monkeypatch.setenv("BILLIE_DB_NAME", "finance")
    monkeypatch.setenv("BILLIE_DB_TARGET_ID", "synthetic_target_51")
    with pytest.raises(RuntimeError, match="sslmode=verify-full"):
        release_target(url, migration=False)
    with pytest.raises(RuntimeError, match="must equal BILLIE_DB_HOST"):
        release_target(POOLED, migration=True)


DEV_HOST = "ep-devsynthetic.us-east-2.aws.neon.tech"
DEV_POOLED = f"postgresql://dev@ep-devsynthetic-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full"
PROD_HOST = f"{PRODUCTION_ENDPOINTS[0]}.c-8.us-east-2.aws.neon.tech"
DEV_ENV = {"BILLIE_DB_ENV": "development", "BILLIE_DB_HOST": DEV_HOST, "BILLIE_DB_NAME": "neondb",
           "BILLIE_DB_TARGET_ID": "synthetic_dev_target"}


def test_development_may_use_the_pinned_neon_development_branch():
    assert local_target(DEV_POOLED, "development", DEV_ENV) == {"environment": "development", "target_id": "synthetic_dev_target"}
    assert local_target(DEV_POOLED.replace("-pooler", ""), "development", DEV_ENV)["target_id"] == "synthetic_dev_target"
    for invalid in (DEV_POOLED.replace("ep-devsynthetic", "ep-other"), DEV_POOLED.replace("verify-full", "require"),
                    DEV_POOLED.replace("/neondb", "/other")):
        with pytest.raises(RuntimeError, match="development target"):
            local_target(invalid, "development", DEV_ENV)
    with pytest.raises(RuntimeError, match="non-local"):
        local_target(DEV_POOLED, "test", DEV_ENV)


@pytest.mark.parametrize("url", [
    f"postgresql://owner@{PROD_HOST}/neondb?sslmode=verify-full",
    f"postgresql://owner@{PROD_HOST.replace('.c-8', '-pooler.c-8')}/neondb?sslmode=verify-full",
])
@pytest.mark.parametrize("environment", ["development", "test"])
def test_development_and_tests_refuse_the_production_endpoint(url, environment):
    with pytest.raises(RuntimeError, match="production database"):
        local_target(url, environment, {**DEV_ENV, "BILLIE_DB_HOST": PROD_HOST})
    with pytest.raises(RuntimeError, match="production database"):
        local_target(url, environment, DEV_ENV)
    with pytest.raises(RuntimeError, match="production database"):
        local_target(DEV_POOLED, environment, {**DEV_ENV, "BILLIE_PRODUCTION_DB_ENDPOINTS": "ep-devsynthetic"})


def test_development_connection_requires_the_development_marker(sql):
    target = {"environment": "development", "target_id": "synthetic_dev_target"}
    with sql.transaction(force_rollback=True):
        sql.execute("CREATE SCHEMA billie_release")
        sql.execute("CREATE TABLE billie_release.target (singleton boolean, environment text, target_id text)")
        sql.execute("INSERT INTO billie_release.target VALUES (true, 'development', 'synthetic_dev_target')")
        verify_development(sql, target)
        sql.execute("UPDATE billie_release.target SET environment = 'production'")
        with pytest.raises(RuntimeError, match="did not confirm the approved development database"):
            verify_development(sql, target)
