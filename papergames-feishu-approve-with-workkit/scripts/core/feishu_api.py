"""Feishu IM messaging + interactive card refresh.

* `send_interactive_message`, `send_text_message` — outbound message send
* `send_approval_center_link_message` — convenience text follow-up
* `patch_message_card`, `delay_update_card` — refresh sent cards
* `refresh_card` (+ `_refresh_card_once`) — serial refresh with token / msg fallback
* `normalize_interactive_message_response` — unify message_id / card_token shape
* `resolve_receive_target` — pick sender_id vs chat_id from input + env
* `_auth_status_is_user_valid` — parse lark-cli auth status text
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Tuple

from core.constants import APPROVAL_HOME_APPLINK_BASE, APPROVAL_PC_PENDING_PATH
from core.feishu_app import get_approval_app_id, get_tenant_access_token
from core.logging_utils import log_debug_event, preview_text


_CARD_REFRESH_LOCK = threading.Lock()
_COUNTED_CARD_TAGS = {
    "markdown",
    "div",
    "column_set",
    "column",
    "button",
    "collapsible_panel",
    "hr",
    "img",
    "person",
    "person_list",
    "chart",
    "select_static",
    "select_person",
    "multi_select_static",
    "multi_select_person",
    "date_picker",
    "picker_date",
    "picker_time",
    "picker_datetime",
    "overflow",
    "input",
    "checker",
}


def _count_card_elements(node: Any) -> int:
    if isinstance(node, list):
        return sum(_count_card_elements(item) for item in node)
    if not isinstance(node, dict):
        return 0
    own = 1 if str(node.get("tag") or "") in _COUNTED_CARD_TAGS else 0
    return own + sum(_count_card_elements(value) for value in node.values())


def _auth_status_is_user_valid(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return False
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = None
    if isinstance(data, dict):
        identity = str(
            data.get("identity")
            or data.get("currentIdentity")
            or data.get("login_identity")
            or data.get("auth_identity")
            or ""
        ).strip().lower()
        token_status = str(
            data.get("tokenStatus")
            or data.get("token_status")
            or data.get("status")
            or ""
        ).strip().lower()
        # Some lark-cli versions do not expose tokenStatus in auth status output.
        if identity == "user" and token_status in {"", "valid"}:
            return True
        user_info = data.get("user")
        if isinstance(user_info, dict):
            sub_status = str(
                user_info.get("tokenStatus")
                or user_info.get("token_status")
                or user_info.get("status")
                or ""
            ).strip().lower()
            if sub_status in {"", "valid"}:
                return True
    lowered = raw.lower()
    return "identity" in lowered and "user" in lowered


def resolve_receive_target(
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "chat_id",
) -> Tuple[str, str]:
    """Resolve where the app-identity card should be sent."""

    def normalize_target(raw: str) -> Tuple[str, str]:
        value = str(raw or "").strip()
        if not value:
            return "", ""

        while True:
            stripped = re.sub(r"^(?:feishu|lark):", "", value, flags=re.IGNORECASE).strip()
            if stripped == value:
                break
            value = stripped

        lowered = value.lower()
        for prefix in (
            "chat:",
            "chat_id:",
            "group:",
            "channel:",
            "open_id:",
            "user:",
            "dm:",
            "p2p:",
        ):
            if lowered.startswith(prefix):
                value = value[len(prefix) :].strip()
                lowered = value.lower()
                break

        for marker in (":topic:", ":sender:"):
            if marker in value:
                value = value.split(marker, 1)[0].strip()

        if value.startswith(("ou_", "on_")):
            return value, "open_id"
        if value.startswith("oc_"):
            return value, "chat_id"
        return "", ""

    normalized_sender, normalized_sender_type = normalize_target(sender_id)
    if normalized_sender and normalized_sender_type == "open_id":
        return normalized_sender, normalized_sender_type
    for env_key in ("OPENCLAW_SENDER_ID", "SENDER_ID"):
        value = os.getenv(env_key, "").strip()
        normalized_value, normalized_type = normalize_target(value)
        if normalized_value and normalized_type == "open_id":
            return normalized_value, normalized_type

    normalized_chat, normalized_chat_type = normalize_target(chat_id)
    if normalized_chat:
        return normalized_chat, normalized_chat_type
    for env_key in ("OPENCLAW_CHAT_ID", "OPENCLAW_INBOUND_CHAT_ID", "CHAT_ID"):
        value = os.getenv(env_key, "").strip()
        if value:
            normalized_value, normalized_type = normalize_target(value)
            if normalized_value:
                return normalized_value, normalized_type
    return "", receive_id_type.strip() or "chat_id"


def normalize_interactive_message_response(response: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize send-message responses for later card refresh operations."""
    if not isinstance(response, dict):
        return response

    data = response.get("data")
    if not isinstance(data, dict):
        data = {}

    message_id = str(
        data.get("open_message_id")
        or data.get("message_id")
        or response.get("open_message_id")
        or response.get("message_id")
        or ""
    ).strip()
    if message_id:
        data["message_id"] = message_id
        data.setdefault("open_message_id", message_id)

    card_token = str(
        data.get("card_token")
        or data.get("token")
        or response.get("card_token")
        or response.get("token")
        or ""
    ).strip()
    if card_token:
        data["card_token"] = card_token

    if data:
        response["data"] = data
    return response


