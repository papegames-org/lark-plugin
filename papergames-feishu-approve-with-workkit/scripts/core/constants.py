"""Skill-wide constants: card IDs, scope strings, URL bases, redaction key sets,
file names, log limits, install / post-install copy.

These are pure values with no behavior; safe to import from anywhere.
"""

from __future__ import annotations

import os
from typing import Dict

from skill_version import SKILL_VERSION


# --- Card template IDs / versions -------------------------------------------------

LIST_CARD_ID = "AAqtPNUmgJVWg"
LIST_CARD_VERSION = (
    str(os.getenv("PAPER_FEISHU_APPROVE_LIST_CARD_VERSION", "1.0.10") or "").strip()
    or "1.0.10"
)
DETAIL_CARD_ID = "AAqtPNsuicYzb"
DETAIL_CARD_VERSION = (
    str(os.getenv("PAPER_FEISHU_APPROVE_DETAIL_CARD_VERSION", "1.0.1") or "").strip()
    or "1.0.1"
)
# 飞书模板 AAqtPNUmgJVWg 循环变量名（与快照里的 approval_list 不是同一层）
LIST_CARD_TEMPLATE_LIST_KEY = (
    str(os.getenv("PAPER_FEISHU_APPROVE_LIST_TEMPLATE_LIST_KEY", "approve_list") or "")
    .strip()
    or "approve_list"
)
OPENCLAW_INTERACTIVE_NAMESPACE = "papergames-feishu-approve"
# 列表卡别名，兼容历史引用
RESULT_CARD_ID = LIST_CARD_ID
RESULT_CARD_VERSION = LIST_CARD_VERSION


# --- Approval app / URL bases -----------------------------------------------------

DEFAULT_APPROVAL_APP_ID = "cli_9cb844403dbb9108"
APPROVAL_HOME_APPLINK_BASE = "https://applink.feishu.cn/client/approval/home"
APPROVAL_MINI_PROGRAM_OPEN_BASE = "https://applink.feishu.cn/client/mini_program/open"
# 手机端待办审批列表（飞书审批小程序）
APPROVAL_MOBILE_PENDING_PATH = "pages/approval-list/index?selectIndex=0"
# PC 端待办审批列表
APPROVAL_PC_PENDING_PATH = "pc/pages/in-process/index"


# --- Auth / scope -----------------------------------------------------------------

READ_SCOPE = "approval:task:read"
APPROVE_SCOPE = "approval:task:write"
INSTANCE_READ_SCOPE = "approval:instance:read"


# --- lark-cli profile / logging --------------------------------------------------

LARK_PROFILE_NAME = (
    str(os.getenv("PAPER_FEISHU_APPROVE_LARK_PROFILE", "openclaw") or "").strip()
    or "openclaw"
)
LOG_PREVIEW_MAX = int(os.getenv("PAPER_FEISHU_APPROVE_LOG_PREVIEW_MAX", "1200"))


# --- File names -------------------------------------------------------------------

POST_INSTALL_HINT_STATE_FILENAME = "post_install_hint_state.json"
OPERATE_LOG_FILENAME = "operate.log"


# --- Redaction --------------------------------------------------------------------

REDACTED = "[redacted]"

SENSITIVE_KEYS = {
    "task_id",
    "task_external_id",
    "instance_code",
    "process_id",
    "process_code",
    "process_external_id",
    "message_id",
    "open_message_id",
    "taskId",
    "instanceCode",
    "processId",
    "messageId",
    "openMessageId",
    "batch_approve_items",
}
SENSITIVE_URL_KEYS = {
    "pc_link",
    "mobile_link",
    "helpdesk_link",
    "pc_url",
    "mobile_url",
    "link",
    "links",
    "urls",
}


# --- Batch payload prefixes ------------------------------------------------------

BATCH_ITEMS_EXTERNAL_PREFIX = "batch_items_json:"
BATCH_NAMES_EXTERNAL_PREFIX = "batch_names_json:"


# --- Auth cache TTL --------------------------------------------------------------

def auth_access_cache_ttl_seconds() -> float:
    raw = str(os.getenv("PAPER_FEISHU_APPROVE_AUTH_CACHE_TTL_SECONDS", "20") or "").strip()
    try:
        ttl = float(raw)
    except ValueError:
        ttl = 20.0
    return ttl if ttl > 0 else 0.0


