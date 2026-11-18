"""Random secrets, verification codes and their keyed digests.

Only HMAC-SHA256 digests are stored; a database read alone cannot confirm a registration,
finish a Google sign-up, or replay an OAuth state.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

CODE_DIGITS = 8
_VERIFIER = re.compile(r"\A[A-Za-z0-9\-._~]{43,128}\Z")


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def new_code() -> str:
    return f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"


def normalize_code(value: object) -> str:
    return re.sub(r"[\s\-]", "", str(value or ""))


def digest(key: bytes, purpose: str, value: str) -> str:
    return hmac.new(key, f"{purpose}\x00{value}".encode(), hashlib.sha256).hexdigest()


def matches(expected_digest: str, key: bytes, purpose: str, value: str) -> bool:
    return hmac.compare_digest(expected_digest, digest(key, purpose, value))


def valid_verifier(value: object) -> bool:
    return isinstance(value, str) and bool(_VERIFIER.match(value))


def s256(verifier: str) -> str:
    """RFC 7636 S256 code challenge."""
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")


def valid_challenge(value: object) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9\-_]{43}", value))


def new_verifier() -> str:
    return secrets.token_urlsafe(48)
