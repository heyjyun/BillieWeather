"""Production refuses to start with unsafe settings; nothing secret is hardcoded."""
from pathlib import Path

import pytest

from identity_api.config import Settings

SAFE = dict(identity_env="production", database_url="postgresql://x/y", public_url="https://identity.example.com",
            cors_allowed_origins="tauri://localhost,http://tauri.localhost", token_hmac_key="k" * 64,
            mail_delivery="postmark", postmark_api_token="token", mail_from="BillieWeather <hi@example.com>")


def test_safe_production_settings_pass():
    Settings(**SAFE).validate_for_runtime()


@pytest.mark.parametrize("change", [
    {"public_url": "http://identity.example.com"},
    {"token_hmac_key": ""},
    {"cors_allowed_origins": "*"},
    {"cors_allowed_origins": "tauri://localhost,http://localhost:1420"},
    {"mail_delivery": "outbox"},
    {"bcrypt_cost": 10},
])
def test_unsafe_production_settings_are_refused(change):
    with pytest.raises(RuntimeError, match="Unsafe identity-api configuration"):
        Settings(**{**SAFE, **change}).validate_for_runtime()


def test_secrets_are_not_in_reprs_or_source():
    text = repr(Settings(**SAFE))
    assert "k" * 64 not in text and "token" not in text.replace("token_hmac_key", "")
    for path in Path(__file__).parents[1].joinpath("identity_api").rglob("*.py"):
        source = path.read_text()
        assert "neon.tech" not in source and "onrender.com" not in source and "sk-" not in source, path


def test_development_real_email_must_be_fully_configured():
    dev = dict(identity_env="development", database_url="postgresql://x/y", mail_delivery="postmark")
    with pytest.raises(RuntimeError, match="MAIL_DELIVERY=postmark needs"):
        Settings(**dev).validate_for_runtime()
    Settings(**dev, postmark_api_token="token", mail_from="BillieWeather <hi@example.com>").validate_for_runtime()
