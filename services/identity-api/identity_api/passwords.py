"""Devise-compatible password hashing and the Have I Been Pwned check.

Devise (database_authenticatable) stores BCrypt::Password.create(password, cost: stretches) with
no pepper in this app: "$2a$11$...". Ruby's bcrypt gem and Python's bcrypt both use only the first
72 bytes; Python's bcrypt 5 raises instead of truncating, so truncation is explicit here.
Cross-verified with Ruby's BCrypt in tests/test_compat.py.
"""
from __future__ import annotations

import hashlib
import logging

import bcrypt
import httpx

BCRYPT_MAX_BYTES = 72
log = logging.getLogger("identity_api.passwords")


def _secret(password: str) -> bytes:
    return password.encode("utf-8")[:BCRYPT_MAX_BYTES]


def hash_password(password: str, cost: int) -> str:
    return bcrypt.hashpw(_secret(password), bcrypt.gensalt(rounds=cost, prefix=b"2a")).decode("ascii")


def verify_password(password: str, encrypted: str | None) -> bool:
    if not encrypted:
        return False
    try:
        return bcrypt.checkpw(_secret(password), encrypted.encode("ascii"))
    except ValueError:
        return False


# A fixed hash used to spend the same time when there is no account to check against.
_DUMMY_HASH: str | None = None


def burn_time(password: str, cost: int) -> None:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password("timing-equalizer", cost)
    verify_password(password, _DUMMY_HASH)


class PwnedChecker:
    """k-anonymity range query (only the first 5 hex chars of the SHA-1 leave the server).

    Same policy as devise-pwned_password: reject when the password appears at least once, and
    fail open when the API is unreachable, so sign-up does not depend on a third party.
    """

    URL = "https://api.pwnedpasswords.com/range/{prefix}"

    def __init__(self, enabled: bool, client: httpx.Client | None = None, timeout: float = 5.0):
        self.enabled = enabled
        self.client = client or httpx.Client(timeout=timeout, headers={"User-Agent": "billieweather-identity-api", "Add-Padding": "true"})

    def is_pwned(self, password: str) -> bool:
        if not self.enabled:
            return False
        digest = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()  # noqa: S324 - required by the HIBP API
        prefix, suffix = digest[:5], digest[5:]
        try:
            response = self.client.get(self.URL.format(prefix=prefix))
            response.raise_for_status()
        except httpx.HTTPError:
            log.warning("pwned_password_check_unavailable")
            return False
        for line in response.text.splitlines():
            candidate, _, count = line.partition(":")
            if candidate.strip().upper() == suffix:
                try:
                    return int(count.strip()) >= 1
                except ValueError:
                    return False
        return False
