#!/usr/bin/env python3
"""Shared runtime helpers for the workkit-backed approval skill.

This module intentionally exposes only auth, logging, redaction, lark-cli
environment, and Feishu send/refresh helpers. Approval query, card rendering,
snapshot state, and actions live in ``vendor/workkit``.
"""

from __future__ import annotations

from typing import Any, Dict

from core.constants import (
    APPROVE_SCOPE,
    LOG_PREVIEW_MAX,
    MISSING_LARK_CLI_MESSAGE,
    OPENCLAW_INTERACTIVE_NAMESPACE,
    POST_INSTALL_HINT_MESSAGE,
    READ_SCOPE,
    REDACTED,
)
from core.env import (
    get_runtime_dir,
    get_skill_root,
    is_feishu_bot_dialogue,
    is_openclaw_runtime,
    operate_log_path,
    post_install_hint_state_path,
)
from core.feishu_api import (
    _auth_status_is_user_valid,
    normalize_interactive_message_response,
    patch_message_card,
    refresh_card,
    resolve_receive_target,
    send_interactive_message,
    send_text_message,
)
from core.feishu_app import (
    get_app_credentials,
    get_approval_app_id,
    get_current_app_id,
    get_tenant_access_token,
    run_json_command,
)
from core.lark_env import (
    ensure_lark_cli_environment,
    ensure_lark_cli_installed,
    get_lark_profile_name,
    resolve_lark_cli_config_dir,
)
from core.logging_utils import (
    AuthorizationRequiredError,
    extract_json_object,
    log_debug_event,
    preview_text,
    print_post_install_hint_once,
    require_command,
)
from core.redaction import extract_auth_url, redact_sensitive_fields


def build_result_card_send_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return the inline Feishu card JSON that should be sent as content.

    workkit renders schema 2.0 inline cards as ``{"type":"inline_v2",
    "data":{"card": ...}}``. Legacy template-card support has been removed
    from the skill wrapper.
    """
    if not isinstance(payload, dict):
        return {}
    if str(payload.get("type") or "").strip() == "inline_v2":
        data = payload.get("data")
        if isinstance(data, dict) and isinstance(data.get("card"), dict):
            return data["card"]
    return payload


__all__ = [
    "APPROVE_SCOPE",
    "AuthorizationRequiredError",
    "LOG_PREVIEW_MAX",
    "MISSING_LARK_CLI_MESSAGE",
    "OPENCLAW_INTERACTIVE_NAMESPACE",
    "POST_INSTALL_HINT_MESSAGE",
    "READ_SCOPE",
    "REDACTED",
    "_auth_status_is_user_valid",
    "build_result_card_send_payload",
    "ensure_lark_cli_environment",
    "ensure_lark_cli_installed",
    "extract_auth_url",
    "extract_json_object",
    "get_app_credentials",
    "get_approval_app_id",
    "get_current_app_id",
    "get_lark_profile_name",
    "get_runtime_dir",
    "get_skill_root",
    "get_tenant_access_token",
    "is_feishu_bot_dialogue",
    "is_openclaw_runtime",
    "log_debug_event",
    "normalize_interactive_message_response",
    "operate_log_path",
    "patch_message_card",
    "post_install_hint_state_path",
    "preview_text",
    "print_post_install_hint_once",
    "redact_sensitive_fields",
    "refresh_card",
    "require_command",
    "resolve_lark_cli_config_dir",
    "resolve_receive_target",
    "run_json_command",
    "send_interactive_message",
    "send_text_message",
]
