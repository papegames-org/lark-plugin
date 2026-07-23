#!/usr/bin/env python3
"""High-level auth convenience wrappers used by multiple entrypoints.

These combine low-level ``core.auth`` primitives (check / spawn) with
receive-target resolution and error-emission conventions so that
entrypoints don't each reimplement the same pattern.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict

from core.auth import (
    AUTH_MODE_READ,
    AuthState,
    check_auth_valid,
    spawn_send_auth_and_wait,
)
from core.feishu_api import resolve_receive_target
from core.logging_utils import AuthorizationRequiredError, preview_text


# ---------------------------------------------------------------------------
# Receive-target helper
# ---------------------------------------------------------------------------

def history_receive_target(*, sender_id: str = "", chat_id: str = "") -> tuple[str, str]:
    """Resolve (receive_id, receive_id_type) for history/logging purposes.

    Returns ("", "") when neither sender_id nor chat_id is usable.
    """
    receive_id, receive_id_type = resolve_receive_target(
        sender_id=sender_id,
        chat_id=chat_id,
        receive_id_type="open_id" if (sender_id or "").strip() else "chat_id",
    )
    if receive_id:
        return receive_id, receive_id_type
    return "", ""


# ---------------------------------------------------------------------------
# Auth execution helpers
# ---------------------------------------------------------------------------

def run_send_auth_and_wait(
    *,
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "chat_id",
    auth_mode: str = AUTH_MODE_READ,
) -> Dict[str, Any]:
    """Spawn ``send_auth_and_wait`` and return payload dict, or raise on failure."""
    payload, result = spawn_send_auth_and_wait(
        sender_id=sender_id,
        chat_id=chat_id,
        receive_id_type=receive_id_type,
        auth_mode=auth_mode,
    )
    if payload is not None:
        return payload
    detail = (result.stderr or result.stdout or "").strip() or "审批授权脚本执行失败"
    raise RuntimeError(detail[:240])


def ensure_authorized(*, sender_id: str = "", chat_id: str = "") -> None:
    """Ensure the user has a valid auth state; attempt interactive login if not.

    Raises :class:`AuthorizationRequiredError` when authorization cannot be
    obtained.
    """
    receive_id, receive_id_type = resolve_receive_target(
        sender_id,
        chat_id,
        "open_id" if (sender_id or "").strip() else "chat_id",
    )
    auth_ok = check_auth_valid(silent=True, auto_configure=True)
    if auth_ok:
        return

    result = run_send_auth_and_wait(
        sender_id=receive_id if receive_id_type == "open_id" else "",
        chat_id=receive_id if receive_id_type != "open_id" else "",
        receive_id_type=receive_id_type,
        auth_mode=AUTH_MODE_READ,
    )
    if not bool(result.get("authorized")):
        raise AuthorizationRequiredError("approval authorization required")


# ---------------------------------------------------------------------------
# Error emission (used by query_approvals)
# ---------------------------------------------------------------------------

def emit_auth_state_failure(state: AuthState) -> None:
    """Print a structured auth-failure JSON to stderr."""
    message = preview_text(
        state.detail
        or (
            "当前 OpenClaw 环境下的 lark-cli 尚未绑定到当前上下文。"
            if state.status == "bind_required"
            else "当前 token 未具备本次审批操作所需 scope，或未登录。"
        ),
        limit=240,
    )
    print(
        json.dumps(
            {
                "status": state.status,
                "authorized": False,
                "required_scopes": list(state.required_scopes),
                "requested_scopes": list(state.requested_scopes),
                "message": message,
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
        flush=True,
    )
