#!/usr/bin/env python3
"""Version metadata for the papergames-feishu-approve skill."""

from __future__ import annotations

import re
from pathlib import Path

SKILL_VERSION = "0.1.8"
_VERSION_LINE = re.compile(r'^(SKILL_VERSION\s*=\s*")([^"]+)(")', re.MULTILINE)


def bump_skill_version() -> str:
    """Increment patch version, persist to this file, and return the new value."""
    global SKILL_VERSION
    prefix, patch = SKILL_VERSION.rsplit(".", 1)
    if not patch.isdigit():
        raise ValueError(f"无法递增版本号: {SKILL_VERSION}")
    new_version = f"{prefix}.{int(patch) + 1}"
    path = Path(__file__).resolve()
    text = path.read_text(encoding="utf-8")
    if not _VERSION_LINE.search(text):
        raise ValueError(f"无法在 {path} 中定位 SKILL_VERSION")
    path.write_text(
        _VERSION_LINE.sub(rf"\g<1>{new_version}\3", text, count=1),
        encoding="utf-8",
    )
    SKILL_VERSION = new_version
    return new_version