def send_interactive_message(
    payload: Dict[str, Any],
    *,
    receive_id: str,
    receive_id_type: str,
) -> Dict[str, Any]:
    """Send a card message as the app identity."""
    token = get_tenant_access_token()
    request_payload = {
        "receive_id": receive_id,
        "msg_type": "interactive",
        "content": json.dumps(payload, ensure_ascii=False),
    }
    request = urllib.request.Request(
        f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}",
        data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            feishu_code = result.get("code")
            if feishu_code is not None and int(feishu_code) != 0:
                feishu_msg = result.get("msg", "")
                raise RuntimeError(
                    f"发送卡片失败: Feishu API code={feishu_code}, msg={feishu_msg}"
                )
            return normalize_interactive_message_response(result)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"发送卡片失败: HTTP {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"发送卡片失败: {exc}") from exc


def send_text_message(
    text: str,
    *,
    receive_id: str,
    receive_id_type: str,
) -> Dict[str, Any]:
    """Send a text message as the app identity."""
    token = get_tenant_access_token()
    request_payload = {
        "receive_id": receive_id,
        "msg_type": "text",
        "content": json.dumps({"text": str(text or "")}, ensure_ascii=False),
    }
    request = urllib.request.Request(
        f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}",
        data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"发送文本消息失败: HTTP {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"发送文本消息失败: {exc}") from exc


