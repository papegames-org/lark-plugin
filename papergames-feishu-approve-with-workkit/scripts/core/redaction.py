"""Recursive redaction of runtime IDs and detail URLs from log/preview payloads."""

from __future__ import annotations

from typing import Any

from core.constants import REDACTED, SENSITIVE_KEYS, SENSITIVE_URL_KEYS


def redact_sensitive_fields(value: Any) -> Any:
    """Recursively redact runtime IDs and direct detail links."""
    if isinstance(value, dict):
        redacted: dict = {}
        for key, item in value.items():
            if key in SENSITIVE_KEYS or key in SENSITIVE_URL_KEYS:
                redacted[key] = REDACTED
            else:
                redacted[key] = redact_sensitive_fields(item)
        return redacted
    if isinstance(value, list):
        return [redact_sensitive_fields(item) for item in value]
    return value


def extract_auth_url(text: str) -> str:
    """Extract the first https auth URL from lark-cli output."""
    import re
    match = re.search(r"https://[^\s\"']+", text or "")
    return match.group(0) if match else ""


__all__ = ["redact_sensitive_fields", "extract_auth_url"]
