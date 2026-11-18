"""Logging that cannot leak credentials: a redaction filter on every record, request logs with
the route template only (never query strings: the Google callback carries `code` and `state`),
and uvicorn's access log disabled."""
from __future__ import annotations

import logging
import re

_PATTERNS = [
    (re.compile(r"[^\s@\"'<>]+@[^\s@\"'<>]+\.[^\s@\"'<>]+"), "[email]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/=]+"), r"\1[redacted]"),
    (re.compile(r"(?i)\b(password|secret|token|code|state|verifier)=([^&\s]+)"), r"\1=[redacted]"),
    (re.compile(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}"), "[bcrypt]"),
    (re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"), "[token]"),
]


def redact(text: str) -> str:
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        record.msg = redact(message)
        record.args = None
        return True


def configure(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request lines include URLs
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    access = logging.getLogger("uvicorn.access")
    access.handlers[:] = []
    access.propagate = False
    access.disabled = True
