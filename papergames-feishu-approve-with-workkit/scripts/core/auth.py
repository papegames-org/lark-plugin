#!/usr/bin/env python3
"""Centralized lark-cli approval auth helpers for this skill."""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any

from core.constants import APPROVE_SCOPE, INSTANCE_READ_SCOPE, LARK_PROFILE_NAME, READ_SCOPE
from core.env import is_openclaw_runtime
from core.feishu_app import get_app_credentials
from core.lark_env import (
    ensure_lark_cli_environment,
    ensure_lark_cli_installed,
    get_lark_profile_name,
)
from core.logging_utils import AuthorizationRequiredError, extract_json_object
from core.redaction import extract_auth_url


AUTH_MODE_READ = "read"
AUTH_MODE_WRITE = "write"
_AUTH_CACHE_EXPIRES_AT = {
    AUTH_MODE_READ: 0.0,
    AUTH_MODE_WRITE: 0.0,
}
_LARK_CLI_CONFIGURED = False
_LARK_CLI_NOT_CONFIGURED_TEXT_MARKERS = (
    "not configured",
    "not bound to current environment",
    "not bound to the current environment",
    "not bound to this environment",
    "还没绑定到当前环境",
    "尚未绑定到当前环境",
    "未绑定到当前环境",
    "需要先配置一下",
)
_LARK_CLI_BIND_SOURCE = (
    str(os.getenv("PAPER_FEISHU_APPROVE_LARK_BIND_SOURCE", "openclaw") or "").strip()
    or "openclaw"
)
_LARK_CLI_BIND_IDENTITY = (
    str(os.getenv("PAPER_FEISHU_APPROVE_LARK_BIND_IDENTITY", "user-default") or "").strip()
    or "user-default"
)
_RECOVERY_REASON_CONFIGURE_REQUIRED = "configure_required"
_RECOVERY_REASON_BIND_REQUIRED = "bind_required"


@dataclass
class PendingAuth:
    proc: subprocess.Popen
    auth_url: str
    requested_scopes: list[str]


@dataclass
class AuthState:
    status: str
    required_scopes: list[str]
    requested_scopes: list[str]
    detail: str = ""


class OpenClawBindingRequiredError(RuntimeError):
    """Raised when the current OpenClaw runtime is not bound for lark-cli usage."""


def _normalize_auth_mode(auth_mode: str = AUTH_MODE_READ) -> str:
    mode = str(auth_mode or AUTH_MODE_READ).strip().lower()
    if mode in {AUTH_MODE_READ, AUTH_MODE_WRITE}:
        return mode
    raise ValueError(f"不支持的审批鉴权模式: {auth_mode}")


def required_scopes_for_mode(auth_mode: str = AUTH_MODE_READ) -> list[str]:
    mode = _normalize_auth_mode(auth_mode)
    if mode in {AUTH_MODE_READ, AUTH_MODE_WRITE}:
        # 查询入口也一次性补齐读写 scope，避免后续补权再次走慢链路。
        # instance:read 用于拉实例详情补「任务到达审批人时间」。
        return [READ_SCOPE, APPROVE_SCOPE, INSTANCE_READ_SCOPE]
    raise ValueError(f"不支持的审批鉴权模式: {auth_mode}")


def _auth_access_cache_ttl_seconds() -> float:
    raw = str(
        os.environ.get("PAPER_FEISHU_APPROVE_AUTH_CACHE_TTL_SECONDS", "20") or ""
    ).strip()
    try:
        ttl = float(raw)
    except ValueError:
        ttl = 20.0
    return ttl if ttl > 0 else 0.0


def _should_auto_bind_lark_cli() -> bool:
    """OpenClaw 下是否由本 skill 自动 `config bind`。默认关闭，信任外部已绑定。

    需要恢复自绑定，设 PAPER_FEISHU_APPROVE_LARK_AUTO_BIND=1。
    """
    raw = str(os.getenv("PAPER_FEISHU_APPROVE_LARK_AUTO_BIND", "") or "").strip().lower()
    if not raw:
        return False
    return raw in {"1", "true", "yes", "on"}


def _maybe_prepare_lark_cli_for_openclaw(*, auto_configure: bool = True) -> None:
    """Warm the lark-cli environment without mutating binding state up front."""
    if not auto_configure:
        return
    with contextlib.suppress(Exception):
        ensure_lark_cli_environment()


