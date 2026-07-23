"""Runtime environment + path resolution.

Pure detection / filesystem helpers shared across the skill:

  * `get_skill_root` — directory of this checkout
  * `find_openclaw_json_path` + `_read_openclaw_json` — OpenClaw config discovery
  * `get_runtime_dir`, `operate_log_path`, `post_install_hint_state_path` — runtime paths
  * `is_openclaw_runtime`, `is_feishu_bot_dialogue` — environment probes
  * `callback_listener_managed_externally`, `ensure_callback_listener_started` — legacy compat

No dependency on logging, network, or other skill modules.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Tuple

from core.constants import OPERATE_LOG_FILENAME, POST_INSTALL_HINT_STATE_FILENAME


def get_skill_root() -> str:
    # scripts/core/env.py → scripts/ → skill root
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _expand_cfg_str(value: object) -> str:
    return os.path.expandvars(str(value or "").strip())


def find_openclaw_json_path() -> str:
    raw = (os.getenv("OPENCLAW_CONFIG_PATH") or "").strip()
    if raw:
        candidate = Path(raw).expanduser()
        if candidate.is_file():
            return str(candidate)
        raise RuntimeError(f"OPENCLAW_CONFIG_PATH 已设置但文件不存在: {candidate}")

    candidates = [Path.home() / ".openclaw" / "openclaw.json"]
    skill_root = Path(get_skill_root()).resolve()
    candidates.extend(parent / "openclaw.json" for parent in (skill_root, *skill_root.parents))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return ""


def _read_openclaw_json() -> Tuple[Dict[str, Any], str]:
    path = find_openclaw_json_path()
    if not path:
        return {}, ""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle), path
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"openclaw.json 不是合法 JSON: {path}") from exc


def get_runtime_dir() -> str:
    explicit = (os.getenv("PAPER_FEISHU_APPROVE_RUNTIME_DIR") or "").strip()
    if explicit:
        runtime_dir = str(Path(explicit).expanduser())
        os.makedirs(runtime_dir, exist_ok=True)
        return runtime_dir

    skill_name = os.path.basename(get_skill_root())
    candidates: list[Path] = []
    if openclaw_path := find_openclaw_json_path():
        candidates.append(Path(openclaw_path).resolve().parent / "runtime" / "skills" / skill_name)
    candidates.append(Path.home() / ".openclaw" / "runtime" / "skills" / skill_name)
    candidates.append(Path(tempfile.gettempdir()) / "openclaw-runtime" / "skills" / skill_name)

    last_error: OSError | None = None
    for candidate in candidates:
        runtime_dir = str(candidate)
        try:
            os.makedirs(runtime_dir, exist_ok=True)
            return runtime_dir
        except OSError as exc:
            last_error = exc
            continue

    if last_error is not None:
        raise last_error
    raise RuntimeError("无法创建 skill runtime 目录")


def operate_log_path() -> str:
    return os.path.join(get_runtime_dir(), OPERATE_LOG_FILENAME)


def post_install_hint_state_path() -> str:
    return os.path.join(get_runtime_dir(), POST_INSTALL_HINT_STATE_FILENAME)


def is_openclaw_runtime() -> bool:
    """Best-effort detection for OpenClaw-managed Feishu callback runtime."""
    return any(
        (os.getenv(key, "") or "").strip()
        for key in (
            "OPENCLAW_SENDER_ID",
            "OPENCLAW_CHAT_ID",
            "OPENCLAW_INBOUND_CHAT_ID",
            "OPENCLAW_RECEIVE_ID_TYPE",
            "OPENCLAW_CONFIG_PATH",
        )
    )


def is_feishu_bot_dialogue() -> bool:
    """Best-effort detection for Feishu bot chat runtime."""
    return any(
        (os.getenv(key, "") or "").strip()
        for key in (
            "OPENCLAW_SENDER_ID",
            "OPENCLAW_CHAT_ID",
            "OPENCLAW_INBOUND_CHAT_ID",
            "SENDER_ID",
            "CHAT_ID",
        )
    )


def callback_listener_managed_externally() -> bool:
    """Compatibility helper: callback handling is always delegated to OpenClaw."""
    return True


def ensure_callback_listener_started(*, wait_until_ready: bool = False) -> Dict[str, Any]:
    """Compatibility no-op for legacy callers after sidecar removal."""
    del wait_until_ready
    return {
        "started": False,
        "pid": 0,
        "ready": True,
        "managed_externally": True,
    }


__all__ = [
    "_expand_cfg_str",
    "_read_openclaw_json",
    "callback_listener_managed_externally",
    "ensure_callback_listener_started",
    "find_openclaw_json_path",
    "get_runtime_dir",
    "get_skill_root",
    "is_feishu_bot_dialogue",
    "is_openclaw_runtime",
    "operate_log_path",
    "post_install_hint_state_path",
]
