#!/usr/bin/env python3
"""Launch and monitor lark-cli approval auth via an explicit scope-driven script flow."""

from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
import time
import traceback
import urllib.parse
from typing import Dict

from approval_auth import (
    AUTH_MODE_READ,
    AUTH_MODE_WRITE,
    OpenClawBindingRequiredError,
    check_auth_valid,
    required_scopes_for_mode,
    start_oauth_login_if_needed,
)
from common import (
    APPROVE_SCOPE,
    log_debug_event,
    normalize_interactive_message_response,
    operate_log_path,
    preview_text,
    refresh_card,
    resolve_receive_target,
    send_interactive_message,
)


AUTH_CARD_INIT_TITLE = "审批授权检查中"
AUTH_CARD_AUTH_TITLE = "请授权审批能力"
AUTH_CARD_SUCCESS_TITLE = "授权成功"
AUTH_CARD_PENDING_TEXT = "正在检查当前审批授权状态，请稍候。"
AUTH_CARD_FAILED_TITLE = "授权失败"
POST_EXIT_AUTH_RECHECK_ATTEMPTS = 5
POST_EXIT_AUTH_RECHECK_INTERVAL_SECONDS = 1


def _safe_operate_log_path() -> str:
    try:
        return operate_log_path()
    except Exception:
        return ""


def _auth_button_action(auth_url: str) -> Dict[str, object]:
    wrapped = (
        "https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url="
        + urllib.parse.quote(str(auth_url or "").strip(), safe="")
    )
    return {
        "tag": "action",
        "actions": [
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": "前往授权"},
                "type": "primary",
                "url": wrapped,
            }
        ],
    }


def _scope_list_for_display(
    required_scopes: list[str],
    requested_scopes: list[str] | None = None,
) -> list[str]:
    scopes = [str(scope or "").strip() for scope in (requested_scopes or []) if str(scope or "").strip()]
    return scopes or list(required_scopes)


def _build_scope_note(
    required_scopes: list[str],
    *,
    requested_scopes: list[str] | None = None,
) -> str:
    scopes = _scope_list_for_display(required_scopes, requested_scopes)
    prefix = "本次申请 scope：" if requested_scopes else "授权范围："
    return prefix + "、".join(scopes)


def _build_auth_card(
    auth_url: str,
    *,
    required_scopes: list[str],
    requested_scopes: list[str] | None = None,
) -> Dict[str, object]:
    needs_write = APPROVE_SCOPE in required_scopes
    content = (
        "需要先完成 `lark-cli` 用户授权，之后才能查询和处理审批。"
        if needs_write
        else "需要先完成 `lark-cli` 用户授权，之后才能查询审批。"
    )
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": AUTH_CARD_AUTH_TITLE},
            "template": "blue",
        },
        "elements": [
            {"tag": "markdown", "content": content},
            {
                "tag": "note",
                "elements": [
                    {
                        "tag": "plain_text",
                        "content": _build_scope_note(
                            required_scopes,
                            requested_scopes=requested_scopes,
                        ),
                    }
                ],
            },
            {
                "tag": "action",
                "actions": _auth_button_action(auth_url)["actions"],
            },
        ],
    }


def _build_status_card(title: str, template: str, content: str) -> Dict[str, object]:
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": template,
        },
        "elements": [{"tag": "markdown", "content": content}],
    }


def _refresh_auth_card(payload: Dict[str, object], *, message_id: str = "") -> None:
    """Auth status changes are proactive updates, so refresh via message_id only."""
    mid = (message_id or "").strip()
    if not mid:
        return
    refresh_card(payload, message_id=mid, card_token="")


def _confirm_auth_after_proc_exit(auth_mode: str) -> bool:
    for attempt in range(POST_EXIT_AUTH_RECHECK_ATTEMPTS):
        if check_auth_valid(auth_mode, silent=True, probe=False):
            return True
        if attempt < POST_EXIT_AUTH_RECHECK_ATTEMPTS - 1:
            time.sleep(POST_EXIT_AUTH_RECHECK_INTERVAL_SECONDS)
    return False


def _authorized_result(
    required_scopes: list[str],
    *,
    auth_mode: str,
    requested_scopes: list[str] | None = None,
    card_msg_id: str = "",
) -> Dict[str, object]:
    return {
        "status": "authorized",
        "authorized": True,
        "auth_mode": auth_mode,
        "required_scopes": required_scopes,
        "requested_scopes": list(requested_scopes or []),
        "card_msg_id": card_msg_id,
    }


