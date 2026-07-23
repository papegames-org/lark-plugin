#!/usr/bin/env python3
"""Send Feishu auth card and wait until paper_api_auth finishes OA IAM authorization."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Tuple

import paper_api_auth as base_auth


AUTH_CARD_AUTH_TITLE = "请授权 OA 流程详情查询能力"
AUTH_CARD_SUCCESS_TITLE = "授权成功"
AUTH_CARD_FAILED_TITLE = "授权失败"
AUTH_CARD_TIMEOUT_TITLE = "授权超时"
AUTH_WAIT_SECONDS = 180
AUTHORIZE_URL_WAIT_SECONDS = 12
MISSING_RECEIVE_TARGET_MESSAGE = (
    "未解析到可用的飞书卡片接收目标，无法发送授权卡片。"
    "请配置 OPENCLAW_CHAT_ID / OPENCLAW_INBOUND_CHAT_ID 或 OPENCLAW_SENDER_ID。"
)


def get_skill_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_python_command() -> str:
    return os.environ.get("PAPER_API_PYTHON_BIN") or sys.executable or "python3"


def _expand_cfg_str(value: object) -> str:
    return os.path.expandvars(str(value or "").strip())


def _normalize_app_creds(cfg: dict) -> Tuple[str, str]:
    if not isinstance(cfg, dict):
        return "", ""
    return (
        _expand_cfg_str(cfg.get("app_id") or cfg.get("appId")),
        _expand_cfg_str(cfg.get("app_secret") or cfg.get("appSecret")),
    )


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


def _binding_feishu_account_id(cfg: dict, accounts: dict) -> str:
    wanted = {str(key).lower(): key for key in accounts}
    for binding in cfg.get("bindings") or []:
        if not isinstance(binding, dict):
            continue
        match = binding.get("match") or {}
        if str(match.get("channel", "")).lower() != "feishu":
            continue
        account_id = str(match.get("accountId") or "").strip().lower()
        if account_id in wanted:
            return str(wanted[account_id])
    return ""


def _select_feishu_account_dict(cfg: dict, feishu_cfg: dict) -> Dict[str, Any]:
    if not isinstance(feishu_cfg, dict):
        return {}
    accounts = feishu_cfg.get("accounts")
    if not isinstance(accounts, dict) or not accounts:
        return feishu_cfg

    preferred = (
        os.getenv("FEISHU_OPENCLAW_ACCOUNT", "").strip()
        or os.getenv("OPENCLAW_FEISHU_ACCOUNT", "").strip()
        or os.getenv("FEISHU_ACCOUNT_KEY", "").strip()
    )
    if preferred:
        account = accounts.get(preferred)
        if isinstance(account, dict):
            return account
        raise RuntimeError(f"不存在 feishu 账户键 {preferred!r}，可用: {', '.join(map(str, accounts))}")

    if len(accounts) == 1:
        first = next(iter(accounts.values()))
        return first if isinstance(first, dict) else {}

    if binding_id := _binding_feishu_account_id(cfg, accounts):
        account = accounts.get(binding_id)
        if isinstance(account, dict):
            return account

    if isinstance(accounts.get("main"), dict):
        return accounts["main"]

    for account in accounts.values():
        if isinstance(account, dict):
            app_id, app_secret = _normalize_app_creds(account)
            if app_id and app_secret:
                return account

    return next((account for account in accounts.values() if isinstance(account, dict)), {})


def _select_openclaw_plugin_config(cfg: dict) -> Dict[str, Any]:
    plugins = cfg.get("plugins")
    if not isinstance(plugins, dict):
        return {}
    entries = plugins.get("entries")
    if not isinstance(entries, dict):
        return {}
    for key in ("openclaw-lark", "lark", "feishu", "openclaw_feishu"):
        entry = entries.get(key)
        if not isinstance(entry, dict):
            continue
        config = entry.get("config")
        if isinstance(config, dict):
            return config
    return {}


def get_app_credentials() -> Tuple[str, str]:
    app_id = (
        os.environ.get("FEISHU_APP_ID")
        or os.environ.get("LARKSUITE_APP_ID")
        or os.environ.get("LARKSUITE_CLI_APP_ID")
        or os.environ.get("QCLAW_FEISHU_APP_ID")
    )
    app_secret = (
        os.environ.get("FEISHU_APP_SECRET")
        or os.environ.get("LARKSUITE_APP_SECRET")
        or os.environ.get("LARKSUITE_CLI_APP_SECRET")
        or os.environ.get("QCLAW_FEISHU_APP_SECRET")
    )
    if app_id and app_secret:
        return app_id, app_secret

    config_path = os.path.join(get_skill_root(), "config.json")
    if os.path.isfile(config_path):
        with open(config_path, "r", encoding="utf-8") as handle:
            cfg = json.load(handle)
        app_id = cfg.get("app_id") or cfg.get("appId")
        app_secret = cfg.get("app_secret") or cfg.get("appSecret")
        if app_id and app_secret:
            return app_id, app_secret

    openclaw_cfg, _ = _read_openclaw_json()
    if openclaw_cfg:
        feishu_cfg = ((openclaw_cfg.get("channels") or {}).get("feishu") or {})
        account_cfg = _select_feishu_account_dict(openclaw_cfg, feishu_cfg)
        app_id, app_secret = _normalize_app_creds(account_cfg)
        if app_id and app_secret:
            return app_id, app_secret
        plugin_cfg = _select_openclaw_plugin_config(openclaw_cfg)
        app_id, app_secret = _normalize_app_creds(plugin_cfg)
        if app_id and app_secret:
            return app_id, app_secret

    raise RuntimeError("未找到可用的飞书应用凭证，无法发送鉴权卡片。请检查运行环境注入的 Feishu app 凭证。")


def get_tenant_access_token() -> str:
    app_id, app_secret = get_app_credentials()
    payload = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode("utf-8")
    request = urllib.request.Request(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"获取 tenant_access_token 失败: {exc}") from exc
    if data.get("code") != 0:
        raise RuntimeError(f"获取 tenant_access_token 失败: {data.get('msg')}")
    return data["tenant_access_token"]


def resolve_receive_target(sender_id: str = "", chat_id: str = "", receive_id_type: str = "chat_id") -> Tuple[str, str]:
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
            "chat:", "chat_id:", "group:", "channel:", "open_id:", "user:", "dm:", "p2p:",
        ):
            if lowered.startswith(prefix):
                value = value[len(prefix):].strip()
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
        normalized_value, normalized_type = normalize_target(value)
        if normalized_value:
            return normalized_value, normalized_type

    return "", receive_id_type.strip() or "chat_id"


def normalize_interactive_message_response(response: Dict[str, Any]) -> Dict[str, Any]:
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

    if data:
        response["data"] = data
    return response


def _extract_message_id(response: Dict[str, Any]) -> str:
    if not isinstance(response, dict):
        return ""
    data = response.get("data")
    if not isinstance(data, dict):
        data = {}
    return str(
        data.get("message_id")
        or data.get("open_message_id")
        or response.get("message_id")
        or response.get("open_message_id")
        or ""
    ).strip()


def _require_success_response(response: Dict[str, Any], action: str, *, require_message_id: bool = False) -> Dict[str, Any]:
    normalized = normalize_interactive_message_response(response)
    code = normalized.get("code")
    if code not in (0, "0", None):
        message = str(
            normalized.get("msg")
            or normalized.get("message")
            or json.dumps(normalized, ensure_ascii=False)
        ).strip()
        raise RuntimeError(f"{action}失败: {message}")

    if require_message_id and not _extract_message_id(normalized):
        raise RuntimeError(f"{action}成功但响应缺少 message_id，无法继续更新卡片状态。")

    return normalized


def _remove_authorize_url_file() -> None:
    auth_file = getattr(base_auth, "AUTHORIZE_URL_PATH", "")
    if not auth_file:
        return
    try:
        if os.path.exists(auth_file):
            os.remove(auth_file)
    except OSError:
        pass


def send_interactive_message(payload: Dict[str, Any], *, receive_id: str, receive_id_type: str) -> Dict[str, Any]:
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
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"发送鉴权卡片失败: HTTP {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"发送鉴权卡片失败: {exc}") from exc
    return _require_success_response(payload, "发送鉴权卡片", require_message_id=True)


def patch_message_card(message_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not (message_id or "").strip():
        raise RuntimeError("缺少 message_id，无法更新卡片")
    token = get_tenant_access_token()
    request = urllib.request.Request(
        "https://open.feishu.cn/open-apis/im/v1/messages/" + urllib.parse.quote(message_id.strip(), safe=""),
        data=json.dumps({"content": json.dumps(payload, ensure_ascii=False)}, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"更新鉴权卡片失败: HTTP {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"更新鉴权卡片失败: {exc}") from exc
    return _require_success_response(result, "更新鉴权卡片")


def refresh_card(payload: Dict[str, Any], *, message_id: str = "") -> Dict[str, Any]:
    if not (message_id or "").strip():
        return {"code": -1, "msg": "缺少 message_id，无法刷新卡片"}
    return patch_message_card(message_id, payload)


def _refresh_status_card(message_id: str, title: str, template: str, content: str) -> None:
    if not (message_id or "").strip():
        return
    try:
        refresh_card(_build_status_card(title, template, content), message_id=message_id)
    except RuntimeError as exc:
        print(f"⚠️ 更新鉴权卡片失败: {exc}", file=sys.stderr, flush=True)


def _read_proc_stderr(proc: subprocess.Popen[str]) -> str:
    return (proc.stderr.read() if proc.stderr else "") or ""


def _cleanup_proc(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _auth_button_action(auth_url: str) -> Dict[str, Any]:
    target_url = str(auth_url or "").strip()
    return {
        "tag": "action",
        "actions": [
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": "前往授权"},
                "type": "primary",
                "url": target_url,
            }
        ],
    }


def _build_auth_card(auth_url: str) -> Dict[str, Any]:
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": AUTH_CARD_AUTH_TITLE},
            "template": "blue",
        },
        "elements": [
            {"tag": "markdown", "content": "需要先完成 Paper API 的飞书授权，之后才能继续执行快捷审批。"},
            {
                "tag": "note",
                "elements": [{"tag": "plain_text", "content": f"授权范围：{base_auth.IAM_SCOPE}"}],
            },
            _auth_button_action(auth_url),
        ],
    }


def _build_status_card(title: str, template: str, content: str) -> Dict[str, Any]:
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": template,
        },
        "elements": [{"tag": "markdown", "content": content}],
    }


def _try_get_token() -> str | None:
    try:
        return base_auth.ensure_token()
    except base_auth.AuthRequiredError:
        return None


def _wait_for_authorize_url(timeout_seconds: int = AUTHORIZE_URL_WAIT_SECONDS) -> str:
    deadline = time.time() + timeout_seconds
    auth_file = base_auth.AUTHORIZE_URL_PATH
    while time.time() < deadline:
        if os.path.exists(auth_file):
            try:
                with open(auth_file, "r", encoding="utf-8") as handle:
                    content = handle.read().strip()
                if content:
                    return content
            except OSError:
                pass
        time.sleep(0.5)
    return ""


def _authorized_result(token: str, card_msg_id: str = "") -> Dict[str, Any]:
    return {
        "status": "authorized",
        "authorized": True,
        "access_token": token,
        "token": token,
        "tokenSource": "paper-auth-card",
        "card_msg_id": card_msg_id,
    }


def _unauthorized_result(status: str, message: str, *, card_msg_id: str = "", auth_url: str = "") -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "status": status,
        "authorized": False,
        "message": message,
        "card_msg_id": card_msg_id,
    }
    if auth_url:
        payload["auth_url"] = auth_url
    return payload


def _wait_for_auth_result(proc: subprocess.Popen[str], *, message_id: str, auth_url: str) -> Dict[str, Any]:
    start = time.time()
    try:
        while time.time() - start < AUTH_WAIT_SECONDS:
            try:
                token = _try_get_token()
            except base_auth.AuthUnavailableError as exc:
                _refresh_status_card(message_id, AUTH_CARD_FAILED_TITLE, "red", f"授权流程暂时不可用：{str(exc)}")
                return _unauthorized_result("auth_unavailable", str(exc), card_msg_id=message_id, auth_url=auth_url)
            except RuntimeError as exc:
                _refresh_status_card(message_id, AUTH_CARD_FAILED_TITLE, "red", f"授权流程执行失败：{str(exc)}")
                return _unauthorized_result("failed", str(exc), card_msg_id=message_id, auth_url=auth_url)

            if token:
                _refresh_status_card(message_id, AUTH_CARD_SUCCESS_TITLE, "green", "授权完成，可以继续执行快捷审批。")
                return _authorized_result(token, card_msg_id=message_id)

            if proc.poll() is not None:
                message = _read_proc_stderr(proc).strip() or "授权被取消或未成功完成，请重新发起。"
                _refresh_status_card(message_id, AUTH_CARD_FAILED_TITLE, "red", message)
                return _unauthorized_result("authorization_required", message, card_msg_id=message_id, auth_url=auth_url)

            time.sleep(1)
    finally:
        _cleanup_proc(proc)
        _remove_authorize_url_file()

    _refresh_status_card(message_id, AUTH_CARD_TIMEOUT_TITLE, "orange", "授权等待超时，请重新发起快捷审批后再次授权。")
    return _unauthorized_result(
        "timeout",
        "授权等待超时，请重新发起快捷审批后再次授权。",
        card_msg_id=message_id,
        auth_url=auth_url,
    )


def run_auth_flow(sender_id: str = "", chat_id: str = "", receive_id_type: str = "chat_id") -> Dict[str, Any]:
    try:
        token = _try_get_token()
        if token:
            return _authorized_result(token)
    except base_auth.AuthUnavailableError as exc:
        return _unauthorized_result("auth_unavailable", str(exc))
    except RuntimeError as exc:
        return _unauthorized_result("failed", str(exc))

    receive_id, resolved_type = resolve_receive_target(sender_id, chat_id, receive_id_type)
    if not receive_id:
        return _unauthorized_result("missing_receive_target", MISSING_RECEIVE_TARGET_MESSAGE)

    _remove_authorize_url_file()
    proc = subprocess.Popen(
        [get_python_command(), os.path.abspath(base_auth.__file__), "--auth"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    auth_url = _wait_for_authorize_url()
    if not auth_url:
        stderr = _read_proc_stderr(proc) if proc.poll() is not None else ""
        _cleanup_proc(proc)
        _remove_authorize_url_file()
        return _unauthorized_result("authorization_required", stderr.strip() or "未能生成授权链接，无法发送鉴权卡片。")

    message_id = ""
    if receive_id:
        try:
            response = send_interactive_message(
                _build_auth_card(auth_url),
                receive_id=receive_id,
                receive_id_type=resolved_type,
            )
        except RuntimeError as exc:
            _cleanup_proc(proc)
            _remove_authorize_url_file()
            return _unauthorized_result("card_delivery_failed", str(exc), auth_url=auth_url)

        message_id = _extract_message_id(response)

    if not message_id:
        _cleanup_proc(proc)
        _remove_authorize_url_file()
        return _unauthorized_result("card_delivery_failed", "发送鉴权卡片成功但未拿到 message_id，无法继续更新卡片状态。", auth_url=auth_url)

    return _wait_for_auth_result(proc, message_id=message_id, auth_url=auth_url)


def main() -> None:
    parser = argparse.ArgumentParser(description="发送鉴权卡片并等待 Paper API 授权完成")
    parser.add_argument("--sender-id", default="", help="可选：授权卡片接收者 open_id")
    parser.add_argument("--chat-id", default="", help="可选：授权卡片接收群 chat_id")
    parser.add_argument("--receive-id-type", default="chat_id", help="卡片接收 ID 类型")
    args = parser.parse_args()

    result = run_auth_flow(args.sender_id, args.chat_id, args.receive_id_type)
    print(json.dumps(result, ensure_ascii=False))
    if result.get("status") != "authorized":
        sys.exit(1)


if __name__ == "__main__":
    main()