# --- Stored-state TTLs ------------------------------------------------------------

# 默认 1 天。统一管理“可过期暂存”：超过 TTL 的文件在读取时视为不存在并惰性删除，
# 杜绝下次查询/操作复用上一次的陈旧数据。0 或负数表示“永不过期”。
_ONE_DAY_SECONDS = 24 * 60 * 60


def _positive_float_env(name: str, default: float) -> float:
    raw = str(os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else 0.0


def query_snapshot_ttl_seconds() -> float:
    """最近一次查询快照（latest_query_result_snapshot*.json）的存活时长。"""
    return _positive_float_env(
        "PAPER_FEISHU_APPROVE_SNAPSHOT_TTL_SECONDS", float(_ONE_DAY_SECONDS)
    )


def post_install_hint_ttl_seconds() -> float:
    """post_install_hint_state.json 的存活时长，过期后再次提示。"""
    return _positive_float_env(
        "PAPER_FEISHU_APPROVE_POST_INSTALL_HINT_TTL_SECONDS", float(_ONE_DAY_SECONDS)
    )


def lark_profile_cache_ttl_seconds() -> float:
    """已解析 lark-cli profile 的进程内缓存存活时长。"""
    return _positive_float_env(
        "PAPER_FEISHU_APPROVE_PROFILE_CACHE_TTL_SECONDS", 300.0
    )


# --- Install / post-install copy -------------------------------------------------

MISSING_LARK_CLI_MESSAGE = """⚠️ 现在还无法查询待办审批哦，因为缺少依赖工具 lark-cli。

请先手动安装并初始化 lark-cli（推荐走 lark-shared）：
1. 执行 `npm install -g @larksuite/cli`
2. 执行 `npx skills add larksuite/cli -y -g`
3. 执行 `lark-cli config init` 完成配置
4. 执行 `lark-cli auth login` 完成登录授权
5. 执行 `lark-cli --version` 确认安装成功

装好并完成登录后，再继续审批查询和操作~"""

POST_INSTALL_HINT_MESSAGE = (
    f"🎉 安装完成 {SKILL_VERSION}！\n\n"
    "现在可以开始对话啦～将通过飞书卡片展示可快捷审批的内容。\n"
    "✅ 加入关键词“ papergames-feishu-approve”，能更精准触发并命中技能\n"
    "📌 待办审批一键查，自动汇总你所有可快捷审批的单据，可按人员、流程名称等关键词快速筛选。\n"
    "🛠 快捷审批不用跳转表单详情页，基于飞书消息卡片，发送提示词就能完成操作。\n"
    "💬 推荐试试：使用技能papergames-feishu-approve汇总我的审批；然后说“同意 小a 的审批”\n\n"
    "温馨提示：若流程本身不支持快捷审批，查询和操作请以实际结果为准。"
)


__all__ = [
    "APPROVAL_HOME_APPLINK_BASE",
    "APPROVAL_MINI_PROGRAM_OPEN_BASE",
    "APPROVAL_MOBILE_PENDING_PATH",
    "APPROVAL_PC_PENDING_PATH",
    "APPROVE_SCOPE",
    "BATCH_ITEMS_EXTERNAL_PREFIX",
    "BATCH_NAMES_EXTERNAL_PREFIX",
    "DEFAULT_APPROVAL_APP_ID",
    "DETAIL_CARD_ID",
    "DETAIL_CARD_VERSION",
    "INSTANCE_READ_SCOPE",
    "LARK_PROFILE_NAME",
    "LIST_CARD_ID",
    "LIST_CARD_TEMPLATE_LIST_KEY",
    "LIST_CARD_VERSION",
    "LOG_PREVIEW_MAX",
    "MISSING_LARK_CLI_MESSAGE",
    "OPENCLAW_INTERACTIVE_NAMESPACE",
    "OPERATE_LOG_FILENAME",
    "POST_INSTALL_HINT_MESSAGE",
    "POST_INSTALL_HINT_STATE_FILENAME",
    "READ_SCOPE",
    "REDACTED",
    "RESULT_CARD_ID",
    "RESULT_CARD_VERSION",
    "SENSITIVE_KEYS",
    "SENSITIVE_URL_KEYS",
    "auth_access_cache_ttl_seconds",
    "lark_profile_cache_ttl_seconds",
    "post_install_hint_ttl_seconds",
    "query_snapshot_ttl_seconds",
]
