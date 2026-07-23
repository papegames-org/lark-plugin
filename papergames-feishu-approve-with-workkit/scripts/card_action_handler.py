#!/usr/bin/env python3
"""Thin shell for Feishu card.action.trigger callbacks.

OpenClaw still invokes this script, but callback parsing, snapshot state, and
approve/reject execution are delegated to the vendored workkit CLI.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from typing import Any, Dict, Tuple

from approval_auth import AUTH_MODE_WRITE, ensure_auth_valid
from workkit_query import _run_workkit


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _event_containers(event: Dict[str, Any]) -> list[Dict[str, Any]]:
    nested = event.get("event") if isinstance(event.get("event"), dict) else {}
    containers: list[Dict[str, Any]] = [event]
    if isinstance(nested, dict):
        containers.append(nested)
    for source in (event, nested):
        if not isinstance(source, dict):
            continue
        for key in ("action", "context", "operator", "message"):
            value = source.get(key)
            if isinstance(value, dict):
                containers.append(value)
    return containers


def _event_field(event: Dict[str, Any], *keys: str) -> str:
    for container in _event_containers(event):
        for key in keys:
            value = str(container.get(key) or "").strip()
            if value:
                return value
    return ""


def _event_action_value(event: Dict[str, Any]) -> Dict[str, Any]:
    for container in _event_containers(event):
        action = container.get("action")
        if isinstance(action, dict):
            value = action.get("value")
            if isinstance(value, dict):
                return value
        value = container.get("value")
        if isinstance(value, dict):
            return value
    return {}


def _notify_target(event: Dict[str, Any]) -> Tuple[str, str]:
    for key in ("open_chat_id", "chat_id"):
        value = _event_field(event, key)
        if value:
            return value, "chat_id"
    for key in ("open_id", "user_id"):
        value = _event_field(event, key)
        if value:
            return value, "open_id"
    return "", ""


def _open_message_id(event: Dict[str, Any]) -> str:
    return _event_field(event, "open_message_id", "message_id", "msg_id")


def _event_token(event: Dict[str, Any]) -> str:
    return _event_field(event, "token", "card_token")


def _spawn_bg_update(
    *,
    receive_id: str,
    receive_id_type: str,
    message_id: str,
    card_token: str,
    task_ids: str,
) -> None:
    if not (message_id or card_token):
        return
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_bg_update_card.py")
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as handle:
        json.dump(
            {
                "receive_id": receive_id,
                "receive_id_type": receive_id_type,
                "message_id": message_id,
                "card_token": card_token,
                "task_ids": task_ids,
            },
            handle,
            ensure_ascii=False,
        )
        tmp_path = handle.name
    try:
        subprocess.Popen(
            [sys.executable or "python3", worker, tmp_path],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _load_event(args: argparse.Namespace) -> Dict[str, Any]:
    raw = ""
    if args.event_json:
        raw = args.event_json
    elif args.event_file:
        with open(args.event_file, "r", encoding="utf-8") as handle:
            raw = handle.read()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def main() -> None:
    parser = argparse.ArgumentParser(description="处理飞书审批卡片回调")
    parser.add_argument("--event-json", default="", help="card.action.trigger event JSON")
    parser.add_argument("--event-file", default="", help="从文件读取 event JSON")
    args = parser.parse_args()

    event = _load_event(args)
    receive_id, receive_id_type = _notify_target(event)
    action_value = _event_action_value(event)
    clicked_task_ids = str(action_value.get("task_ids") or "").strip()

    ensure_auth_valid(auth_mode=AUTH_MODE_WRITE)

    mark_cmd = ["approval", "action", "mark-processing", "--json"]
    if args.event_json:
        mark_cmd.extend(["--event-json", args.event_json])
    elif args.event_file:
        mark_cmd.extend(["--event-file", args.event_file])
    else:
        raise ValueError("--event-json or --event-file is required")
    mark_payload = _run_workkit(mark_cmd)
    mark_data = mark_payload.get("data") if isinstance(mark_payload, dict) else None
    if isinstance(mark_data, dict) and mark_data.get("updated") and mark_data.get("claimed"):
        _spawn_bg_update(
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            message_id=_open_message_id(event),
            card_token=_event_token(event),
            task_ids=clicked_task_ids,
        )
    elif isinstance(mark_data, dict) and not mark_data.get("claimed"):
        print(json.dumps(mark_data, ensure_ascii=False, indent=2))
        return

    cmd = ["approval", "action", "handle-card-event", "--allow-processing", "--json"]
    if args.event_json:
        cmd.extend(["--event-json", args.event_json])
    elif args.event_file:
        cmd.extend(["--event-file", args.event_file])
    else:
        raise ValueError("--event-json or --event-file is required")
    payload = _run_workkit(cmd)
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict) and data.get("updated"):
        _spawn_bg_update(
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            message_id=_open_message_id(event),
            card_token=_event_token(event),
            task_ids=clicked_task_ids,
        )
    print(json.dumps(data if isinstance(data, dict) else payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(exc.returncode or 1)
    except Exception as exc:  # noqa: BLE001
        print(f"审批卡片回调处理失败: {str(exc)[:500]}", file=sys.stderr)
        sys.exit(1)