def _lc(*args: str, auto_configure: bool = True, **kw: Any) -> subprocess.CompletedProcess:
    _maybe_prepare_lark_cli_for_openclaw(auto_configure=auto_configure)
    profile_name = get_lark_profile_name()
    env = dict(ensure_lark_cli_environment())
    if isinstance(kw.get("env"), dict):
        env.update(kw["env"])
    kw["env"] = env
    result = subprocess.run(
        ["lark-cli", "--profile", profile_name, *args],
        capture_output=True,
        text=True,
        **kw,
    )
    recovery_reason = _lark_cli_recovery_reason(result)
    if auto_configure and recovery_reason:
        changed = _configure_lark_cli(recovery_reason=recovery_reason)
        if not changed:
            return result
        profile_name = get_lark_profile_name(refresh=True)
        result = subprocess.run(
            ["lark-cli", "--profile", profile_name, *args],
            capture_output=True,
            text=True,
            **kw,
        )
    return result


# Alias kept for in-module call sites; canonical implementation lives in common.
_extract_json_object = extract_json_object


def _is_lark_cli_profile_exists_error(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    return any(
        marker in lowered
        for marker in (
            "already exists",
            "profile exists",
            "已存在",
            "已经存在",
            "重复",
        )
    )


def _is_openclaw_bind_required_text(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    if "openclaw context detected but lark-cli is not bound" in lowered:
        return True
    return (
        ("openclaw" in lowered and "not bound" in lowered)
        or ("lark-cli" in lowered and "not bound" in lowered and "bind" in lowered)
        or ("需要先绑定" in lowered and "openclaw" in lowered)
        or ("未绑定" in lowered and "openclaw" in lowered)
    )


def _is_openclaw_config_refused_text(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    return any(
        marker in lowered
        for marker in (
            "init is refused inside openclaw context",
            "config init is refused inside openclaw context",
            "bind is refused inside openclaw context",
            "shadow the existing openclaw binding",
            "parallel app",
            "拒绝在 openclaw context 中 init",
            "shadow 现有 openclaw 绑定",
        )
    )


def _lark_cli_recovery_reason(result: subprocess.CompletedProcess) -> str:
    def has_marker(text: str) -> bool:
        lowered = str(text or "").strip().lower()
        return any(marker in lowered for marker in _LARK_CLI_NOT_CONFIGURED_TEXT_MARKERS)

    payload = _extract_json_object((result.stdout or "").strip()) or _extract_json_object(
        (result.stderr or "").strip()
    )
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            error_type = str(error.get("type") or "").strip().lower()
            error_message = str(error.get("message") or "").strip().lower()
            error_hint = str(error.get("hint") or "").strip().lower()
            if error_type == "openclaw" and (
                _is_openclaw_bind_required_text(error_message)
                or _is_openclaw_bind_required_text(error_hint)
            ):
                return _RECOVERY_REASON_BIND_REQUIRED
            if error_type == "config" or has_marker(error_message):
                return _RECOVERY_REASON_CONFIGURE_REQUIRED
        message = str(payload.get("message") or payload.get("msg") or "").strip().lower()
        if _is_openclaw_bind_required_text(message):
            return _RECOVERY_REASON_BIND_REQUIRED
        if has_marker(message):
            return _RECOVERY_REASON_CONFIGURE_REQUIRED
    combined = "\n".join(
        part for part in ((result.stdout or "").strip(), (result.stderr or "").strip()) if part
    )
    if _is_openclaw_bind_required_text(combined):
        return _RECOVERY_REASON_BIND_REQUIRED
    if has_marker(combined):
        return _RECOVERY_REASON_CONFIGURE_REQUIRED
    combined_lower = combined.lower()
    if "not configured" in combined_lower and "config init" in combined_lower:
        return _RECOVERY_REASON_CONFIGURE_REQUIRED
    return ""


def _needs_lark_cli_configuration(result: subprocess.CompletedProcess) -> bool:
    return bool(_lark_cli_recovery_reason(result))


def _activate_lark_cli_profile(profile_name: str) -> None:
    target = str(profile_name or "").strip()
    if not target:
        return

    env = ensure_lark_cli_environment()
    profile_list = subprocess.run(
        ["lark-cli", "profile", "list"],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )
    if profile_list.returncode != 0:
        return
    try:
        profiles = json.loads(profile_list.stdout or "")
    except json.JSONDecodeError:
        return
    if not isinstance(profiles, list):
        return

    matched = None
    for item in profiles:
        if not isinstance(item, dict):
            continue
        if str(item.get("name") or "").strip() == target:
            matched = item
            break
    if not isinstance(matched, dict):
        return
    if bool(matched.get("active")):
        return

    switched = subprocess.run(
        ["lark-cli", "profile", "use", target],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )
    if switched.returncode == 0:
        return
    detail = (switched.stderr or switched.stdout or "").strip()
    raise RuntimeError(f"切换 lark-cli profile 失败：{detail[:240]}")


def _bind_lark_cli_to_openclaw(profile_name: str, *, app_id: str = "") -> bool:
    _activate_lark_cli_profile(profile_name)
    resolved_app_id = str(app_id or "").strip()
    explicit_identity = str(_LARK_CLI_BIND_IDENTITY or "").strip()

    def run_bind(*, force: bool = False) -> subprocess.CompletedProcess:
        cmd = [
            "lark-cli",
            "config",
            "bind",
            "--source",
            _LARK_CLI_BIND_SOURCE,
        ]
        if resolved_app_id:
            cmd.extend(["--app-id", resolved_app_id])
        if explicit_identity:
            cmd.extend(["--identity", explicit_identity])
        if force:
            cmd.append("--force")
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            env=ensure_lark_cli_environment(),
        )

    result = run_bind()
    if result.returncode == 0:
        return True
    detail = (result.stderr or result.stdout or "").strip()
    detail_lower = detail.lower()
    if any(
        marker in detail_lower
        for marker in (
            "already bound",
            "already binding",
            "已绑定",
            "已经绑定",
            "重复绑定",
        )
    ):
        return True
    if _is_openclaw_config_refused_text(detail):
        return False
    if explicit_identity and any(
        marker in detail_lower
        for marker in (
            "risky transition",
            "identity change",
            "bot-only",
            "force",
            "身份策略",
            "需要 --force",
        )
    ):
        forced = run_bind(force=True)
        if forced.returncode == 0:
            return True
        forced_detail = (forced.stderr or forced.stdout or "").strip()
        forced_detail_lower = forced_detail.lower()
        if any(
            marker in forced_detail_lower
            for marker in (
                "already bound",
                "already binding",
                "已绑定",
                "已经绑定",
                "重复绑定",
            )
        ):
            return True
        if _is_openclaw_config_refused_text(forced_detail):
            return False
        detail = forced_detail
    raise RuntimeError(f"自动绑定 lark-cli 到 OpenClaw 失败：{detail[:240]}")


def _configure_lark_cli(
    *,
    recovery_reason: str = _RECOVERY_REASON_CONFIGURE_REQUIRED,
) -> bool:
    global _LARK_CLI_CONFIGURED
    if _LARK_CLI_CONFIGURED and recovery_reason != _RECOVERY_REASON_BIND_REQUIRED:
        return False
    profile_name = get_lark_profile_name(refresh=True)
    if is_openclaw_runtime():
        if recovery_reason != _RECOVERY_REASON_BIND_REQUIRED:
            return False
        if not _should_auto_bind_lark_cli():
            # 自绑定关闭：不跑 `config bind`，信任外部已绑定好的 lark-cli。
            return False
        changed = _bind_lark_cli_to_openclaw(profile_name)
        if changed:
            _LARK_CLI_CONFIGURED = True
        return changed
    app_id, app_secret = get_app_credentials()
    result = subprocess.run(
        [
            "lark-cli",
            "config",
            "init",
            "--name",
            profile_name,
            "--app-id",
            app_id,
            "--app-secret-stdin",
            "--brand",
            "feishu",
            "--lang",
            "zh",
        ],
        input=app_secret + "\n",
        capture_output=True,
        text=True,
        timeout=30,
        env=ensure_lark_cli_environment(),
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if not _is_lark_cli_profile_exists_error(detail):
            if _is_openclaw_config_refused_text(detail):
                return False
            raise RuntimeError(f"自动配置 lark-cli 失败：{detail[:240]}")
    if _should_auto_bind_lark_cli():
        _bind_lark_cli_to_openclaw(profile_name)
    _LARK_CLI_CONFIGURED = True
    return True


def _auth_check_scopes_payload(
    required_scopes: list[str],
    *,
    auto_configure: bool = True,
) -> dict | None:
    result, payload = _auth_check_scopes_result(
        required_scopes,
        auto_configure=auto_configure,
    )
    return payload


def _auth_check_scopes_result(
    required_scopes: list[str],
    *,
    auto_configure: bool = True,
) -> tuple[subprocess.CompletedProcess, dict | None]:
    if not required_scopes:
        empty = subprocess.CompletedProcess([], 0, "", "")
        return empty, None
    result = _lc(
        "auth",
        "check",
        "--scope",
        " ".join(required_scopes),
        timeout=20,
        auto_configure=auto_configure,
    )
    payload = _extract_json_object((result.stdout or "").strip()) or _extract_json_object(
        (result.stderr or "").strip()
    )
    return result, payload


def _auth_check_scopes_ok(required_scopes: list[str], payload: dict | None = None) -> bool:
    if payload is None:
        payload = _auth_check_scopes_payload(required_scopes)
    return isinstance(payload, dict) and payload.get("ok") is True


def _missing_scopes_ordered_from_check(
    payload: dict | None, required_scopes: list[str]
) -> list[str]:
    if not required_scopes:
        return []
    if not isinstance(payload, dict) or payload.get("ok") is True:
        return []
    raw_missing = payload.get("missing")
    if not isinstance(raw_missing, list):
        return list(required_scopes)
    missing = {str(item or "").strip() for item in raw_missing if str(item or "").strip()}
    return [scope for scope in required_scopes if scope in missing]


def _command_result_detail(result: subprocess.CompletedProcess) -> str:
    return "\n".join(
        part for part in ((result.stdout or "").strip(), (result.stderr or "").strip()) if part
    ).strip()


def _approval_query_probe_result(*, auto_configure: bool = True) -> subprocess.CompletedProcess:
    return _lc(
        "approval",
        "tasks",
        "query",
        "--params",
        json.dumps({"topic": 1, "page_size": 1}),
        "--format",
        "json",
        "--as",
        "user",
        timeout=30,
        auto_configure=auto_configure,
    )


def _approval_query_probe(*, auto_configure: bool = True) -> bool:
    result = _approval_query_probe_result(auto_configure=auto_configure)
    return result.returncode == 0


def check_auth_state(
    auth_mode: str = AUTH_MODE_READ,
    *,
    auto_configure: bool = True,
    probe: bool = True,
) -> AuthState:
    ensure_lark_cli_installed()
    required_scopes = required_scopes_for_mode(auth_mode)
    auth_result, payload = _auth_check_scopes_result(
        required_scopes,
        auto_configure=auto_configure,
    )
    auth_detail = _command_result_detail(auth_result)
    auth_recovery = _lark_cli_recovery_reason(auth_result)
    if auth_recovery == _RECOVERY_REASON_BIND_REQUIRED and _should_auto_bind_lark_cli():
        return AuthState(
            status="bind_required",
            required_scopes=list(required_scopes),
            requested_scopes=list(required_scopes),
            detail=auth_detail,
        )
    if not _auth_check_scopes_ok(required_scopes, payload):
        requested_scopes = _missing_scopes_ordered_from_check(payload, required_scopes)
        if not requested_scopes:
            requested_scopes = list(required_scopes)
        return AuthState(
            status="authorization_required",
            required_scopes=list(required_scopes),
            requested_scopes=list(requested_scopes),
            detail=auth_detail,
        )
    # scope 满足即视为已授权，不再跑真实 `approval tasks query` 探针：探针因任何
    # 非鉴权原因（瞬时失败、空结果等）返回非 0 都会被降级成 authorization_required，
    # 导致反复拉起登录。一次授权 read+write 后即生效。`probe` 形参仅为兼容调用签名。
    return AuthState(
        status="authorized",
        required_scopes=list(required_scopes),
        requested_scopes=[],
        detail="",
    )


def check_auth_valid(
    auth_mode: str = AUTH_MODE_READ,
    *,
    silent: bool = False,
    auto_configure: bool = True,
    probe: bool = True,
) -> bool:
    state = check_auth_state(
        auth_mode,
        auto_configure=auto_configure,
        probe=probe,
    )
    if state.status == "bind_required":
        if not silent:
            print("需要先绑定当前 OpenClaw 环境（lark-cli 尚未绑定到当前上下文）", file=sys.stderr)
        return False
    if state.status != "authorized":
        if not silent:
            print("需要授权（当前 token 未具备本次审批操作所需 scope，或未登录）", file=sys.stderr)
        return False
    if not silent:
        print("Token 有效，无需授权", file=sys.stderr)
    return True


def ensure_auth_valid(auth_mode: str = AUTH_MODE_READ) -> None:
    mode = _normalize_auth_mode(auth_mode)
    now = time.time()
    if now < _AUTH_CACHE_EXPIRES_AT.get(mode, 0.0):
        return

    state = check_auth_state(mode)
    if state.status == "authorized":
        ttl = _auth_access_cache_ttl_seconds()
        if ttl > 0:
            expires_at = now + ttl
            _AUTH_CACHE_EXPIRES_AT[mode] = expires_at
            if mode == AUTH_MODE_WRITE:
                _AUTH_CACHE_EXPIRES_AT[AUTH_MODE_READ] = max(
                    _AUTH_CACHE_EXPIRES_AT.get(AUTH_MODE_READ, 0.0),
                    expires_at,
                )
        return

    _AUTH_CACHE_EXPIRES_AT[mode] = 0.0
    if state.status == "bind_required":
        raise OpenClawBindingRequiredError(state.detail or "openclaw binding required")
    raise AuthorizationRequiredError("approval authorization required")


def _wait_auth_url_from_proc(
    proc: subprocess.Popen,
    timeout_sec: float = 30.0,
) -> str:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        line = (proc.stdout.readline() if proc.stdout else "") or ""
        if line:
            if url := extract_auth_url(line):
                return url
        if proc.poll() is not None and not line:
            break
        time.sleep(0.05)
    return ""


def _extract_auth_login_payload(stdout: str, stderr: str) -> dict | None:
    combined = "\n".join(
        part for part in ((stdout or "").strip(), (stderr or "").strip()) if part
    )
    return (
        _extract_json_object(stdout)
        or _extract_json_object(stderr)
        or _extract_json_object(combined)
    )


def _spawn_login_wait_process(
    *args: str,
    background: bool = False,
    auto_configure: bool = True,
) -> subprocess.Popen:
    cmd = ["lark-cli", "--profile", get_lark_profile_name(), *args]
    env = ensure_lark_cli_environment()
    popen_kwargs: dict[str, Any] = {
        "text": True,
        "env": env,
    }
    if background:
        popen_kwargs.update(
            {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "start_new_session": True,
            }
        )
    else:
        popen_kwargs.update(
            {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
            }
        )
    proc = subprocess.Popen(cmd, **popen_kwargs)
    if proc.poll() is None:
        return proc

    stdout = ""
    stderr = ""
    if not background:
        with contextlib.suppress(Exception):
            stdout, stderr = proc.communicate(timeout=1)
    completed = subprocess.CompletedProcess(
        cmd,
        proc.returncode if proc.returncode is not None else 1,
        stdout or "",
        stderr or "",
    )
    recovery_reason = _lark_cli_recovery_reason(completed)
    if auto_configure and recovery_reason:
        changed = _configure_lark_cli(recovery_reason=recovery_reason)
        if not changed:
            return proc
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
    return proc


def start_oauth_login_if_needed(
    auth_mode: str = AUTH_MODE_READ,
    *,
    force_logout: bool = False,
    background_wait: bool = False,
) -> PendingAuth | None:
    auth_state = check_auth_state(auth_mode, auto_configure=True, probe=False)
    required_scopes = list(auth_state.required_scopes)
    if auth_state.status == "authorized":
        return None
    if auth_state.status == "bind_required":
        profile_name = get_lark_profile_name(refresh=True)
        try:
            changed = _bind_lark_cli_to_openclaw(profile_name)
        except Exception as exc:
            detail = str(exc or "").strip()
            raise OpenClawBindingRequiredError(
                detail or auth_state.detail or "openclaw context detected but lark-cli is not bound to it"
            ) from exc
        if not changed:
            raise OpenClawBindingRequiredError(
                auth_state.detail or "openclaw context detected but lark-cli is not bound to it"
            )
        auth_state = check_auth_state(auth_mode, auto_configure=True, probe=False)
        required_scopes = list(auth_state.required_scopes)
        if auth_state.status == "authorized":
            return None
        # 某些 OpenClaw + lark-cli 组合下，auth status/auth check 已经 ready，
        # 但审批技能内部的绑定探针仍会误报 bind_required。这里做一次
        # 显式 scope 复核：只要审批 scope 已具备，就继续登录/查询链路，
        # 不再因为误判卡死在 bind_required。
        if auth_state.status == "bind_required":
            check_payload = _auth_check_scopes_payload(required_scopes, auto_configure=True)
            if _auth_check_scopes_ok(required_scopes, check_payload):
                auth_state = AuthState(
                    status="authorized",
                    required_scopes=list(required_scopes),
                    requested_scopes=list(required_scopes),
                    detail="bind probe false positive ignored because required scopes are already granted",
                )
            else:
                raise OpenClawBindingRequiredError(
                    auth_state.detail or "openclaw context detected but lark-cli is not bound to it"
                )

    if force_logout:
        _lc("auth", "logout", timeout=20)

    # `auth check` 只能说明当前 token 具备声明过的 scope，不能保证审批查询
    # 所需的用户态授权一定可用。只要真实审批探针失败，就继续走显式登录链路。
    requested_scopes = list(auth_state.requested_scopes or [])
    if not requested_scopes:
        requested_scopes = list(required_scopes)

    try:
        login_start = _lc(
            "auth",
            "login",
            "--scope",
            " ".join(requested_scopes),
            "--no-wait",
            "--json",
            timeout=30,
        )
    except OpenClawBindingRequiredError:
        check_payload = _auth_check_scopes_payload(required_scopes, auto_configure=True)
        if _auth_check_scopes_ok(required_scopes, check_payload):
            return None
        raise
    login_start_payload = _extract_auth_login_payload(
        login_start.stdout or "",
        login_start.stderr or "",
    )
    verification_url = ""
    device_code = ""
    if isinstance(login_start_payload, dict):
        verification_url = str(
            login_start_payload.get("verification_url")
            or login_start_payload.get("verificationUrl")
            or login_start_payload.get("url")
            or ""
        ).strip()
        device_code = str(
            login_start_payload.get("device_code")
            or login_start_payload.get("deviceCode")
            or ""
        ).strip()
    if verification_url and device_code:
        proc = _spawn_login_wait_process(
            "auth",
            "login",
            "--device-code",
            device_code,
            background=background_wait,
        )
        return PendingAuth(
            proc=proc,
            auth_url=verification_url,
            requested_scopes=requested_scopes,
        )

    proc = _spawn_login_wait_process(
        "auth",
        "login",
        "--scope",
        " ".join(requested_scopes),
    )
    auth_url = _wait_auth_url_from_proc(proc)
    if auth_url:
        return PendingAuth(proc=proc, auth_url=auth_url, requested_scopes=requested_scopes)

    if proc.poll() is None:
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=5)

    detail = (login_start.stderr or login_start.stdout or "").strip()
    if login_start.returncode != 0 and detail:
        if _is_openclaw_bind_required_text(detail):
            check_payload = _auth_check_scopes_payload(required_scopes, auto_configure=True)
            if _auth_check_scopes_ok(required_scopes, check_payload):
                return None
            raise OpenClawBindingRequiredError(detail[:240])
        raise RuntimeError(detail[:240])
    raise RuntimeError("无法从 lark-cli auth login 输出中提取授权链接")


def spawn_send_auth_and_wait(
    *,
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "",
    auth_mode: str = AUTH_MODE_READ,
    timeout: float = 240.0,
) -> tuple[dict | None, subprocess.CompletedProcess]:
    """Run scripts/send_auth_and_wait.py as a subprocess and return its JSON output.

    Returns a tuple of (parsed payload dict or None, raw subprocess result).
    When `receive_id_type` is empty it defaults to 'open_id' if `sender_id` is
    provided, otherwise 'chat_id' — matching the query/action entrypoints.
    """

    # core/auth.py → scripts/ (one level up) where send_auth_and_wait.py lives.
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    script_path = os.path.join(script_dir, "send_auth_and_wait.py")
    cmd = [sys.executable or "python3", script_path, "--auth-mode", auth_mode]
    if sender_id:
        cmd.extend(["--sender-id", sender_id])
    if chat_id:
        cmd.extend(["--chat-id", chat_id])
    resolved_rt = (
        (receive_id_type or "").strip()
        or ("open_id" if (sender_id or "").strip() else "chat_id")
    )
    cmd.extend(["--receive-id-type", resolved_rt])
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=script_dir,
    )
    combined = "\n".join(
        part
        for part in ((result.stdout or "").strip(), (result.stderr or "").strip())
        if part
    )
    payload = extract_json_object(combined)
    return (payload if isinstance(payload, dict) else None), result


__all__ = [
    "AUTH_MODE_READ",
    "AUTH_MODE_WRITE",
    "AuthState",
    "OpenClawBindingRequiredError",
    "PendingAuth",
    "check_auth_state",
    "check_auth_valid",
    "ensure_auth_valid",
    "required_scopes_for_mode",
    "spawn_send_auth_and_wait",
    "start_oauth_login_if_needed",
]
