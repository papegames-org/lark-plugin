#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
paper_api_auth.py — IAM 飞书授权脚本(单文件,stdlib only)

用途:为需要打 paper-api-adapter 的业务 skill(reminder、leave 等)统一提供 IAM JWT 获取
     能力。本脚本独立可用,请直接 copy 到业务 skill 的 scripts/ 目录下使用,无需任何
     pip 依赖。详见同目录 INTEGRATION.md。

子命令:
    --print-token   # 静默输出 access_token (exit 0=token / exit 77=需重授权 / exit 1=异常)
    --auth          # 完整飞书授权流程: 生成 state + 写 URL 文件 + 轮询 + 落盘
    --status        # 查缓存状态 (exit 0=有效 / exit 1=无效)
    --refresh       # 清缓存
    --poll          # 仅轮询(手工调试,需 --state)

硬约束(勿改):
- token 缓存和授权链接文件必须共用全局路径解析逻辑。
- 默认固定落到 /root/.openclaw/workspace/secrets/papergames-auth/。
  ↑ 改根目录必须全局统一通过 PAPER_API_IAM_PERSIST_ROOT,不要在 copy 后本地改常量。

交互契约(给 agent):
- --print-token exit 77 时,stderr 会打 "IAM_AUTH_REQUIRED",调用方应以 exit 77 透传,
  让 agent 回到 `node index.js` / `node scripts/check-expenses.js` 或 `scripts/get-oa-token.js`,
  由 `scripts/send_auth_and_wait.py` 发送飞书授权卡片。
- `--auth` 只应由 `send_auth_and_wait.py` 内部调用来生成授权 URL 并轮询,不要作为 agent
  默认授权入口直接暴露给用户。
- 只有卡片发送失败、缺少飞书接收目标等兜底场景,才允许展示 auth_url/授权链接。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import stat
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


# ============================================================================
# 常量(均支持环境变量覆盖)
# ============================================================================
FEISHU_AUTHORIZE_URL = os.environ.get(
    "PAPER_API_IAM_FEISHU_AUTHORIZE_URL",
    "https://open.feishu.cn/open-apis/authen/v1/index",
)
FEISHU_APP_ID = os.environ.get("PAPER_API_IAM_FEISHU_APP_ID", "cli_a9633411c578dcde")

# IAM base URL。切环境只需覆盖这一个变量,REDIRECT_URI / TOKEN_URL 会跟着拼。
# 已知环境:
#   http://10.10.207.155:7200       — dev(内网)
#   https://test-iam-auth.diezhi.net — test(外网)
IAM_BASE_URL = os.environ.get("PAPER_API_IAM_BASE_URL", "https://test-iam-auth.diezhi.net").rstrip("/")
IAM_REDIRECT_URI = os.environ.get(
    "PAPER_API_IAM_REDIRECT_URI",
    f"{IAM_BASE_URL}/iam/v1/auth/claw/token",
)
IAM_TOKEN_URL = os.environ.get(
    "PAPER_API_IAM_TOKEN_URL",
    f"{IAM_BASE_URL}/iam/oauth2/token",
)
IAM_BASIC_AUTH = os.environ.get(
    "PAPER_API_IAM_BASIC_AUTH",
    "uYFuP2HoHY1v4bojp4Imx6fkvYlELD+NJzBe5WY0IfHxVlXhXYta/1Nip9RiZgmr",
)
IAM_AUTH_SOURCE = os.environ.get("PAPER_API_IAM_AUTH_SOURCE", "claw")
IAM_SCOPE = os.environ.get("PAPER_API_IAM_SCOPE", "paper-api:all")
IAM_CALLBACK_URI = os.environ.get(
    "PAPER_API_IAM_CALLBACK_URI",
    "https://localhost:7200/iam/v1/callback",
)

OPENCLAW_DEFAULT_SECRETS_ROOT = "/root/.openclaw/workspace/secrets"


