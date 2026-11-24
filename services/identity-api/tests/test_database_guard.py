import pytest

from conftest import _assert_local


@pytest.fixture(autouse=True)
def clear_pg_defaults(monkeypatch):
    for key in ("PGHOST", "PGHOSTADDR", "PGSERVICE"):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.parametrize("url", [
    "postgresql://localhost/billie_test",
    "postgresql:///billie_compat?host=/tmp/billie/socket",
])
def test_allows_local_test_targets(url):
    _assert_local(url)


@pytest.mark.parametrize("url", [
    "postgresql://localhost/billie_production",
    "postgresql://localhost/billie_test?host=example.invalid",
    "postgresql://localhost/billie_test?hostaddr=192.0.2.1",
    "postgresql://localhost/billie_test?service=remote",
    "postgresql:///billie_test?host=/tmp/billie/socket,example.invalid",
])
def test_refuses_unsafe_effective_targets(url):
    with pytest.raises(RuntimeError, match="outside a local"):
        _assert_local(url)


@pytest.mark.parametrize(("key", "value"), [("PGHOSTADDR", "192.0.2.1"), ("PGSERVICE", "remote")])
def test_refuses_unsafe_libpq_environment(monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(RuntimeError, match="outside a local"):
        _assert_local("postgresql://localhost/billie_test")
