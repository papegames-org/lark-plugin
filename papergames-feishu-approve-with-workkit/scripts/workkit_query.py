#!/usr/bin/env python3
"""Approval query bridge for the workkit migration.

Delegates approval query, card rendering, history, and snapshot state to the
vendored workkit CLI. This file stays as a thin Python shell so the skill can
keep its auth/send contracts while business logic lives in workkit.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict

from common import (
    build_result_card_send_payload,
    ensure_lark_cli_environment,
    get_lark_profile_name,
    log_debug_event,
    redact_sensitive_fields,
    resolve_receive_target,
    send_interactive_message,
)
DEFAULT_FETCH_LIMIT = 100
WORKKIT_BACKEND = "workkit"
DEFAULT_CARD_STYLE = "table-summary"
TABLE_SUMMARY_MAX_ITEMS_PER_CARD = 5
FETCH_OA_DETAILS_DEFAULT = os.environ.get(
    "PAPER_FEISHU_APPROVE_FETCH_OA_DETAILS",
    "1",
).strip().lower() not in {"0", "false", "no", "off"}
DEFAULT_CARD_TTL_SECONDS = 30 * 60


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _scripts_dir() -> Path:
    return Path(__file__).resolve().parent


def _query_backend() -> str:
    return WORKKIT_BACKEND


def _default_workkit_root() -> Path:
    return _skill_root().parents[1] / "workkit"


def _vendored_workkit_root() -> Path:
    return _skill_root() / "vendor" / "workkit"


def _workkit_root() -> Path:
    explicit = os.environ.get("WORKKIT_ROOT")
    if explicit:
        return Path(explicit).resolve()
    vendored = _vendored_workkit_root()
    if vendored.exists():
        return vendored.resolve()
    return _default_workkit_root().resolve()


def _node_command() -> str:
    explicit = os.environ.get("WORKKIT_NODE")
    if explicit:
        return explicit
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError("未找到 node，请设置 WORKKIT_NODE 或把 node 加入 PATH")


def _workkit_cli_entry() -> Path:
    root = _workkit_root()
    entry = root / "packages" / "cli" / "dist" / "index.js"
    if not entry.exists():
        raise RuntimeError(f"workkit CLI 未构建，请先在 {root} 执行 pnpm build")
    return entry


def _normalize_card_style(value: str = "") -> str:
    normalized = str(value or "").strip().lower().replace("_", "-")
    if normalized in {"collapse", "old", "legacy"}:
        return "collapse"
    if normalized in {"simple", "list"}:
        return "simple"
    return DEFAULT_CARD_STYLE


def _default_card_style() -> str:
    return _normalize_card_style(
        os.environ.get("WORKKIT_APPROVAL_CARD_STYLE")
        or os.environ.get("APPROVAL_CARD_STYLE")
        or DEFAULT_CARD_STYLE
    )


def _run_workkit(args: list[str]) -> Dict[str, Any]:
    env = dict(os.environ)
    env.update(ensure_lark_cli_environment())
    profile = get_lark_profile_name()
    if profile:
        env["WORKKIT_LARK_PROFILE"] = profile
    result = subprocess.run(
        [_node_command(), str(_workkit_cli_entry()), *args],
        capture_output=True,
        text=True,
        timeout=240,
        cwd=str(_workkit_root()),
        env=env,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "workkit CLI 执行失败").strip()
        raise RuntimeError(detail[:500])
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("workkit CLI 输出不是合法 JSON") from exc
    return payload if isinstance(payload, dict) else {"ok": False, "data": payload}


def _sources_include_oa(sources: str) -> bool:
    return "oa" in {
        part.strip().lower()
        for part in str(sources or "").split(",")
        if part.strip()
    }


def _oa_auth_script_path() -> Path:
    return _scripts_dir() / "oa_send_auth_and_wait.py"


def _oa_auth_required(envelope: Dict[str, Any]) -> bool:
    warnings = envelope.get("warnings") or []
    if any(isinstance(warning, dict) and warning.get("code") == "OA_AUTH_REQUIRED" for warning in warnings):
        return True
    data = envelope.get("data")
    if not isinstance(data, dict):
        return False
    auth_state = data.get("authState")
    if not isinstance(auth_state, dict):
        return False
    oa_state = auth_state.get("oa")
    return (
        isinstance(oa_state, dict)
        and bool(oa_state.get("required"))
        and not bool(oa_state.get("ok"))
    )


def _run_oa_auth_flow(*, sender_id: str = "", chat_id: str = "") -> bool:
    cmd = [sys.executable or "python3", str(_oa_auth_script_path())]
    clean_sender = str(sender_id or "").strip()
    clean_chat = str(chat_id or "").strip()
    if clean_sender:
        cmd.extend(["--sender-id", clean_sender, "--receive-id-type", "open_id"])
    if clean_chat:
        cmd.extend(["--chat-id", clean_chat, "--receive-id-type", "chat_id"])
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=260,
        cwd=str(_scripts_dir()),
    )
    payload: Dict[str, Any] | None = None
    try:
        parsed = json.loads(str(result.stdout or "").strip() or "{}")
        payload = parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        payload = None
    log_debug_event(
        "approval.workkit_query.oa_auth_result",
        returncode=int(result.returncode or 0),
        status=str((payload or {}).get("status") or ""),
        authorized=bool((payload or {}).get("authorized")),
        stderr_preview=str(result.stderr or "")[:500],
    )
    return result.returncode == 0 and isinstance(payload, dict) and bool(payload.get("authorized"))


def _maybe_authorize_oa_and_retry(
    envelope: Dict[str, Any],
    cmd: list[str],
    *,
    sender_id: str = "",
    chat_id: str = "",
) -> Dict[str, Any]:
    if not _oa_auth_required(envelope):
        return envelope
    if os.environ.get("PAPER_FEISHU_APPROVE_REQUIRE_OA_AUTH", "1").strip().lower() in {"0", "false", "no", "off"}:
        return envelope
    if not _run_oa_auth_flow(sender_id=sender_id, chat_id=chat_id):
        raise RuntimeError("需要补充授权")
    retried = _run_workkit(cmd)
    return retried


def query_inbox(
    *,
    description: str = "",
    applicant: str = "",
    process: str = "",
    arrived_after: str = "",
    started_after: str = "",
    started_before: str = "",
    started_on: str = "",
    max_items: int = DEFAULT_FETCH_LIMIT,
    sources: str = "feishu,oa,beisen",
    fetch_oa_details: bool = FETCH_OA_DETAILS_DEFAULT,
    auth_sender_id: str = "",
    auth_chat_id: str = "",
    log_result: bool = True,
) -> Dict[str, Any]:
    cmd = [
        "approval",
        "inbox",
        "list",
        "--user",
        "current",
        "--view",
        "pending_all",
        "--limit",
        str(max_items),
        "--sources",
        sources,
        "--json",
    ]
    if description:
        cmd.extend(["--description", description])
    if applicant:
        cmd.extend(["--applicant", applicant])
    if process:
        cmd.extend(["--process", process])
    if arrived_after:
        cmd.extend(["--arrived-after", arrived_after])
    if started_after:
        cmd.extend(["--started-after", started_after])
    if started_before:
        cmd.extend(["--started-before", started_before])
    if started_on:
        cmd.extend(["--started-on", started_on])
    if fetch_oa_details and _sources_include_oa(sources):
        cmd.append("--fetch-oa-details")
    else:
        cmd.append("--no-fetch-oa-details")
    envelope = _run_workkit(cmd)
    envelope = _maybe_authorize_oa_and_retry(
        envelope,
        cmd,
        sender_id=auth_sender_id,
        chat_id=auth_chat_id,
    )
    if log_result:
        log_debug_event(
            "approval.workkit_query.inbox_result",
            ok=bool(envelope.get("ok")),
            partial=bool(envelope.get("meta", {}).get("partial")),
            warning_count=len(envelope.get("warnings") or []),
    )
    return envelope


def _write_temp_json(payload: Dict[str, Any]) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as tmp:
        json.dump(payload, tmp, ensure_ascii=False)
        return tmp.name


def render_inbox_cards(
    envelope: Dict[str, Any],
    *,
    description: str = "",
    describe_overrides_json: str = "",
    query_nonce: str = "",
    expires_at: str = "",
    receive_id: str = "",
    card_style: str = "",
) -> Dict[str, Any]:
    tmp_path = _write_temp_json(envelope)
    style = _normalize_card_style(card_style or _default_card_style())
    try:
        cmd = [
            "approval",
            "card",
            "render",
            "inbox",
            "--input",
            tmp_path,
            "--style",
            style,
            "--split",
            "--json",
        ]
        if receive_id:
            cmd.extend(["--receive-id", receive_id])
        if description:
            cmd.extend(["--description", description])
        if describe_overrides_json:
            cmd.extend(["--describe-overrides-json", describe_overrides_json])
        if query_nonce:
            cmd.extend(["--query-nonce", query_nonce])
        if expires_at:
            cmd.extend(["--expires-at", expires_at])
        if style == "table-summary":
            cmd.extend([
                "--max-items-per-group",
                str(TABLE_SUMMARY_MAX_ITEMS_PER_CARD),
                "--max-items-per-card",
                str(TABLE_SUMMARY_MAX_ITEMS_PER_CARD),
            ])
        return _run_workkit(cmd)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def generate_ai_overrides_json(envelope: Dict[str, Any]) -> str:
    payload: Dict[str, Any] = envelope
    data = envelope.get("data")
    if isinstance(data, dict) and isinstance(data.get("summaryContext"), dict):
        payload = data["summaryContext"]
    tmp_path = _write_temp_json(payload)
    try:
        result = _run_workkit([
            "approval",
            "ai-overrides",
            "--input",
            tmp_path,
            "--json",
        ])
    except Exception as exc:  # noqa: BLE001
        log_debug_event(
            "approval.workkit_query.ai_overrides_failed",
            error_type=type(exc).__name__,
            error_message=str(exc)[:500],
        )
        return ""
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    data = result.get("data")
    overrides = data.get("overrides") if isinstance(data, dict) else []
    warnings = result.get("warnings") or []
    log_debug_event(
        "approval.workkit_query.ai_overrides_result",
        ok=bool(result.get("ok")),
        override_count=len(overrides) if isinstance(overrides, list) else 0,
        warning_count=len(warnings) if isinstance(warnings, list) else 0,
    )
    if not isinstance(overrides, list) or not overrides:
        return ""
    return json.dumps(overrides, ensure_ascii=False)


def _cards_from_render_result(rendered: Dict[str, Any]) -> list[Dict[str, Any]]:
    if rendered.get("type") == "inline_v2_shards":
        cards = (rendered.get("data") or {}).get("cards") or []
        return [card for card in cards if isinstance(card, dict)]
    return [rendered] if isinstance(rendered, dict) else []


def _card_shards_from_render_result(rendered: Dict[str, Any]) -> list[Dict[str, Any]]:
    if rendered.get("type") != "inline_v2_shards":
        return []
    shards = (rendered.get("data") or {}).get("card_shards") or []
    return [shard for shard in shards if isinstance(shard, dict)]


def save_query_snapshot(
    envelope: Dict[str, Any],
    *,
    receive_id: str = "",
    receive_id_type: str = "",
    response: Dict[str, Any] | None = None,
    description: str = "",
    describe_overrides_json: str = "",
    query_nonce: str = "",
    expires_at: str = "",
    card_style: str = "",
    card_shards: list[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    tmp_path = _write_temp_json(envelope)
    response = response or {}
    message_id = str((response.get("data") or {}).get("message_id") or "").strip()
    style = _normalize_card_style(card_style or _default_card_style())
    try:
        cmd = [
            "approval",
            "snapshot",
            "save",
            "--input",
            tmp_path,
            "--receive-id",
            receive_id,
            "--receive-id-type",
            receive_id_type,
            "--message-id",
            message_id,
            "--description",
            description,
            "--query-nonce",
            query_nonce,
            "--card-style",
            style,
            "--json",
        ]
        if expires_at:
            cmd.extend(["--expires-at", expires_at])
        owner = receive_id if receive_id_type == "open_id" else str(os.environ.get("OPENCLAW_SENDER_ID") or "").strip()
        if owner:
            cmd.extend(["--owner-open-id", owner])
        if describe_overrides_json:
            cmd.extend(["--describe-overrides-json", describe_overrides_json])
        if card_shards:
            cmd.extend(["--card-shards-json", json.dumps(card_shards, ensure_ascii=False)])
        return _run_workkit(cmd)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _redacted_json(data: Dict[str, Any]) -> str:
    return json.dumps(redact_sensitive_fields(data), ensure_ascii=False, indent=2)


def send_result_card(card: Dict[str, Any], *, user_open_id: str = "", chat_id: str = "") -> Dict[str, Any]:
    if bool((user_open_id or "").strip()) == bool((chat_id or "").strip()):
        raise ValueError("发送结果卡片时必须且只能指定 user_open_id 或 chat_id 之一")
    receive_id, receive_id_type = resolve_receive_target(
        sender_id=user_open_id,
        chat_id=chat_id,
        receive_id_type="open_id" if (user_open_id or "").strip() else "chat_id",
    )
    if not receive_id:
        raise ValueError("发送结果卡片时未解析出有效的飞书接收目标")
    return send_interactive_message(
        build_result_card_send_payload({"type": "inline_v2", "data": {"card": card}}),
        receive_id=receive_id,
        receive_id_type=receive_id_type,
    )


def build_query_followup_text(description: str = "", *, card_count: int = 1) -> str:
    return "已发送审批卡片"


def card_expires_at() -> str:
    ttl = _card_ttl_seconds()
    return (datetime.now(timezone.utc) + timedelta(seconds=ttl)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _card_ttl_seconds() -> int:
    raw = (
        os.environ.get("WORKKIT_APPROVAL_CARD_TTL_SECONDS")
        or os.environ.get("PAPER_FEISHU_APPROVE_CARD_TTL_SECONDS")
        or ""
    ).strip()
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_CARD_TTL_SECONDS
    return parsed if parsed > 0 else DEFAULT_CARD_TTL_SECONDS


def main() -> None:
    parser = argparse.ArgumentParser(description="通过 workkit 查询员工事务审批")
    parser.add_argument("--topic", type=int, default=1, help="查询主题，默认 1=待办")
    parser.add_argument("--page-size", type=int, default=DEFAULT_FETCH_LIMIT, help="兼容旧参数")
    parser.add_argument("--description", "--search", default="", help="按审批描述/类型/摘要关键词筛选")
    parser.add_argument("--applicant", "--initiator", default="", help="按申请人/发起人筛选")
    parser.add_argument("--process", "--flow", default="", help="按流程名/审批类型筛选")
    parser.add_argument("--arrived-after", "--arrival-after", default="", help="筛选指定时间之后到达的审批")
    parser.add_argument("--started-after", "--start-after", default="", help="筛选指定时间之后发起的审批")
    parser.add_argument("--started-before", "--start-before", default="", help="筛选指定时间之前发起的审批")
    parser.add_argument("--started-on", "--start-on", default="", help="筛选指定日期发起的审批")
    parser.add_argument("--max-items", type=int, default=DEFAULT_FETCH_LIMIT, help="最多获取前 N 条数据")
    parser.add_argument(
        "--sources",
        default=os.environ.get("WORKKIT_APPROVAL_SOURCES", "feishu,oa,beisen"),
        help="逗号分隔的审批来源，默认 feishu,oa,beisen",
    )
    parser.add_argument(
        "--output",
        default="feishu_card",
        choices=["json", "feishu_card"],
    )
    parser.add_argument("--send-card", metavar="OPEN_ID", default="", help="将结果卡片发送给 open_id")
    parser.add_argument("--send-chat-id", metavar="CHAT_ID", default="", help="将结果卡片发送到 chat_id")
    parser.add_argument("--send-dry-run", action="store_true", help="仅输出脱敏后的卡片预览")
    parser.add_argument(
        "--fetch-oa-details",
        action="store_true",
        default=FETCH_OA_DETAILS_DEFAULT,
        help="查询列表后补充 OA 流程详情（默认启用，可用环境变量关闭）",
    )
    parser.add_argument(
        "--no-fetch-oa-details",
        action="store_false",
        dest="fetch_oa_details",
        help="禁用 OA 流程详情补充",
    )
    parser.add_argument(
        "--card-style",
        default=_default_card_style(),
        help="审批结果卡片样式，默认 table-summary；测试回退旧卡可用 collapse",
    )
    parser.add_argument("--skip-auth", action="store_true", help="兼容旧参数，鉴权由 query_approvals.py 处理")
    parser.add_argument(
        "--describe-overrides-json",
        default="",
        help="由上层 agent 生成的 describe 覆盖 JSON，交给 workkit card-kit 回填",
    )
    parser.add_argument(
        "--auto-summarize",
        action="store_true",
        default=True,
        help="自动调 workkit 生成 AI summary overrides（默认启用）",
    )
    parser.add_argument(
        "--no-auto-summarize",
        action="store_true",
        dest="no_auto_summarize",
        help="禁用自动 AI summary overrides",
    )
    args = parser.parse_args()

    if int(args.topic or 1) != 1:
        raise ValueError("workkit 当前仅支持待办审批 topic=1")

    envelope = query_inbox(
        description=args.description,
        applicant=args.applicant,
        process=args.process,
        arrived_after=args.arrived_after,
        started_after=args.started_after,
        started_before=args.started_before,
        started_on=args.started_on,
        max_items=args.max_items,
        sources=args.sources,
        fetch_oa_details=bool(args.fetch_oa_details),
        auth_sender_id=args.send_card,
        auth_chat_id=args.send_chat_id,
        log_result=args.output != "json" and not args.send_dry_run,
    )

    if args.output == "json":
        print(_redacted_json(envelope))
        return

    describe_overrides_json = str(args.describe_overrides_json or "").strip()
    should_auto_summarize = (
        bool(args.auto_summarize)
        and not bool(getattr(args, "no_auto_summarize", False))
        and not args.send_dry_run
        and not describe_overrides_json
    )
    if should_auto_summarize:
        describe_overrides_json = generate_ai_overrides_json(envelope)

    query_nonce = secrets.token_hex(6)
    expires_at = card_expires_at()
    send_u = (args.send_card or "").strip()
    send_c = (args.send_chat_id or "").strip()
    if not send_u and not send_c:
        receive_id, receive_type = resolve_receive_target()
        if receive_type == "open_id":
            send_u = receive_id
        elif receive_type == "chat_id":
            send_c = receive_id
    if not send_u and not send_c and not args.send_dry_run:
        raise ValueError("缺少卡片接收目标，无法发送 workkit 审批卡片")

    receive_id = send_u or send_c
    receive_id_type = "open_id" if send_u else "chat_id"
    rendered = render_inbox_cards(
        envelope,
        description=args.description,
        describe_overrides_json=describe_overrides_json,
        query_nonce=query_nonce,
        expires_at=expires_at,
        receive_id=receive_id,
        card_style=args.card_style,
    )
    if args.send_dry_run:
        print(_redacted_json(rendered))
        return

    cards = _cards_from_render_result(rendered)
    if not cards:
        raise ValueError("workkit 未返回可发送的审批卡片")
    shard_defs = _card_shards_from_render_result(rendered)
    responses = []
    card_shards = []
    for index, card in enumerate(cards):
        response = send_result_card(card, user_open_id=send_u, chat_id=send_c)
        responses.append(response)
        shard = dict(shard_defs[index]) if index < len(shard_defs) else {}
        shard["message_id"] = str((response.get("data") or {}).get("message_id") or "").strip()
        card_shards.append(shard)
    save_query_snapshot(
        envelope,
        receive_id=receive_id,
        receive_id_type=receive_id_type,
        response=responses[0] if responses else {},
        description=args.description,
        describe_overrides_json=describe_overrides_json,
        query_nonce=query_nonce,
        expires_at=expires_at,
        card_style=args.card_style,
        card_shards=card_shards,
    )
    print(build_query_followup_text(args.description, card_count=len(cards)))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"workkit 查询审批失败: {str(exc)[:500]}", file=sys.stderr)
        sys.exit(1)
