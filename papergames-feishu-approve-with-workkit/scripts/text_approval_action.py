#!/usr/bin/env python3
"""Thin shell for natural-language approval actions.

Business matching, snapshot state, and approve/reject execution live in
vendor/workkit. This wrapper remains for the skill contract and auth boundary.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from approval_auth import AUTH_MODE_WRITE, ensure_auth_valid
from workkit_query import _run_workkit


def main() -> None:
    parser = argparse.ArgumentParser(description="通过最近一次 workkit 快照执行文本审批")
    parser.add_argument("command", nargs="+", help="例如：通过全部请假申请")
    parser.add_argument("--dry-run", action="store_true", help="仅兼容旧参数；workkit action 当前不执行 dry-run")
    parser.add_argument("--chat-id", default="", help="兼容旧参数，快照由 workkit 按最近查询读取")
    parser.add_argument("--send-card", default="", help="兼容旧参数")
    args = parser.parse_args()

    if args.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "command": " ".join(args.command)}, ensure_ascii=False))
        return

    ensure_auth_valid(auth_mode=AUTH_MODE_WRITE)
    payload = _run_workkit(["approval", "action", "text", " ".join(args.command), "--json"])
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(exc.returncode or 1)
    except Exception as exc:  # noqa: BLE001
        print(f"文本审批失败: {str(exc)[:500]}", file=sys.stderr)
        sys.exit(1)
