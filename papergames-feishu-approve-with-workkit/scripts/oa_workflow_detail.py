#!/usr/bin/env python3
"""Fetch and format OA workflow details via paper-api-adapter for approval assist."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from typing import Any, Dict, Iterable, List, Optional, Tuple

from core.logging_utils import log_debug_event


OA_ADAPTER_BASE_URL = os.environ.get(
    "PAPER_OA_ADAPTER_BASE_URL",
    "https://test-paper-api-adapter.diezhi.net/paper-api/adapter/v1/proxy/weaver",
).rstrip("/")

DETAIL_ROW_PRIORITY_FIELDS: Tuple[str, ...] = (
    "费用项目",
    "费用项目1",
    "费用项目-列表",
    "报销金额",
    "核定报销金额",
    "费用金额",
    "费用发生时间",
    "发生事由",
    "税额",
    "税额-发票云",
    "不含税金额",
    "出发地",
    "目的地",
    "出差事由",
    "请假类型",
    "请假天数",
    "开始时间",
    "结束时间",
)

MAIN_FIELD_SKIP_NAMES = frozenset(
    {
        "",
        "—",
        "-",
        "[该字段仅支持显示]",
        "[该字段暂不支持显示]",
        "[该字段暂不支持]",
    }
)

MAIN_FIELD_SKIP_KEYS = frozenset(
    {
        "requestid",
        "requestId",
        "workflowid",
        "workflowId",
    }
)


def _scripts_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _python_command() -> str:
    return os.environ.get("PAPER_API_PYTHON_BIN") or sys.executable or "python3"


def strip_html(value: Any) -> str:
    if value is None:
        return ""
    text = unescape(str(value))
    anchor = re.search(r"<a[^>]*>([^<]*)</a>", text, flags=re.I)
    if anchor and anchor.group(1).strip():
        text = anchor.group(1).strip()
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("[该字段仅支持显示]", "")
        .replace("[该字段暂不支持显示]", "")
        .replace("[该字段暂不支持]", "")
    )
    return re.sub(r"\s+", " ", text).strip()


def normalize_amount(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    text = re.sub(r"[，,]", "", str(value))
    text = re.sub(r"[^\d.\-]", "", text)
    if not text:
        return None
    try:
        num = float(text)
    except ValueError:
        return None
    if not (num == num):  # NaN
        return None
    return num


def format_amount(value: Any) -> str:
    num = normalize_amount(value)
    if num is None:
        return str(value or "").strip()
    return f"{num:.2f}"


def extract_request_id_from_text(text: Any) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    if raw.isdigit():
        return raw

    candidates = [raw]
    decoded = raw
    for _ in range(4):
        try:
            next_decoded = urllib.parse.unquote(decoded)
        except Exception:
            break
        if next_decoded == decoded:
            break
        decoded = next_decoded
        candidates.append(decoded)

    for candidate in candidates:
        match = re.search(r"(?:[?&#]|^)requestid=(\d+)", candidate, flags=re.I)
        if match:
            return match.group(1)
        match = re.search(r"/process/(\d+)", candidate, flags=re.I)
        if match:
            return match.group(1)
    return ""


def extract_request_id_from_item(item: Dict[str, Any]) -> str:
    if not isinstance(item, dict):
        return ""

    direct = str(item.get("oa_request_id") or "").strip()
    if direct.isdigit():
        return direct

    for key in (
        "instance_external_id",
        "instanceExternalId",
        "workflow_request_id",
        "workflowRequestId",
        "process_external_id",
        "process_id",
        "request_id",
        "requestId",
        "requestid",
    ):
        value = str(item.get(key) or "").strip()
        request_id = extract_request_id_from_text(value)
        if request_id:
            return request_id

    raw = item.get("raw")
    if isinstance(raw, dict) and raw is not item:
        request_id = extract_request_id_from_item(raw)
        if request_id:
            return request_id

    for key in ("title_url", "pc_url", "mobile_url", "helpdesk_url", "url", "link"):
        request_id = extract_request_id_from_text(item.get(key))
        if request_id:
            return request_id

    urls = item.get("urls")
    if isinstance(urls, dict):
        for key in ("pc", "mobile", "helpdesk"):
            request_id = extract_request_id_from_text(urls.get(key))
            if request_id:
                return request_id
    return ""


def collect_request_ids_from_group(group: Dict[str, Any]) -> List[str]:
    request_ids: List[str] = []
    seen = set()
    items = group.get("approve_items")
    if not isinstance(items, list) or not items:
        approve_item = group.get("approve_item")
        items = [approve_item] if isinstance(approve_item, dict) else [group]
    for item in items:
        if not isinstance(item, dict):
            continue
        request_id = extract_request_id_from_item(item)
        if request_id and request_id not in seen:
            seen.add(request_id)
            request_ids.append(request_id)
    return request_ids


def request_oa_access_token(
    *,
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "",
) -> str:
    auth_script = os.path.join(_scripts_dir(), "paper_api_auth.py")
    result = subprocess.run(
        [_python_command(), auth_script, "--print-token"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode == 0:
        token = (result.stdout or "").strip()
        if token:
            return token

    if result.returncode != 77:
        message = (result.stderr or result.stdout or "OA token 获取失败").strip()
        raise RuntimeError(message)

    card_script = os.path.join(_scripts_dir(), "oa_send_auth_and_wait.py")
    card_cmd = [_python_command(), card_script]
    if sender_id:
        card_cmd.extend(["--sender-id", sender_id])
    if chat_id:
        card_cmd.extend(["--chat-id", chat_id])
    if receive_id_type:
        card_cmd.extend(["--receive-id-type", receive_id_type])

    card_result = subprocess.run(
        card_cmd,
        capture_output=True,
        text=True,
        timeout=240,
    )
    payload = None
    stdout = (card_result.stdout or "").strip()
    if stdout:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = None

    token = ""
    if isinstance(payload, dict):
        token = str(payload.get("access_token") or payload.get("token") or "").strip()
    if not token and card_result.returncode == 0:
        token = stdout.splitlines()[-1].strip() if stdout else ""
    if token:
        return token

    message = ""
    if isinstance(payload, dict):
        message = str(payload.get("message") or payload.get("error") or "").strip()
    if not message:
        message = (card_result.stderr or card_result.stdout or "OA 授权未完成").strip()
    raise RuntimeError(message)


def fetch_workflow_request(request_id: str, token: str, *, timeout: int = 30) -> Dict[str, Any]:
    clean_id = str(request_id or "").strip()
    if not clean_id:
        raise ValueError("缺少 requestId")
    query = urllib.parse.urlencode({"requestId": clean_id})
    url = f"{OA_ADAPTER_BASE_URL}/api/workflow/paService/getWorkflowRequest?{query}"
    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json;charset=UTF-8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OA 流程详情请求失败({exc.code}): {detail[:240]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OA 流程详情请求失败: {exc}") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("OA 流程详情响应不是合法 JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("OA 流程详情响应格式异常")
    return payload


def _iter_main_fields(detail_resp: Dict[str, Any]) -> Iterable[Tuple[str, str]]:
    data = detail_resp.get("data", {}).get("data", {})
    if not isinstance(data, dict):
        return []

    pairs: List[Tuple[str, str]] = []
    for key, label in (
        ("creatorName", "创建人"),
        ("creatorDepartmentName", "创建部门"),
        ("currentNodeName", "当前节点"),
        ("requestName", "流程名称"),
        ("createTime", "创建时间"),
    ):
        value = strip_html(data.get(key))
        if value:
            pairs.append((label, value))

    main_info = data.get("workflowMainTableInfo")
    if isinstance(main_info, dict):
        records = main_info.get("requestRecords") or []
        if isinstance(records, list):
            for record in records:
                if not isinstance(record, dict):
                    continue
                fields = record.get("workflowRequestTableFields") or []
                if not isinstance(fields, list):
                    continue
                for field in fields:
                    if not isinstance(field, dict):
                        continue
                    field_name = str(field.get("fieldName") or "").strip()
                    if field_name in MAIN_FIELD_SKIP_KEYS:
                        continue
                    show_name = strip_html(field.get("fieldShowName") or field_name)
                    value = strip_html(field.get("fieldShowValue") or field.get("fieldValue"))
                    if not show_name or not value or value in MAIN_FIELD_SKIP_NAMES:
                        continue
                    if any(existing_label == show_name for existing_label, _ in pairs):
                        continue
                    pairs.append((show_name, value))
    return pairs


def summarize_detail_rows(detail_resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = detail_resp.get("data", {}).get("data", {})
    if not isinstance(data, dict):
        return []

    rows: List[Dict[str, Any]] = []
    tables = data.get("workflowDetailTableInfos") or []
    if not isinstance(tables, list):
        return rows

    for table_idx, table in enumerate(tables):
        if not isinstance(table, dict):
            continue
        records = table.get("workflowRequestTableRecords") or []
        if not isinstance(records, list):
            continue
        for record_idx, record in enumerate(records):
            if not isinstance(record, dict):
                continue
            fields = record.get("workflowRequestTableFields") or []
            if not isinstance(fields, list):
                continue
            row_data: Dict[str, str] = {}
            for field in fields:
                if not isinstance(field, dict):
                    continue
                show_name = strip_html(field.get("fieldShowName") or field.get("fieldName"))
                value = strip_html(field.get("fieldShowValue") or field.get("fieldValue"))
                if show_name and value:
                    row_data[show_name] = value
            if not row_data:
                continue
            rows.append(
                {
                    "table_idx": table_idx,
                    "record_idx": record_idx,
                    "row_data": row_data,
                }
            )
    return rows


def summarize_workflow_detail(detail_resp: Dict[str, Any], *, request_id: str = "") -> Dict[str, Any]:
    data = detail_resp.get("data", {}).get("data", {})
    resolved_request_id = str(
        request_id or (data.get("requestId") if isinstance(data, dict) else "") or ""
    ).strip()
    main_fields = list(_iter_main_fields(detail_resp))
    detail_rows = summarize_detail_rows(detail_resp)
    return {
        "request_id": resolved_request_id,
        "main_fields": main_fields,
        "detail_rows": detail_rows,
        "workflow_name": strip_html(data.get("requestName") if isinstance(data, dict) else ""),
    }


def fetch_oa_workflow_detail(
    request_id: str,
    *,
    token: str = "",
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "",
) -> Dict[str, Any]:
    clean_id = str(request_id or "").strip()
    if not clean_id:
        raise ValueError("缺少 requestId")

    access_token = str(token or "").strip() or request_oa_access_token(
        sender_id=sender_id,
        chat_id=chat_id,
        receive_id_type=receive_id_type,
    )
    detail_resp = fetch_workflow_request(clean_id, access_token)
    summary = summarize_workflow_detail(detail_resp, request_id=clean_id)
    summary["raw_status_ok"] = True
    return summary


def fetch_oa_details_for_request_ids(
    request_ids: Iterable[str],
    *,
    token: str = "",
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "",
) -> Dict[str, Dict[str, Any]]:
    ids = [str(item).strip() for item in request_ids if str(item).strip()]
    if not ids:
        return {}

    access_token = ""
    if token:
        access_token = str(token).strip()
    else:
        try:
            access_token = request_oa_access_token(
                sender_id=sender_id,
                chat_id=chat_id,
                receive_id_type=receive_id_type,
            )
        except Exception as exc:
            log_debug_event(
                "approval.oa_detail.auth_failed",
                error=str(exc)[:240],
                request_count=len(ids),
            )
            return {
                request_id: {
                    "request_id": request_id,
                    "error": str(exc),
                    "main_fields": [],
                    "detail_rows": [],
                }
                for request_id in ids
            }

    output: Dict[str, Dict[str, Any]] = {}
    for request_id in ids:
        try:
            detail_resp = fetch_workflow_request(request_id, access_token)
            output[request_id] = summarize_workflow_detail(detail_resp, request_id=request_id)
        except Exception as exc:
            log_debug_event(
                "approval.oa_detail.fetch_failed",
                request_id=request_id,
                error=str(exc)[:240],
            )
            output[request_id] = {
                "request_id": request_id,
                "error": str(exc),
                "main_fields": [],
                "detail_rows": [],
            }
    return output


def _format_row_data_line(row_data: Dict[str, str]) -> str:
    fragments: List[str] = []
    used = set()
    for field_name in DETAIL_ROW_PRIORITY_FIELDS:
        value = str(row_data.get(field_name) or "").strip()
        if not value:
            continue
        used.add(field_name)
        if field_name in {"报销金额", "核定报销金额", "费用金额", "不含税金额"}:
            fragments.append(f"{field_name}={format_amount(value)}")
        else:
            fragments.append(f"{field_name}={value}")
    if not fragments:
        for key, value in row_data.items():
            if key in used or not value:
                continue
            fragments.append(f"{key}={value}")
            if len(fragments) >= 4:
                break
    return " | ".join(fragments)


def format_oa_detail_markdown_lines(detail: Dict[str, Any]) -> List[str]:
    if not isinstance(detail, dict):
        return []
    lines: List[str] = []
    error = str(detail.get("error") or "").strip()
    if error:
        lines.append(f"OA详情暂不可用：{error[:120]}")
        return lines

    main_fields = detail.get("main_fields") or []
    if isinstance(main_fields, list) and main_fields:
        main_text = " | ".join(
            f"{label}：{value}"
            for label, value in main_fields[:6]
            if str(label).strip() and str(value).strip()
        )
        if main_text:
            lines.append(main_text)

    detail_rows = detail.get("detail_rows") or []
    if isinstance(detail_rows, list):
        for index, row in enumerate(detail_rows[:8], start=1):
            if not isinstance(row, dict):
                continue
            row_data = row.get("row_data")
            if not isinstance(row_data, dict) or not row_data:
                continue
            row_line = _format_row_data_line(row_data)
            if row_line:
                lines.append(f"明细{index}：{row_line}")
    return lines


def enrich_group_with_oa_details(
    group: Dict[str, Any],
    *,
    token: str = "",
    sender_id: str = "",
    chat_id: str = "",
    receive_id_type: str = "",
    enabled: bool = True,
) -> Dict[str, Any]:
    if not enabled or not isinstance(group, dict):
        return group

    request_ids = collect_request_ids_from_group(group)
    if not request_ids:
        return group

    oa_details = fetch_oa_details_for_request_ids(
        request_ids,
        token=token,
        sender_id=sender_id,
        chat_id=chat_id,
        receive_id_type=receive_id_type,
    )
    enriched = dict(group)
    enriched["oa_details_by_request_id"] = oa_details
    return enriched


def main() -> None:
    parser = argparse.ArgumentParser(description="查询 OA 流程详情（JSON 输出）")
    parser.add_argument("--request-id", required=True, help="OA requestId")
    parser.add_argument("--token", default="", help="直接使用指定 OA access token，便于调试")
    parser.add_argument("--raw", action="store_true", help="打印 OA adapter 原始响应，而不是摘要")
    parser.add_argument("--sender-id", default="", help="飞书 open_id，用于 OA 授权卡片")
    parser.add_argument("--chat-id", default="", help="飞书 chat_id，用于 OA 授权卡片")
    parser.add_argument(
        "--receive-id-type",
        default="",
        choices=["", "open_id", "chat_id"],
        help="飞书接收目标类型",
    )
    args = parser.parse_args()

    try:
        token = str(args.token or "").strip() or request_oa_access_token(
            sender_id=args.sender_id,
            chat_id=args.chat_id,
            receive_id_type=args.receive_id_type,
        )
        if args.raw:
            detail = fetch_workflow_request(args.request_id, token)
        else:
            detail_resp = fetch_workflow_request(args.request_id, token)
            detail = summarize_workflow_detail(detail_resp, request_id=args.request_id)
            detail["raw_status_ok"] = True
        print(json.dumps(detail, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
