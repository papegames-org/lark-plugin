"""Feishu app credentials + tenant token + JSON command helper.

Resolves app id / secret from env vars → skill-local config.json → OpenClaw
plugin config. Also provides the tenant_access_token fetch used by app-identity
message sends.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, Tuple

from core.constants import DEFAULT_APPROVAL_APP_ID
from core.env import (
    _expand_cfg_str,
    _read_openclaw_json,
    get_skill_root,
    is_feishu_bot_dialogue,
)


def _normalize_app_creds(cfg: dict) -> Tuple[str, str]:
    if not isinstance(cfg, dict):
        return "", ""
    return (
        _expand_cfg_str(cfg.get("app_id") or cfg.get("appId")),
        _expand_cfg_str(cfg.get("app_secret") or cfg.get("appSecret")),
    )


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
        raise RuntimeError(
            f"不存在 feishu 账户键 {preferred!r}，可用: {', '.join(map(str, accounts))}"
        )
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


def get_approval_app_id() -> str:
    """Resolve the Feishu Approval mini-program app id used by card deep links."""
    for key in (
        "PAPER_FEISHU_APPROVE_APPROVAL_APP_ID",
        "FEISHU_APPROVAL_APP_ID",
        "LARK_APPROVAL_APP_ID",
    ):
        value = _expand_cfg_str(os.environ.get(key))
        if value:
            return value

    config_path = os.path.join(get_skill_root(), "config.json")
    if os.path.isfile(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                cfg = json.load(handle)
        except (OSError, json.JSONDecodeError):
            cfg = {}
        app_id = _expand_cfg_str(
            cfg.get("approval_app_id")
            or cfg.get("approvalAppId")
            or cfg.get("approval_appId")
        )
        if app_id:
            return app_id

    return DEFAULT_APPROVAL_APP_ID


def get_current_app_id() -> str:
    """Resolve the current Feishu bot/app id without requiring a secret."""
    for key in (
        "PAPER_FEISHU_APPROVE_BOT_APP_ID",
        "FEISHU_BOT_APP_ID",
        "LARK_BOT_APP_ID",
        "BOT_APP_ID",
        "FEISHU_APP_ID",
        "LARKSUITE_APP_ID",
        "LARKSUITE_CLI_APP_ID",
        "QCLAW_FEISHU_APP_ID",
    ):
        value = _expand_cfg_str(os.environ.get(key))
        if value:
            return value

    config_path = os.path.join(get_skill_root(), "config.json")
    if os.path.isfile(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                cfg = json.load(handle)
        except (OSError, json.JSONDecodeError):
            cfg = {}
        app_id = _expand_cfg_str(cfg.get("app_id") or cfg.get("appId"))
        if app_id:
            return app_id

    try:
        openclaw_cfg, _ = _read_openclaw_json()
    except RuntimeError:
        openclaw_cfg = {}
    if openclaw_cfg:
        feishu_cfg = ((openclaw_cfg.get("channels") or {}).get("feishu") or {})
        account_cfg = _select_feishu_account_dict(openclaw_cfg, feishu_cfg)
        app_id = _expand_cfg_str(account_cfg.get("app_id") or account_cfg.get("appId"))
        if app_id:
            return app_id
        plugin_cfg = _select_openclaw_plugin_config(openclaw_cfg)
        app_id = _expand_cfg_str(plugin_cfg.get("app_id") or plugin_cfg.get("appId"))
        if app_id:
            return app_id

    return ""


def get_app_credentials() -> Tuple[str, str]:
    """Resolve app credentials from env, skill-local config, or OpenClaw config."""
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

    openclaw_cfg, openclaw_path = _read_openclaw_json()
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

    if is_feishu_bot_dialogue():
        raise RuntimeError(
            "当前处于飞书机器人会话，但运行时没有注入可用的应用凭证，导致暂时无法直接发送授权卡片。"
            "这不是用户侧需要手动填写 App ID / App Secret 的步骤，请检查机器人运行环境是否已注入 "
            "LARKSUITE_CLI_APP_ID / LARKSUITE_CLI_APP_SECRET，或 ~/.openclaw/openclaw.json / OPENCLAW_CONFIG_PATH "
            "指向的配置中是否存在 channels.feishu 或 openclaw-lark 绑定凭证。"
        )

    raise RuntimeError(
        "未找到飞书应用凭证。请设置 FEISHU_APP_ID / FEISHU_APP_SECRET，"
        "或在技能目录提供 config.json，或在 openclaw.json 中配置 channels.feishu / openclaw-lark 凭证。"
    )


def get_tenant_access_token() -> str:
    """Fetch tenant access token for app-identity message sends."""
    app_id, app_secret = get_app_credentials()
    payload = json.dumps(
        {"app_id": app_id, "app_secret": app_secret}
    ).encode("utf-8")
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


def run_json_command(cmd: Iterable[str], *, timeout: int = 30) -> Dict[str, Any]:
    """Run a command that is expected to emit JSON on stdout."""
    result = subprocess.run(
        list(cmd),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(stderr or "命令执行失败")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("命令输出不是合法 JSON") from exc


__all__ = [
    "_normalize_app_creds",
    "get_app_credentials",
    "get_approval_app_id",
    "get_current_app_id",
    "get_tenant_access_token",
    "run_json_command",
]
