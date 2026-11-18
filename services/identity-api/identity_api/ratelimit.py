"""In-process sliding-window rate limits (per IP and per email).

Per-registration limits (resend spacing, code attempts) are stored in the database and hold
across instances; these in-memory windows are a first line of defense for one instance. Running
more than one instance needs a shared store (see README: "Scaling").
"""
from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class Limit:
    name: str
    count: int
    seconds: int


LIMITS = {
    "register_ip": Limit("register_ip", 10, 600),
    "register_email": Limit("register_email", 5, 3600),
    "confirm_ip": Limit("confirm_ip", 30, 600),
    "resend_ip": Limit("resend_ip", 10, 600),
    "google_start_ip": Limit("google_start_ip", 20, 600),
    "google_poll_ip": Limit("google_poll_ip", 600, 600),
    "google_finish_ip": Limit("google_finish_ip", 20, 600),
}


class RateLimited(Exception):
    def __init__(self, retry_after: int):
        super().__init__("rate limited")
        self.retry_after = max(1, int(retry_after))


class RateLimiter:
    def __init__(self, clock=time.monotonic):  # noqa: ANN001
        self._clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, limit_name: str, key: str) -> None:
        limit = LIMITS[limit_name]
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault((limit_name, key), deque())
            while hits and hits[0] <= now - limit.seconds:
                hits.popleft()
            if len(hits) >= limit.count:
                raise RateLimited(hits[0] + limit.seconds - now)
            hits.append(now)
            if len(self._hits) > 50_000:  # bound memory under abuse
                self._prune(now)

    def _prune(self, now: float) -> None:
        longest = max(limit.seconds for limit in LIMITS.values())
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= now - longest]:
            del self._hits[key]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