def patch_message_card(message_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Update a sent message card by open message ID."""
    if not (message_id or "").strip():
        raise RuntimeError("缺少 message_id，无法更新卡片")
    token = get_tenant_access_token()
    request = urllib.request.Request(
        "https://open.feishu.cn/open-apis/im/v1/messages/"
        + urllib.parse.quote(message_id.strip(), safe=""),
        data=json.dumps(
            {"content": json.dumps(payload, ensure_ascii=False)},
            ensure_ascii=False,
        ).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"code": -1, "msg": f"HTTP {exc.code}: {body[:300]}"}
    except urllib.error.URLError as exc:
        return {"code": -1, "msg": str(exc)}


def delay_update_card(card_token: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Delay-update a card after callback response."""
    token = get_tenant_access_token()
    request = urllib.request.Request(
        "https://open.feishu.cn/open-apis/interactive/v1/card/update",
        data=json.dumps(
            {"token": card_token, "card": payload},
            ensure_ascii=False,
        ).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"code": -1, "msg": f"HTTP {exc.code}: {body[:300]}"}
    except urllib.error.URLError as exc:
        return {"code": -1, "msg": str(exc)}


def _refresh_card_once(
    payload: Dict[str, Any],
    *,
    message_id: str = "",
    card_token: str = "",
) -> Dict[str, Any]:
    mid = (message_id or "").strip()
    tok = (card_token or "").strip()
    response = None

    if tok:
        log_debug_event(
            "approval.card_refresh.attempt",
            path="card_token",
            has_message_id=bool(mid),
            has_card_token=True,
        )
        response = delay_update_card(tok, payload)
        log_debug_event(
            "approval.card_refresh.result",
            path="card_token",
            code=response.get("code"),
            msg=preview_text(str(response.get("msg") or "")),
        )
        if response.get("code") == 0 or response.get("ok") is True or not mid:
            return response

    if mid:
        log_debug_event(
            "approval.card_refresh.attempt",
            path="message_id",
            has_message_id=True,
            has_card_token=bool(tok),
        )
        response = patch_message_card(mid, payload)
        log_debug_event(
            "approval.card_refresh.result",
            path="message_id",
            code=response.get("code"),
            msg=preview_text(str(response.get("msg") or "")),
        )
        return response

    if response is not None:
        return response
    return {"code": -1, "msg": "缺少 message_id 和 card_token，无法刷新卡片"}


def _card_debug_stats(payload: Dict[str, Any]) -> Dict[str, Any]:
    """统计卡片体积指标，用于诊断 11310（element 超限）。

    - element_count：飞书按 element 数判 11310，这是关键指标（经验阈值 ~100）。
    - panel_count：折叠面板（分组）数，用来判断是不是"全量重建/多组挤进一张卡"。
    - body_bytes：序列化字节数。
    设 PAPER_FEISHU_APPROVE_LOG_CARD_FULL=1 时，额外把整张卡 JSON 打进日志。
    """
    stats: Dict[str, Any] = {}
    # 真正送给飞书的卡片体：{"type":"raw","data":<card>} 时取 data，否则就是 payload 本身。
    card = payload.get("data") if isinstance(payload, dict) and payload.get("type") == "raw" else payload
    stats["element_count"] = _count_card_elements(card)
    try:
        elements = (card.get("body") or {}).get("elements") or []
        stats["panel_count"] = sum(
            1 for e in elements if isinstance(e, dict) and e.get("tag") == "collapsible_panel"
        )
    except Exception:
        stats["panel_count"] = -1
    if os.getenv("PAPER_FEISHU_APPROVE_LOG_CARD_FULL", "").strip() in ("1", "true", "yes"):
        try:
            stats["card_json"] = json.dumps(card, ensure_ascii=False)
        except Exception:
            pass
    return stats


def refresh_card(
    payload: Dict[str, Any],
    *,
    message_id: str = "",
    card_token: str = "",
) -> Dict[str, Any]:
    """Refresh cards serially; prefer card-token update, then fallback to message PATCH."""
    wait_started_at = time.monotonic()
    with _CARD_REFRESH_LOCK:
        wait_ms = int((time.monotonic() - wait_started_at) * 1000)
        log_debug_event(
            "approval.card_refresh.request",
            has_message_id=bool((message_id or "").strip()),
            has_card_token=bool((card_token or "").strip()),
            payload_size_bytes=len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
            wait_ms=wait_ms,
            **_card_debug_stats(payload),
        )
        return _refresh_card_once(
            payload,
            message_id=message_id,
            card_token=card_token,
        )


def build_approval_center_link_text() -> str:
    """Plain-text approval center entry with the concatenated AppLink."""
    url = (
        f"{APPROVAL_HOME_APPLINK_BASE}"
        f"?appId={urllib.parse.quote(get_approval_app_id(), safe='')}"
        f"&path={urllib.parse.quote(APPROVAL_PC_PENDING_PATH, safe='')}"
    )
    return f"审批中心入口：{url}"


def send_approval_center_link_message(
    *,
    receive_id: str,
    receive_id_type: str,
) -> Dict[str, Any]:
    """Send the hardcoded approval-center link as a follow-up text message."""
    return send_text_message(
        build_approval_center_link_text(),
        receive_id=receive_id,
        receive_id_type=receive_id_type,
    )


__all__ = [
    "_auth_status_is_user_valid",
    "build_approval_center_link_text",
    "delay_update_card",
    "normalize_interactive_message_response",
    "patch_message_card",
    "refresh_card",
    "resolve_receive_target",
    "send_approval_center_link_message",
    "send_interactive_message",
    "send_text_message",
]
