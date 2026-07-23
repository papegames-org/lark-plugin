#!/usr/bin/env python3
"""后台异步更新审批卡片的 worker。

回调（card_action_handler）在审批成功、快照落盘后，spawn 本脚本作为**脱离主进程**
的后台任务，然后立刻只回一个 toast 返回给飞书——避免把整张重建卡片塞进回调响应体
（大列表会超回调响应体大小上限，导致「回调超时未响应」，但审批其实已成功）。

本 worker 负责：读 workkit 最新快照 → 重建卡片（含 action_results 状态 / AI 摘要 /
nonce / 多卡分片）→ 通过 refresh_card（直连 /open-apis/interactive/v1/card/update）
带外更新。

参数经临时文件传入（避免命令行长度限制）：
    {receive_id, receive_id_type, message_id, card_token, request_id}
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Iterable, List, Set

script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)


def _run(params: dict) -> None:
    from common import log_debug_event, preview_text, refresh_card
    from workkit_query import _run_workkit, render_inbox_cards

    receive_id = str(params.get("receive_id") or "").strip()
    receive_id_type = str(params.get("receive_id_type") or "").strip()
    message_id = str(params.get("message_id") or "").strip()
    card_token = str(params.get("card_token") or "").strip()
    request_id = str(params.get("request_id") or "").strip()
    task_ids = str(params.get("task_ids") or "").strip()

    snapshot_payload = _run_workkit(
        [
            "approval",
            "snapshot",
            "get",
            "--receive-id",
            receive_id,
            "--receive-id-type",
            receive_id_type,
            "--json",
        ]
    )
    snapshot = snapshot_payload.get("data") if isinstance(snapshot_payload, dict) else {}
    if not snapshot:
        log_debug_event("approval.card_action.bg_update.no_snapshot", request_id=request_id)
        return

    groups = _groups_for_clicked_shard(snapshot, message_id=message_id, task_ids=task_ids)
    envelope = {
        "ok": True,
        "data": {
            "legacyGroups": groups,
            "actionResults": snapshot.get("action_results") or {},
        },
        "warnings": [],
    }
    rendered = render_inbox_cards(
        envelope,
        description=str(snapshot.get("query_description") or ""),
        describe_overrides_json=json.dumps(snapshot.get("ai_overrides") or [], ensure_ascii=False),
        query_nonce=str(snapshot.get("query_nonce") or ""),
        receive_id=receive_id,
        card_style=str(snapshot.get("card_style") or ""),
    )
    new_card = _first_card(rendered)
    if not new_card:
        log_debug_event("approval.card_action.bg_update.no_card", request_id=request_id)
        return

    try:
        result = refresh_card(new_card, message_id=message_id, card_token=card_token)
    except Exception as exc:
        log_debug_event(
            "approval.card_action.bg_update.failed",
            request_id=request_id,
            error=preview_text(str(exc), limit=240),
        )
        return
    log_debug_event(
        "approval.card_action.bg_update.done",
        request_id=request_id,
        code=result.get("code") if isinstance(result, dict) else None,
        has_message_id=bool(message_id),
        has_card_token=bool(card_token),
    )


def _first_card(rendered: Dict[str, Any]) -> Dict[str, Any]:
    if rendered.get("type") == "inline_v2_shards":
        cards = (rendered.get("data") or {}).get("cards") or []
        for card in cards:
            if isinstance(card, dict):
                return card
        return {}
    return rendered if isinstance(rendered, dict) else {}


def _groups_for_clicked_shard(
    snapshot: Dict[str, Any],
    *,
    message_id: str,
    task_ids: str,
) -> List[Dict[str, Any]]:
    groups = [group for group in snapshot.get("approval_list") or [] if isinstance(group, dict)]
    target_ids = _target_task_ids(snapshot, message_id=message_id, task_ids=task_ids)
    if not target_ids:
        return groups
    narrowed = _restrict_groups_to_task_ids(groups, target_ids)
    return narrowed or groups


def _target_task_ids(
    snapshot: Dict[str, Any],
    *,
    message_id: str,
    task_ids: str,
) -> Set[str]:
    shards = [shard for shard in snapshot.get("card_shards") or [] if isinstance(shard, dict)]
    mid = str(message_id or "").strip()
    if mid:
        for shard in shards:
            if str(shard.get("message_id") or "").strip() == mid:
                return _string_set(shard.get("task_ids") or [])
    clicked = _clicked_task_ids(task_ids)
    if clicked:
        for shard in shards:
            shard_ids = _string_set(shard.get("task_ids") or [])
            if shard_ids & clicked:
                return shard_ids
    return clicked


def _clicked_task_ids(raw: str) -> Set[str]:
    values: Set[str] = set()
    for chunk in str(raw or "").replace("，", ",").replace("；", ";").split(","):
        for piece in chunk.replace(";", " ").split():
            left = piece.replace("｜", "|").split("|", 1)[0].strip()
            if left:
                values.add(left)
    return values


def _string_set(values: Iterable[Any]) -> Set[str]:
    return {str(value).strip() for value in values if str(value or "").strip()}


def _group_items(group: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = group.get("approve_items")
    if isinstance(items, list) and items:
        return [item for item in items if isinstance(item, dict)]
    approve_item = group.get("approve_item")
    return [approve_item] if isinstance(approve_item, dict) else []


def _restrict_groups_to_task_ids(
    groups: List[Dict[str, Any]],
    task_ids: Set[str],
) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    for group in groups:
        items = [
            item
            for item in _group_items(group)
            if str(item.get("task_id") or "").strip() in task_ids
        ]
        if not items:
            continue
        narrowed = dict(group)
        narrowed["approve_items"] = items
        narrowed["approve_item"] = items[0]
        narrowed["group_count"] = len(items)
        output.append(narrowed)
    return output


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(1)
    tmp_file = sys.argv[1]
    try:
        with open(tmp_file, "r", encoding="utf-8") as fh:
            params = json.load(fh)
        if not isinstance(params, dict):
            return
        _run(params)
    except Exception:
        # 后台任务，任何异常都不外抛（回调侧已返回 toast）；细节已由 _run 内日志覆盖。
        pass
    finally:
        try:
            os.unlink(tmp_file)
        except OSError:
            pass


if __name__ == "__main__":
    main()
