"""User-facing errors.

Every error carries a stable `code` and `params`; the browser translates `err.<code>` into the
user's language and falls back to the English message.
"""
from __future__ import annotations


class AppError(Exception):
    def __init__(self, code: str, message: str, **params):
        super().__init__(message.format(**params) if params else message)
        self.code = code
        self.params = params

    def to_json(self) -> dict:
        return {"error": str(self), "code": self.code, "params": self.params}