def _resolve_persist_path(filename: str) -> str:
    """
    解析共享持久化子路径。

    根目录由 PAPER_API_IAM_PERSIST_ROOT 配置,未配置时使用 OpenClaw 默认 secrets 根目录。
    脚本统一拼 papergames-auth/<filename>,中间目录由写文件时自动创建。
    """
    root = os.environ.get("PAPER_API_IAM_PERSIST_ROOT", OPENCLAW_DEFAULT_SECRETS_ROOT)
    return os.path.join(os.path.expanduser(root), "papergames-auth", filename)


def _resolve_token_cache_path() -> str:
    """
    token 缓存统一落到 <PERSIST_ROOT>/papergames-auth/iam_token.json。
    """
    return _resolve_persist_path("iam_token.json")


TOKEN_CACHE_PATH = _resolve_token_cache_path()


def _resolve_authorize_url_path() -> str:
    """
    授权 URL 文件也是 agent/用户之间的跨进程交接文件。

    默认固定落到 OpenClaw workspace,否则不同运行用户或容器层读不到。
    """
    return _resolve_persist_path("authorize_url.txt")


AUTHORIZE_URL_PATH = _resolve_authorize_url_path()
POLL_TIMEOUT_SECONDS = int(os.environ.get("PAPER_API_IAM_POLL_TIMEOUT", "300"))
POLL_BACKOFF = [5, 10, 15]
EXPIRY_SAFETY_MARGIN = 60


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class AuthRequiredError(RuntimeError):
    """用户需要重新完成飞书授权。"""


class AuthUnavailableError(RuntimeError):
    """IAM/网络/未知响应异常,不应引导用户重新授权。"""


