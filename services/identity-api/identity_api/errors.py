"""API errors with stable machine-readable codes. Responses never echo submitted values."""
from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, *, fields: dict[str, list[str]] | None = None, **extra: object):
        super().__init__(code)
        self.status = status
        self.code = code
        self.fields = fields
        self.extra = extra

    def body(self) -> dict:
        body: dict = {"error": self.code}
        if self.fields:
            body["fields"] = self.fields
        body.update(self.extra)
        return body


def invalid(fields: dict[str, list[str]]) -> ApiError:
    return ApiError(422, "invalid", fields=fields)


NOT_FOUND = lambda: ApiError(404, "not_found")  # noqa: E731
