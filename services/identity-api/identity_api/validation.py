"""Server-side validation that matches (or is stricter than) the Rails User model and Devise.

Rails rules reproduced here:
- Devise: email stripped + downcased, regex /\\A[^@\\s]+@[^@\\s]+\\z/, unique; password 6..128 chars,
  confirmation must match.
- User: nickname squished, required, at most 40 chars, at least one visible character (letter, mark,
  number, punctuation or symbol; any script), no control characters; usage_region required and in
  UsageRegion::CODES. Same rules as User::NICKNAME_* in app/models/user.rb and
  clients/universal/src/services/profile.ts.
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


def normalize_nickname(value: object) -> str | None:
    """Squished like Rails; None when nothing visible is left (blank, whitespace or invisible format characters only)."""
    nick = squish(value)
    if nick is None or not any(unicodedata.category(ch)[0] in "LMNPS" for ch in nick):
        return None
    return nick


def nickname_errors(nick: str | None) -> list[str]:
    if nick is None:
        return ["blank"]
    if len(nick) > NICKNAME_MAX:
        return ["too_long"]
    if any(unicodedata.category(ch) == "Cc" for ch in nick):
        return ["invalid"]
    return []


def validate_profile(nickname: object, usage_region: object) -> tuple[str | None, str, dict[str, list[str]]]:
    errors: dict[str, list[str]] = {}
    if nickname is not None and not isinstance(nickname, str):
        nick, problems = None, ["invalid"]
    else:
        nick = normalize_nickname(nickname)
        problems = nickname_errors(nick)
    if problems:
        errors["nickname"] = problems
    region = normalize_region(usage_region)
    if problems := region_errors(region):
        errors["usage_region"] = problems
    return nick, region or "", errors