def _unauthorized_result(
    status: str,
    required_scopes: list[str],
    *,
    auth_mode: str,
    requested_scopes: list[str] | None = None,
    card_msg_id: str = "",
) -> Dict[str, object]:
    return {
        "status": status,
        "authorized": False,
        "auth_mode": auth_mode,
        "required_scopes": required_scopes,
        "requested_scopes": list(requested_scopes or []),
        "card_msg_id": card_msg_id,
    }


def _success_text_for_scopes(required_scopes: list[str]) -> str:
    if APPROVE_SCOPE in required_scopes:
        return "授权完成，可以继续执行审批查询与通过/拒绝操作。"
    return "授权完成，可以继续执行审批查询。"


def _bind_required_text(detail: str = "") -> str:
    message = "当前 OpenClaw 环境下的 lark-cli 尚未绑定到当前上下文，暂时无法拉起审批授权。请先复用现有 profile / binding，确认环境绑定后重试。"
    extra = str(detail or "").strip()
    if extra and extra not in message:
        return f"{message}\n\n诊断信息：`{preview_text(extra, limit=160)}`"
    return message


def _send_status_card_best_effort(
    title: str,
    template: str,
    content: str,
    *,
    receive_id: str,
    receive_id_type: str,
) -> str:
    try:
        response = send_interactive_message(
            _build_status_card(title, template, content),
            receive_id=receive_id,
            receive_id_type=receive_id_type,
        )
    except Exception as exc:
        log_debug_event(
            "approval.send_auth_and_wait.status_card_failed",
            error_type=type(exc).__name__,
            error_message=preview_text(str(exc), limit=240),
            title=title,
        )
        return ""
    response = normalize_interactive_message_response(response) if isinstance(response, dict) else response
    if not isinstance(response, dict):
        return ""
    data = response.get("data", {})
    if not isinstance(data, dict):
        return ""
    return str(data.get("message_id") or "").strip()