# ============================================================================
# 缓存
# ============================================================================
def _load_cache_record() -> dict | None:
    if not os.path.exists(TOKEN_CACHE_PATH):
        return None
    try:
        with open(TOKEN_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def load_cached_token() -> str | None:
    data = _load_cache_record()
    if not data:
        return None
    access_token = data.get("access_token")
    expires_at = data.get("expires_at", 0)
    if not access_token:
        return None
    if time.time() + EXPIRY_SAFETY_MARGIN >= expires_at:
        return None
    return access_token


def load_cached_refresh_token() -> str | None:
    data = _load_cache_record()
    if not data:
        return None
    return data.get("refresh_token") or None


def save_token(token_data: dict) -> None:
    expires_in = int(token_data.get("expires_in", 0))
    record = {
        "access_token": token_data["access_token"],
        "token_type": token_data.get("token_type", "Bearer"),
        "scope": token_data.get("scope", ""),
        "expires_at": int(time.time()) + expires_in,
    }
    refresh = token_data.get("refresh_token")
    if refresh:
        record["refresh_token"] = refresh

    cache_dir = os.path.dirname(TOKEN_CACHE_PATH)
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
    with open(TOKEN_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(TOKEN_CACHE_PATH, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def clear_cache() -> None:
    if os.path.exists(TOKEN_CACHE_PATH):
        try:
            os.remove(TOKEN_CACHE_PATH)
        except OSError:
            pass


# ============================================================================
# state / URL
# ============================================================================
def generate_state(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def build_feishu_auth_url(state: str) -> str:
    params = {
        "app_id": FEISHU_APP_ID,
        "redirect_uri": IAM_REDIRECT_URI,
        "state": state,
    }
    if IAM_SCOPE:
        params["scope"] = IAM_SCOPE
    return f"{FEISHU_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def write_authorize_url_file(url: str, state: str) -> None:
    """写 URL 到文件,供 agent 用 cat 展示(绕过 LLM 吞字符问题)。

    写失败直接抛 —— 用户看不到 URL 时轮询完全没意义,早失败好过让 agent 空转 300s。
    """
    try:
        os.makedirs(os.path.dirname(AUTHORIZE_URL_PATH), exist_ok=True)
        with open(AUTHORIZE_URL_PATH, "w", encoding="utf-8") as f:
            f.write(url)
            f.write("\n")
    except OSError as e:
        raise RuntimeError(
            f"写授权链接文件失败: {AUTHORIZE_URL_PATH} ({e})。"
            f"agent 无法展示 URL 给用户,轮询无意义。请检查授权链接目录权限。"
        )


# ============================================================================
# iam 令牌接口
# ============================================================================
def _token_request(body: dict, auth_source: str | None = None) -> tuple[str, object]:
    """
    返回 (kind, payload),kind 取值:
    - "ok"          : payload 是带 access_token 的 dict
    - "pending"     : iam 明确答了但还没准备好(code 未就绪等),payload 是调试串
    - "auth_failed" : OAuth2 明确的 invalid_grant / invalid_token,payload 是 error 值
                      refresh 场景下意味着 refresh_token 真的失效,可清缓存
    - "infra"       : 5xx / 网络错 / JSON 解析异常 / invalid_client(Basic Auth 配错)
                      payload 是原因串。调用方**不能**据此清缓存(可恢复故障)

    auth_source: 覆盖 X-Auth-Source header。授权码换 token 走 claw(iam 定制端),
                 refresh 按 OAuth2 文档走 inner。不传默认用 IAM_AUTH_SOURCE。
    """
    data = urllib.parse.urlencode(body).encode("utf-8")
    req = urllib.request.Request(
        IAM_TOKEN_URL,
        data=data,
        headers={
            "Authorization": f"Basic {IAM_BASIC_AUTH}",
            "X-Auth-Source": auth_source or IAM_AUTH_SOURCE,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    status = 0
    raw = ""
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            raw = ""
    except urllib.error.URLError as e:
        return ("infra", f"network error: {e.reason}")
    except Exception as e:
        return ("infra", f"unexpected: {type(e).__name__}: {e}")

    parsed: dict | None = None
    if raw.strip():
        try:
            maybe = json.loads(raw)
            if isinstance(maybe, dict):
                parsed = maybe
        except json.JSONDecodeError:
            if status >= 400:
                return ("infra", f"iam non-json response status={status} body={raw[:200]}")
            # 2xx 但非 JSON,当 pending 继续等
            return ("pending", f"non-json 2xx body={raw[:120]}")

    if status >= 500:
        return ("infra", f"iam 5xx status={status} body={raw[:200]}")

    if status >= 400:
        err = (parsed or {}).get("error", "") if parsed else ""
        # OAuth2 RFC 6749:仅 invalid_grant / invalid_token 表示凭据真的失效
        if err in ("invalid_grant", "invalid_token"):
            return ("auth_failed", err)
        # Basic Auth 配错(或 client 被 iam 禁用)是基础设施问题,不能清用户缓存
        if err in ("invalid_client", "unauthorized_client"):
            return ("infra", f"iam client config broken: error={err}")
        # 其他 4xx(空 body、未识别 error):轮询场景下 iam 对 code 未就绪常用这种
        # 不升级成 auth_failed,当 pending 继续重试
        return ("pending", f"status={status} body={raw[:120]}")

    if not parsed:
        return ("pending", "2xx empty body")
    token = parsed.get("access_token")
    if not (isinstance(token, str) and token.strip()):
        return ("pending", "2xx no access_token")
    return ("ok", parsed)


def poll_for_token(state: str) -> dict:
    body = {
        "grant_type": "authorization_code",
        "code": state,
        "redirect_uri": IAM_CALLBACK_URI,
        "scope": IAM_SCOPE,
        "app_id": FEISHU_APP_ID,
    }

    total = 0
    attempt = 0
    infra_warned = False
    while total < POLL_TIMEOUT_SECONDS:
        delay = POLL_BACKOFF[min(attempt, len(POLL_BACKOFF) - 1)]
        time.sleep(delay)
        total += delay
        attempt += 1

        kind, payload = _token_request(body)
        if kind == "ok":
            return payload  # type: ignore[return-value]
        if kind == "auth_failed":
            # 轮询阶段用户还没点授权时,iam 查不到 state 会回 invalid_grant,
            # 这里不能当终态,否则第一次轮询就退出,用户根本来不及打开链接。
            # 真实的"授权失败"只能靠整体超时兜底。
            log(f"等待授权中... (已等 {total}s / 超时 {POLL_TIMEOUT_SECONDS}s,iam: {payload})")
            continue
        if kind == "infra":
            # 基础设施抖动:继续轮询(iam 可能自愈),但醒目提示一次
            if not infra_warned:
                log(f"⚠️ iam 异常: {payload}(将继续重试至超时)")
                infra_warned = True
            continue
        # pending
        log(f"等待授权中... (已等 {total}s / 超时 {POLL_TIMEOUT_SECONDS}s)")

    raise RuntimeError(
        f"等待授权超时({POLL_TIMEOUT_SECONDS}s),请确认浏览器是否完成 Feishu 授权后重跑"
    )


def refresh_with_token(refresh_token: str) -> tuple[str, object]:
    """返回 (kind, payload),同 _token_request。调用方根据 kind 分流。

    按 iam 文档第 3 节,refresh 请求体只需 grant_type/scope/refresh_token 三个参数;
    X-Auth-Source 按文档默认走 inner(授权时是 claw 定制端,refresh 复用标准 OAuth2 端)。
    """
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": IAM_SCOPE,
    }
    return _token_request(body, auth_source="inner")


# ============================================================================
# 对外入口
# ============================================================================
def ensure_token() -> str:
    """拿 token:缓存命中直接返,过期自动 refresh,都不行抛 RuntimeError。"""
    cached = load_cached_token()
    if cached:
        return cached

    refresh_token = load_cached_refresh_token()
    if refresh_token:
        log("缓存已过期,尝试用 refresh_token 换新 access_token...")
        kind, payload = refresh_with_token(refresh_token)
        if kind == "ok":
            save_token(payload)  # type: ignore[arg-type]
            log("✅ 刷新成功")
            return payload["access_token"]  # type: ignore[index]
        if kind == "infra":
            # 关键:基础设施故障**不清**缓存,避免把可恢复故障升级成强迫重走飞书授权
            raise AuthUnavailableError(
                f"refresh 失败,但缓存保留(疑似 iam 临时不可用): {payload}。"
                f"请稍后重试;持续失败再跑 --refresh 手动清缓存 + --auth。"
            )
        if kind != "auth_failed":
            raise AuthUnavailableError(
                f"refresh 失败,但缓存保留(iam 响应未就绪或未知): {payload}。"
                f"请稍后重试;持续失败再跑 --refresh 手动清缓存 + --auth。"
            )
        # auth_failed(invalid_grant/invalid_token):refresh_token 真失效了
        log(f"refresh_token 已失效({payload}),清缓存")
        clear_cache()

    raise AuthRequiredError(
        "IAM 未授权或已过期。请通过 `node index.js` / `node scripts/check-expenses.js` "
        "或 `node scripts/get-oa-token.js` 触发飞书授权卡片。"
        f"仅当卡片发送失败时,才读取兜底授权链接文件: {AUTHORIZE_URL_PATH}"
    )


# ============================================================================
# CLI 模式
# ============================================================================
def cmd_print_token() -> None:
    """静默输出 token 给调用方。仅需用户授权时 exit 77,其他异常 exit 1。"""
    try:
        token = ensure_token()
    except AuthRequiredError:
        print("IAM_AUTH_REQUIRED", file=sys.stderr, flush=True)
        log("下一步: 返回入口脚本 `node index.js` / `node scripts/check-expenses.js`,")
        log("       或运行 `node scripts/get-oa-token.js` 触发飞书授权卡片。")
        log(f"       仅当卡片发送失败时,才读取兜底授权链接文件: {AUTHORIZE_URL_PATH}")
        sys.exit(77)
    except AuthUnavailableError as e:
        log(f"IAM_AUTH_UNAVAILABLE: {e}")
        sys.exit(1)
    except RuntimeError as e:
        log(f"IAM_AUTH_ERROR: {e}")
        sys.exit(1)
    # stdout 只打裸 token,无换行,方便 $(python3 paper_api_auth.py --print-token)
    sys.stdout.write(token)
    sys.stdout.flush()
    sys.exit(0)


def cmd_auth() -> None:
    """完整授权流程:生成 state → 写 URL 文件 → 轮询 → 落盘。"""
    state = generate_state()
    url = build_feishu_auth_url(state)

    try:
        write_authorize_url_file(url, state)
    except RuntimeError as e:
        log(f"❌ {e}")
        sys.exit(1)
    log(f"📝 授权链接已写入: {AUTHORIZE_URL_PATH}")
    log("   agent 必须用 `cat 该文件` 展示给用户,禁止在 prose 里打印 URL")
    log("   用户请在浏览器中打开该链接完成 Feishu 授权")

    log(f"[poll] 开始轮询 iam(state={state[:4]}...{state[-4:]})")
    try:
        token_data = poll_for_token(state)
    except RuntimeError as e:
        log(f"❌ {e}")
        try:
            if os.path.exists(AUTHORIZE_URL_PATH):
                os.remove(AUTHORIZE_URL_PATH)
        except OSError:
            pass
        sys.exit(1)

    save_token(token_data)
    try:
        if os.path.exists(AUTHORIZE_URL_PATH):
            os.remove(AUTHORIZE_URL_PATH)
    except OSError:
        pass
    log(f"✅ 授权成功,JWT 已缓存到 {TOKEN_CACHE_PATH}")


def cmd_poll_only(state: str | None) -> None:
    if not state or len(state) < 8:
        log("❌ --state 不能为空且长度不能小于 8 位")
        sys.exit(2)
    log(f"[poll] 手工轮询模式(state={state[:4]}...{state[-4:]})")
    try:
        token_data = poll_for_token(state)
    except RuntimeError as e:
        log(f"❌ {e}")
        sys.exit(1)
    save_token(token_data)
    log(f"✅ 授权成功,JWT 已缓存到 {TOKEN_CACHE_PATH}")


def cmd_status() -> None:
    if not os.path.exists(TOKEN_CACHE_PATH):
        log("未授权,缓存文件不存在")
        sys.exit(1)
    try:
        with open(TOKEN_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        log(f"缓存文件损坏: {e}")
        sys.exit(1)

    expires_at = data.get("expires_at", 0)
    remaining = int(expires_at - time.time())
    has_refresh = "是" if data.get("refresh_token") else "否"
    if remaining <= 0:
        log(f"Token 已过期(是否可 refresh: {has_refresh})")
        sys.exit(1)
    log(f"Token 有效,剩余 {remaining}s(是否可 refresh: {has_refresh})")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="IAM 飞书授权脚本(单文件 stdlib only,可自由 copy 到任何业务 skill 的 scripts/ 目录)",
    )
    parser.add_argument("--auth", action="store_true",
                        help="完整授权流程: 生成 state + 写 URL 文件 + 轮询 + 落盘")
    parser.add_argument("--poll", action="store_true",
                        help="仅轮询(手工模式,需配合 --state)")
    parser.add_argument("--state", default=None, help="配合 --poll 使用")
    parser.add_argument("--status", action="store_true", help="查缓存状态")
    parser.add_argument("--refresh", action="store_true", help="清缓存")
    parser.add_argument("--print-token", action="store_true", dest="print_token",
                        help="静默输出 access_token(exit 0=token / exit 77=需授权 / exit 1=异常)")
    args = parser.parse_args()

    if args.print_token:
        cmd_print_token()
        return
    if args.status:
        cmd_status()
        return
    if args.refresh:
        clear_cache()
        log("缓存已清")
        return
    if args.auth:
        cmd_auth()
        return
    if args.poll:
        cmd_poll_only(args.state)
        return

    parser.print_help()
    sys.exit(2)


if __name__ == "__main__":
    main()
