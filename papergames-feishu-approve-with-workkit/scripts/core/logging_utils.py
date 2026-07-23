"""Logging + lightweight utility helpers used throughout the skill.

  * `AuthorizationRequiredError` — raised when approval scope auth is missing
  * `log_debug_event` — structured stderr + operate_log.jsonl logging
  * `preview_text` — bounded text preview for logs
  * `extract_json_object` — best-effort JSON extraction from subprocess output
  * `require_command` — fail fast if a CLI binary is missing
  * Post-install hint state management + one-shot printer
"""

from __future__ import annotations

import json
import shutil
import sys
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List

from skill_version import SKILL_VERSION

from core.constants import (
    LOG_PREVIEW_MAX,
    POST_INSTALL_HINT_MESSAGE,
    post_install_hint_ttl_seconds,
)
from core import cache_store
from core.env import operate_log_path, post_install_hint_state_path


_POST_INSTALL_HINT_LOCK = threading.Lock()


class AuthorizationRequiredError(RuntimeError):
    """Raised when approval user authorization is missing or expired."""


def log_debug_event(event: str, **fields: Any) -> None:
    """Emit structured debug logs to stderr and the runtime log for troubleshooting."""
    payload = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "event": event,
    }
    payload.update(fields)
    line = json.dumps(payload, ensure_ascii=False, default=str)
    try:
        with open(operate_log_path(), "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
    print(line, file=sys.stderr, flush=True)


def preview_text(text: str, limit: int = LOG_PREVIEW_MAX) -> str:
    raw = (text or "").strip()
    if len(raw) <= limit:
        return raw
    return raw[:limit] + "...(truncated)"


def extract_json_object(text: str) -> Dict[str, Any] | None:
    """Best-effort parse a JSON object out of a subprocess stdout / stderr blob.

    Tries the whole stripped text first, then each non-empty line from the end
    (lark-cli often emits the JSON payload last), then the substring between
    the first `{` and last `}`. Returns None if nothing parses to a dict.
    """

    raw = (text or "").strip()
    if not raw:
        return None
    candidates: List[str] = [raw]
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    candidates.extend(reversed(lines))
    if "{" in raw and "}" in raw:
        candidates.append(raw[raw.find("{") : raw.rfind("}") + 1])
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def require_command(name: str) -> None:
    """Fail fast with a clear message if a required binary is missing."""
    if shutil.which(name):
        return
    raise RuntimeError(f"缺少依赖命令: {name}")


def _load_post_install_hint_state() -> Dict[str, Any]:
    try:
        path = post_install_hint_state_path()
    except Exception:
        return {}
    # 超过 TTL（默认 1 天）的提示状态视为不存在并惰性删除，到期后会再次提示一次。
    return cache_store.load_fresh_json(path, post_install_hint_ttl_seconds())


def _post_install_hint_already_printed(*, version: str = SKILL_VERSION) -> bool:
    state = _load_post_install_hint_state()
    return str(state.get("version") or "").strip() == str(version or "").strip()


def _mark_post_install_hint_printed(*, version: str = SKILL_VERSION) -> None:
    path = post_install_hint_state_path()
    payload = {
        "version": str(version or "").strip(),
        "updated_at": cache_store.now_iso(),
    }
    # write_json_atomic 会自动盖 saved_at / saved_at_epoch，供 load 时按 TTL 判断过期。
    cache_store.write_json_atomic(path, payload)


def print_post_install_hint_once(*, out=None) -> bool:
    writer = out or sys.stderr
    with _POST_INSTALL_HINT_LOCK:
        if _post_install_hint_already_printed():
            return False
        print(POST_INSTALL_HINT_MESSAGE, file=writer)
        try:
            _mark_post_install_hint_printed()
        except OSError:
            pass
        return True


__all__ = [
    "AuthorizationRequiredError",
    "extract_json_object",
    "log_debug_event",
    "preview_text",
    "print_post_install_hint_once",
    "require_command",
]
