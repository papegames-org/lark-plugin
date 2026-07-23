#!/usr/bin/env python3
"""Card-first approval query entrypoint.

The wrapper keeps the auth-first contract, but optimizes the common path:
1. Try a silent local auth probe first.
2. Only when the probe fails, execute send_auth_and_wait.py.
3. After auth is confirmed, invoke workkit_query.py with --skip-auth.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import traceback
from typing import Any, Dict

from approval_auth import check_auth_state, spawn_send_auth_and_wait
from common import (
    LOG_PREVIEW_MAX,
    extract_json_object,
    log_debug_event,
    operate_log_path,
    preview_text,
    redact_sensitive_fields,
)


AUTH_MODE_READ = "read"


def _scripts_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _workkit_query_script_path() -> str:
    return os.path.join(_scripts_dir(), "workkit_query.py")


def _query_backend_script_path() -> str:
    return _workkit_query_script_path()


# Alias kept for in-module call sites; canonical implementation lives in common.
_extract_json_object = extract_json_object


def _echo_subprocess_result(result: subprocess.CompletedProcess) -> None:
    stdout = str(result.stdout or "")
    stderr = str(result.stderr or "")
    if stdout:
        print(stdout, end="")
    if stderr:
        print(stderr, end="", file=sys.stderr)


def _log_fetch_query_result(
    fetch_result: subprocess.CompletedProcess,
    *,
    output: str,
    topic: int,
    page_size: int,
    max_items: int,
    description: str,
    applicant: str,
    process: str,
    arrived_after: str,
    started_after: str,
    started_before: str,
    started_on: str,
) -> None:
    stdout = str(fetch_result.stdout or "")
    stderr = str(fetch_result.stderr or "")
    fields: Dict[str, Any] = {
        "output": str(output or "feishu_card"),
        "returncode": int(fetch_result.returncode or 0),
        "topic": int(topic),
        "page_size": int(page_size),
        "max_items": int(max_items),
    }
    if (description or "").strip():
        fields["query_description"] = str(description).strip()
    if (applicant or "").strip():
        fields["query_applicant"] = str(applicant).strip()
    if (process or "").strip():
        fields["query_process"] = str(process).strip()
    if (arrived_after or "").strip():
        fields["query_arrived_after"] = str(arrived_after).strip()
    if (started_after or "").strip():
        fields["query_started_after"] = str(started_after).strip()
    if (started_before or "").strip():
        fields["query_started_before"] = str(started_before).strip()
    if (started_on or "").strip():
        fields["query_started_on"] = str(started_on).strip()
    parsed = _extract_json_object(stdout)
    if parsed is not None:
        redacted = redact_sensitive_fields(parsed)
        serialized = json.dumps(redacted, ensure_ascii=False, default=str)
        if len(serialized) > LOG_PREVIEW_MAX:
            fields["query_result_preview"] = preview_text(serialized)
        else:
            fields["query_result"] = redacted
    elif stdout.strip():
        fields["stdout_preview"] = preview_text(stdout)
    if stderr.strip():
        fields["stderr_preview"] = preview_text(stderr)
    log_debug_event("approval.query_approvals.fetch_result", **fields)


def _safe_operate_log_path() -> str:
    try:
        return operate_log_path()
    except Exception:
        return ""


def run_query_flow(
    *,
    topic: int = 1,
    page_size: int = 100,
    description: str = "",
    applicant: str = "",
    process: str = "",
    arrived_after: str = "",
    started_after: str = "",
    started_before: str = "",
    started_on: str = "",
    max_items: int = 100,
    output: str = "feishu_card",
    send_card: str = "",
    send_chat_id: str = "",
    send_dry_run: bool = False,
    card_style: str = "",
    describe_overrides_json: str = "",
    auto_summarize: bool = True,
    fetch_oa_details: bool = True,
) -> int:
    auth_state = check_auth_state(
        AUTH_MODE_READ,
        auto_configure=True,
        probe=True,
    )
    if auth_state.status != "authorized":
        sender_id = send_card.strip() if (send_card or "").strip() else ""
        chat_id = send_chat_id.strip() if not sender_id and (send_chat_id or "").strip() else ""
        receive_id_type = "open_id" if sender_id else ("chat_id" if chat_id else "")
        auth_payload, auth_result = spawn_send_auth_and_wait(
            sender_id=sender_id,
            chat_id=chat_id,
            receive_id_type=receive_id_type,
            auth_mode=AUTH_MODE_READ,
        )
        if not (isinstance(auth_payload, dict) and bool(auth_payload.get("authorized"))):
            _echo_subprocess_result(auth_result)
            return 2

    fetch_cmd = [
        sys.executable or "python3",
        _query_backend_script_path(),
        "--skip-auth",
        "--output",
        str(output or "feishu_card"),
    ]
    if int(topic) != 1:
        fetch_cmd.extend(["--topic", str(int(topic))])
    if int(page_size) != 100:
        fetch_cmd.extend(["--page-size", str(int(page_size))])
    if int(max_items) != 100:
        fetch_cmd.extend(["--max-items", str(int(max_items))])
    if description:
        fetch_cmd.extend(["--description", str(description)])
    if applicant:
        fetch_cmd.extend(["--applicant", str(applicant)])
    if process:
        fetch_cmd.extend(["--process", str(process)])
    if arrived_after:
        fetch_cmd.extend(["--arrived-after", str(arrived_after)])
    if started_after:
        fetch_cmd.extend(["--started-after", str(started_after)])
    if started_before:
        fetch_cmd.extend(["--started-before", str(started_before)])
    if started_on:
        fetch_cmd.extend(["--started-on", str(started_on)])
    if str(describe_overrides_json or "").strip():
        fetch_cmd.extend(["--describe-overrides-json", str(describe_overrides_json).strip()])
    if not auto_summarize:
        fetch_cmd.append("--no-auto-summarize")
    if fetch_oa_details:
        fetch_cmd.append("--fetch-oa-details")
    else:
        fetch_cmd.append("--no-fetch-oa-details")
    if (send_card or "").strip():
        fetch_cmd.extend(["--send-card", send_card.strip()])
    if (send_chat_id or "").strip():
        fetch_cmd.extend(["--send-chat-id", send_chat_id.strip()])
    if send_dry_run:
        fetch_cmd.append("--send-dry-run")
    if str(card_style or "").strip():
        fetch_cmd.extend(["--card-style", str(card_style).strip()])

    fetch_result = subprocess.run(
        fetch_cmd,
        capture_output=True,
        text=True,
        timeout=240,
        cwd=_scripts_dir(),
    )
    _log_fetch_query_result(
        fetch_result,
        output=output,
        topic=topic,
        page_size=page_size,
        max_items=max_items,
        description=description,
        applicant=applicant,
        process=process,
        arrived_after=arrived_after,
        started_after=started_after,
        started_before=started_before,
        started_on=started_on,
    )
    _echo_subprocess_result(fetch_result)
    return int(fetch_result.returncode or 0)


def main() -> None:
    parser = argparse.ArgumentParser(description="卡片优先的审批查询入口")
    parser.add_argument("--topic", type=int, default=1, help="查询主题，默认 1=待办")
    parser.add_argument("--page-size", type=int, default=100, help="分页大小")
    parser.add_argument("--description", "--search", default="", help="按审批描述/类型/摘要关键词筛选")
    parser.add_argument("--applicant", "--initiator", default="", help="按申请人/发起人筛选")
    parser.add_argument("--process", "--flow", default="", help="按流程名/审批类型筛选")
    parser.add_argument("--arrived-after", "--arrival-after", default="", help="筛选指定时间之后到达的审批")
    parser.add_argument("--started-after", "--start-after", default="", help="筛选指定时间之后发起的审批")
    parser.add_argument("--started-before", "--start-before", default="", help="筛选指定时间之前发起的审批")
    parser.add_argument("--started-on", "--start-on", default="", help="筛选指定日期发起的审批")
    parser.add_argument("--max-items", type=int, default=100, help="最多获取前 N 条数据，默认 100")
    parser.add_argument(
        "--output",
        default="feishu_card",
        choices=["json", "feishu_card"],
    )
    parser.add_argument("--send-card", metavar="OPEN_ID", default="", help="将结果卡片发送给 open_id")
    parser.add_argument("--send-chat-id", metavar="CHAT_ID", default="", help="将结果卡片发送到 chat_id")
    parser.add_argument("--send-dry-run", action="store_true", help="仅输出脱敏后的卡片预览")
    parser.add_argument(
        "--card-style",
        default=os.environ.get("WORKKIT_APPROVAL_CARD_STYLE", ""),
        help="审批结果卡片样式，默认 table-summary；测试回退旧卡可用 collapse",
    )
    parser.add_argument(
        "--describe-overrides-json",
        default="",
        help="由上层 agent 生成的 describe 覆盖 JSON；支持按 group_key 或 index 回填 summary",
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
    parser.add_argument(
        "--no-fetch-oa-details",
        action="store_true",
        help="禁用 OA 流程详情补充",
    )
    args = parser.parse_args()

    try:
        use_auto_summarize = args.auto_summarize and not getattr(args, "no_auto_summarize", False)
        code = run_query_flow(
            topic=args.topic,
            page_size=args.page_size,
            description=args.description,
            applicant=args.applicant,
            process=args.process,
            arrived_after=args.arrived_after,
            started_after=args.started_after,
            started_before=args.started_before,
            started_on=args.started_on,
            max_items=args.max_items,
            output=args.output,
            send_card=args.send_card,
            send_chat_id=args.send_chat_id,
            send_dry_run=args.send_dry_run,
            card_style=args.card_style,
            describe_overrides_json=args.describe_overrides_json,
            auto_summarize=use_auto_summarize,
            fetch_oa_details=not bool(args.no_fetch_oa_details),
        )
        if code:
            sys.exit(code)
    except Exception as exc:
        log_path = _safe_operate_log_path()
        log_debug_event(
            "approval.query_approvals.failed",
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
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
