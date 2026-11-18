"""Server-side validation that matches (or is stricter than) the Rails User model and Devise.

Rails rules reproduced here:
- Devise: email stripped + downcased, regex /\\A[^@\\s]+@[^@\\s]+\\z/, unique; password 6..128 chars,
  confirmation must match.
- User: nickname squished, at most 40 chars; usage_region required and in UsageRegion::CODES;
  the Example Account address (example@example.com) is reserved.
Stricter here: emails are at most 254 chars and may not contain control characters.
"""
from __future__ import annotations

import re
import unicodedata

from .regions import CODES

PASSWORD_MIN = 6
PASSWORD_MAX = 128
NICKNAME_MAX = 40
EMAIL_MAX = 254
LOCALES = ("en", "zh-CN", "zh-TW", "ja", "ko", "es")
RESERVED_EMAILS = frozenset({"example@example.com"})

# Ruby's \s is ASCII-only: [ \t\r\n\f\v]. Python's \s is Unicode-aware, so spell it out.
_RUBY_SPACE = " \t\r\n\f\v"
_EMAIL = re.compile(rf"\A[^@{_RUBY_SPACE}]+@[^@{_RUBY_SPACE}]+\Z")


class ValidationFailed(Exception):
    def __init__(self, fields: dict[str, list[str]]):
        super().__init__("validation failed")
        self.fields = fields


def normalize_email(value: object) -> str:
    """Devise's strip_whitespace_keys + case_insensitive_keys (Ruby String#strip, then downcase)."""
    return str(value or "").strip(_RUBY_SPACE + "\0").lower()


def email_errors(email: str) -> list[str]:
    if not email:
        return ["blank"]
    if len(email) > EMAIL_MAX or any(unicodedata.category(ch) == "Cc" for ch in email) or not _EMAIL.match(email):
        return ["invalid"]
    if email in RESERVED_EMAILS:
        return ["reserved"]
    return []


def password_errors(password: str, confirmation: str | None) -> dict[str, list[str]]:
    errors: dict[str, list[str]] = {}
    if not password:
        errors["password"] = ["blank"]
    elif len(password) < PASSWORD_MIN:
        errors["password"] = ["too_short"]
    elif len(password) > PASSWORD_MAX:
        errors["password"] = ["too_long"]
    if confirmation is not None and confirmation != password:
        errors["password_confirmation"] = ["mismatch"]
    return errors


def squish(value: object) -> str | None:
    """Rails String#squish + presence."""
    text = " ".join(str(value or "").split())
    return text or None


def normalize_region(value: object) -> str | None:
    return str(value or "").strip().upper() or None


def region_errors(region: str | None) -> list[str]:
    if region is None:
        return ["blank"]
    return [] if region in CODES else ["inclusion"]


def normalize_locale(value: object) -> str | None:
    text = str(value or "").strip()
    return text if text in LOCALES else None


def validate_profile(nickname: object, usage_region: object) -> tuple[str | None, str, dict[str, list[str]]]:
    errors: dict[str, list[str]] = {}
    nick = squish(nickname)
    if nick is not None and (len(nick) > NICKNAME_MAX or any(unicodedata.category(ch) == "Cc" for ch in nick)):
        errors["nickname"] = ["too_long" if len(nick) > NICKNAME_MAX else "invalid"]
    region = normalize_region(usage_region)
    if problems := region_errors(region):
        errors["usage_region"] = problems
    return nick, region or "", errors
