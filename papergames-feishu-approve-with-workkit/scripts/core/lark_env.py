"""lark-cli environment + profile resolution + install / version probe."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

from core.constants import (
    LARK_PROFILE_NAME,
    MISSING_LARK_CLI_MESSAGE,
    lark_profile_cache_ttl_seconds,
)
from core.env import find_openclaw_json_path, get_runtime_dir
from core.feishu_app import get_app_credentials
from core.logging_utils import print_post_install_hint_once, require_command
from core.cache_store import TTLCache


# 已解析的 lark-cli profile 进程内缓存：带 TTL（默认 5 分钟），避免长驻进程里
# 切换 / 新增 profile 后一直命中旧值；传 refresh=True 可强制重新解析。
_RESOLVED_LARK_PROFILE_CACHE = TTLCache(lark_profile_cache_ttl_seconds())


def _should_auto_install_lark_cli() -> bool:
    """lark-cli 缺失时是否由本 skill 自动 npm 安装。默认关闭，交给外部预装。"""
    raw = str(os.getenv("PAPER_FEISHU_APPROVE_LARK_AUTO_INSTALL", "") or "").strip().lower()
    if not raw:
        return False
    return raw in {"1", "true", "yes", "on"}


def resolve_lark_cli_config_dir() -> str:
    explicit = (os.getenv("LARKSUITE_CLI_CONFIG_DIR") or "").strip()
    if explicit:
        return str(Path(explicit).expanduser())

    preferred_config_dir: Path | None = None
    if openclaw_path := find_openclaw_json_path():
        preferred_config_dir = Path(openclaw_path).resolve().parent / "lark-cli"

    candidates: list[Path] = []
    for candidate in (
        Path.home() / ".lark-cli",
        Path.home() / ".lark-cli" / "openclaw",
        preferred_config_dir,
        Path.home() / ".openclaw" / "lark-cli",
    ):
        if candidate is None or candidate in candidates:
            continue
        candidates.append(candidate)

    def has_usable_config(candidate: Path) -> bool:
        config_path = candidate / "config.json"
        if not config_path.is_file():
            return False
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return False
        apps = payload.get("apps")
        return isinstance(apps, list) and len(apps) > 0

    for candidate in candidates:
        if has_usable_config(candidate):
            return str(candidate)

    for candidate in candidates:
        if candidate.is_dir():
            return str(candidate)

    if candidates:
        return str(candidates[0])
    return os.path.join(get_runtime_dir(), "lark-cli")


def ensure_lark_cli_environment() -> Dict[str, str]:
    config_dir = resolve_lark_cli_config_dir()
    os.makedirs(config_dir, exist_ok=True)
    env = os.environ.copy()
    with contextlib.suppress(KeyError):
        env.pop("LARKSUITE_CLI_CONFIG_DIR", None)
    return env


def _read_lark_cli_profiles_from_config(config_dir: str) -> list[Dict[str, Any]]:
    config_path = Path(config_dir).expanduser() / "config.json"
    if not config_path.is_file():
        return []
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []

    apps = payload.get("apps")
    if not isinstance(apps, list):
        return []

    profiles: list[Dict[str, Any]] = []
    for app in apps:
        if not isinstance(app, dict):
            continue
        app_id = str(app.get("appId") or app.get("app_id") or "").strip()
        name = str(
            app.get("name") or app.get("profile") or app.get("profileName") or app_id
        ).strip()
        if not name:
            continue
        profiles.append(
            {
                "name": name,
                "appId": app_id,
                "brand": str(app.get("brand") or "").strip(),
            }
        )
    return profiles


def get_lark_profile_name(*, refresh: bool = False) -> str:
    explicit = str(os.getenv("PAPER_FEISHU_APPROVE_LARK_PROFILE", "") or "").strip()
    if explicit:
        return explicit

    config_dir = resolve_lark_cli_config_dir()
    cache_key = str(Path(config_dir).expanduser())
    if not refresh:
        cached = _RESOLVED_LARK_PROFILE_CACHE.get(cache_key)
        if cached is not None:
            return cached

    app_id = ""
    try:
        app_id, _ = get_app_credentials()
    except Exception:
        app_id = ""

    profiles = _read_lark_cli_profiles_from_config(config_dir)
    resolved = ""

    if app_id:
        for item in profiles:
            profile_app_id = str(item.get("appId") or "").strip()
            profile_name = str(item.get("name") or "").strip()
            if profile_app_id and profile_app_id == app_id and profile_name:
                resolved = profile_name
                break

    if not resolved and profiles:
        for item in profiles:
            profile_name = str(item.get("name") or "").strip()
            if profile_name == LARK_PROFILE_NAME:
                resolved = profile_name
                break

    if not resolved and len(profiles) == 1:
        resolved = str(profiles[0].get("name") or "").strip()

    if not resolved and app_id:
        resolved = app_id

    if not resolved:
        resolved = LARK_PROFILE_NAME

    _RESOLVED_LARK_PROFILE_CACHE.set(cache_key, resolved)
    return resolved


def ensure_lark_cli_installed(*, out=None) -> Dict[str, Any]:
    """Ensure lark-cli is available, attempting auto-install when missing."""
    lark_env = ensure_lark_cli_environment()
    if shutil.which("lark-cli"):
        post_install_hint_printed = print_post_install_hint_once(out=out)
        return {
            "installed": False,
            "skill_installed": False,
            "version_checked": False,
            "post_install_hint_printed": post_install_hint_printed,
            "listener_started": False,
            "listener_pid": 0,
        }

    writer = out or sys.stderr
    print(MISSING_LARK_CLI_MESSAGE, file=writer)

    if not _should_auto_install_lark_cli():
        raise RuntimeError(MISSING_LARK_CLI_MESSAGE)

    require_command("npm")
    install = subprocess.run(["npm", "install", "-g", "@larksuite/cli"], capture_output=True, text=True, timeout=600, env=lark_env)
    if install.returncode != 0:
        stderr = (install.stderr or install.stdout or "").strip()
        raise RuntimeError(f"{MISSING_LARK_CLI_MESSAGE}\n\n自动安装 lark-cli 失败：{stderr[:240]}")

    require_command("npx")
    skill_install = subprocess.run(["npx", "skills", "add", "larksuite/cli", "-y", "-g"], capture_output=True, text=True, timeout=600, env=lark_env)
    if skill_install.returncode != 0:
        stderr = (skill_install.stderr or skill_install.stdout or "").strip()
        raise RuntimeError(f"{MISSING_LARK_CLI_MESSAGE}\n\n自动安装 lark-cli skill 失败：{stderr[:240]}")

    if not shutil.which("lark-cli"):
        raise RuntimeError(f"{MISSING_LARK_CLI_MESSAGE}\n\n自动安装完成后仍未在系统路径中发现 lark-cli。")

    version = subprocess.run(["lark-cli", "--version"], capture_output=True, text=True, timeout=30, env=lark_env)
    if version.returncode != 0:
        stderr = (version.stderr or version.stdout or "").strip()
        raise RuntimeError(f"{MISSING_LARK_CLI_MESSAGE}\n\n自动安装后执行 `lark-cli --version` 失败：{stderr[:240]}")

    post_install_hint_printed = print_post_install_hint_once(out=writer)

    return {
        "installed": True,
        "skill_installed": True,
        "version_checked": True,
        "version": (version.stdout or "").strip(),
        "post_install_hint_printed": post_install_hint_printed,
        "listener_started": False,
        "listener_pid": 0,
    }


__all__ = [
    "ensure_lark_cli_environment",
    "ensure_lark_cli_installed",
    "get_lark_profile_name",
    "resolve_lark_cli_config_dir",
]