def run_auth_flow(
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "chat_id",
    *,
    auth_mode: str = AUTH_MODE_READ,
    force_logout: bool = False,
) -> Dict[str, object]:
    required_scopes = required_scopes_for_mode(auth_mode)
    receive_id, resolved_type = resolve_receive_target(
        sender_id,
        chat_id,
        receive_id_type,
    )
    card_mode = bool((receive_id or "").strip())

    try:
        pending = start_oauth_login_if_needed(
            auth_mode=auth_mode,
            force_logout=force_logout,
            background_wait=card_mode,
        )
    except OpenClawBindingRequiredError as exc:
        detail = preview_text(str(exc), limit=240)
        log_debug_event(
            "approval.send_auth_and_wait.bind_required",
            auth_mode=auth_mode,
            card_mode=card_mode,
            error_message=detail,
        )
        message_id = ""
        if card_mode:
            message_id = _send_status_card_best_effort(
                AUTH_CARD_FAILED_TITLE,
                "red",
                _bind_required_text(detail),
                receive_id=receive_id,
                receive_id_type=resolved_type,
            )
        return _unauthorized_result(
            "bind_required",
            required_scopes,
            auth_mode=auth_mode,
            requested_scopes=required_scopes,
            card_msg_id=message_id,
        )
    except Exception:
        raise
    if pending is None:
        return _authorized_result(
            required_scopes,
            auth_mode=auth_mode,
            requested_scopes=[],
            card_msg_id="",
        )

    requested_scopes = _scope_list_for_display(
        required_scopes,
        pending.requested_scopes,
    )

    if not card_mode:
        try:
            pending.proc.wait(timeout=180)
        except subprocess.TimeoutExpired:
            if pending.proc.poll() is None:
                pending.proc.terminate()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    pending.proc.wait(timeout=5)
            return _unauthorized_result(
                "timeout",
                required_scopes,
                auth_mode=auth_mode,
                requested_scopes=requested_scopes,
            )
        finally:
            if pending.proc.poll() is None:
                pending.proc.terminate()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    pending.proc.wait(timeout=5)
        if check_auth_valid(auth_mode, silent=True, probe=False):
            return _authorized_result(
                required_scopes,
                auth_mode=auth_mode,
                requested_scopes=requested_scopes,
            )
        return _unauthorized_result(
            "authorization_required",
            required_scopes,
            auth_mode=auth_mode,
            requested_scopes=requested_scopes,
        )

    response = send_interactive_message(
        _build_auth_card(
            pending.auth_url,
            required_scopes=required_scopes,
            requested_scopes=requested_scopes,
        ),
        receive_id=receive_id,
        receive_id_type=resolved_type,
    )
    response = normalize_interactive_message_response(response) if isinstance(response, dict) else response
    message_id = (
        response.get("data", {}).get("message_id", "")
        if isinstance(response, dict)
        else ""
    )

    start = time.time()
    try:
        while time.time() - start < 180:
            if check_auth_valid(auth_mode, silent=True, probe=False):
                if message_id:
                    _refresh_auth_card(
                        _build_status_card(
                            AUTH_CARD_SUCCESS_TITLE,
                            "green",
                            _success_text_for_scopes(required_scopes),
                        ),
                        message_id=message_id,
                    )
                return _authorized_result(
                    required_scopes,
                    auth_mode=auth_mode,
                    requested_scopes=requested_scopes,
                    card_msg_id=message_id,
                )
            if pending.proc.poll() is not None:
                if _confirm_auth_after_proc_exit(auth_mode):
                    if message_id:
                        _refresh_auth_card(
                            _build_status_card(
                                AUTH_CARD_SUCCESS_TITLE,
                                "green",
                                _success_text_for_scopes(required_scopes),
                            ),
                            message_id=message_id,
                        )
                    return _authorized_result(
                        required_scopes,
                        auth_mode=auth_mode,
                        requested_scopes=requested_scopes,
                        card_msg_id=message_id,
                    )
                if message_id:
                    _refresh_auth_card(
                        _build_status_card(
                            "授权未完成",
                            "red",
                            "授权被取消或未成功完成，请重新发起。",
                        ),
                        message_id=message_id,
                    )
                return _unauthorized_result(
                    "authorization_required",
                    required_scopes,
                    auth_mode=auth_mode,
                    requested_scopes=requested_scopes,
                    card_msg_id=message_id,
                )
            time.sleep(1)
    finally:
        if pending.proc.poll() is None:
            pending.proc.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                pending.proc.wait(timeout=5)

    if message_id:
        _refresh_auth_card(
            _build_status_card(
                "授权超时",
                "orange",
                "授权超时，请重新发起审批操作后再次授权。",
            ),
            message_id=message_id,
        )
    return _unauthorized_result(
        "timeout",
        required_scopes,
        auth_mode=auth_mode,
        requested_scopes=requested_scopes,
        card_msg_id=message_id,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="发起并等待 lark-cli 审批 scope 授权")
    parser.add_argument(
        "--sender-id",
        default="",
        help="可选：授权卡片接收者 open_id；不传则脚本仅在终端等待授权完成",
    )
    parser.add_argument(
        "--chat-id",
        default="",
        help="可选：授权卡片接收群 chat_id；不传则脚本仅在终端等待授权完成",
    )
    parser.add_argument("--receive-id-type", default="chat_id", help="卡片接收 ID 类型")
    parser.add_argument(
        "--auth-mode",
        default=AUTH_MODE_READ,
        choices=[AUTH_MODE_READ, AUTH_MODE_WRITE],
        help="审批授权模式：read 为查询入口、write 为处理入口；两者首次都会校验 read+write scope",
    )
    parser.add_argument(
        "--force-logout",
        action="store_true",
        help="调试用：先执行 auth logout 再重新发起登录",
    )
    args = parser.parse_args()
    try:
        result = run_auth_flow(
            args.sender_id,
            args.chat_id,
            args.receive_id_type,
            auth_mode=args.auth_mode,
            force_logout=args.force_logout,
        )
        print(json.dumps(result, ensure_ascii=False))
        if result["status"] == "authorized":
            return
        sys.exit(1)
    except Exception as exc:
        log_path = _safe_operate_log_path()
        log_debug_event(
            "approval.send_auth_and_wait.failed",
            error_type=type(exc).__name__,
            error_message=preview_text(str(exc), limit=400),
            traceback_preview=preview_text(traceback.format_exc(), limit=4000),
        )
        payload = {
            "status": "failed",
            "message": preview_text(str(exc), limit=200),
        }
        if log_path:
            payload["log_path"] = log_path
        print(
            json.dumps(payload, ensure_ascii=False),
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
