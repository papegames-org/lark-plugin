"""统一的可过期暂存层。

集中管理 skill 中“暂存配置 / 暂存查询结果”这类文件，给它们一致的过期语义：

  * 每条记录写入时带 `saved_at`（ISO8601，本地时区）。
  * 读取时统一用 `load_fresh_json` 判断是否超过 TTL；超时则视为不存在并惰性删除，
    从根本上杜绝“下次查询复用上一次陈旧数据”。
  * 也提供进程内 `TTLCache`，给内存缓存（如已解析 lark-cli profile）相同的过期语义。

时间统一走 `time.time()`（单调性无关，仅做差值比较），文件时间戳额外存一份
可读的 ISO 字符串便于排查。所有读写都对缺失 / 损坏文件容错，绝不抛给调用方。
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import time
from typing import Any, Callable, Dict, Optional


SAVED_AT_KEY = "saved_at"
_SAVED_AT_EPOCH_KEY = "saved_at_epoch"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def stamp(payload: Dict[str, Any]) -> Dict[str, Any]:
    """给 payload 盖上写入时间戳（就地返回同一 dict，覆盖既有时间字段）。"""
    payload[SAVED_AT_KEY] = now_iso()
    payload[_SAVED_AT_EPOCH_KEY] = int(time.time())
    return payload


def _saved_epoch(payload: Dict[str, Any]) -> Optional[float]:
    """从记录里解析写入时刻（秒）。优先用 epoch 字段，回退解析 ISO 字符串。"""
    epoch = payload.get(_SAVED_AT_EPOCH_KEY)
    if isinstance(epoch, (int, float)) and epoch > 0:
        return float(epoch)
    raw = str(payload.get(SAVED_AT_KEY) or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw).timestamp()
    except ValueError:
        return None


def is_expired(payload: Dict[str, Any], ttl_seconds: float) -> bool:
    """TTL<=0 表示永不过期；缺时间戳的旧记录一律按过期处理（强制刷新）。"""
    if ttl_seconds <= 0:
        return False
    saved = _saved_epoch(payload)
    if saved is None:
        return True
    return (time.time() - saved) > ttl_seconds


def write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    """原子写入；自动盖时间戳。失败由调用方决定是否兜底。"""
    import tempfile

    stamp(payload)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".cache_store_", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _load_json(path: str) -> Dict[str, Any]:
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def load_fresh_json(path: str, ttl_seconds: float) -> Dict[str, Any]:
    """读取一条记录，超过 TTL 则惰性删除文件并返回空 dict。"""
    payload = _load_json(path)
    if not payload:
        return {}
    if is_expired(payload, ttl_seconds):
        remove_quietly(path)
        return {}
    return payload


def remove_quietly(path: str) -> bool:
    try:
        if os.path.isfile(path):
            os.remove(path)
            return True
    except OSError:
        pass
    return False


class TTLCache:
    """带过期的进程内键值缓存。TTL<=0 表示永不过期。"""

    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = float(ttl_seconds)
        self._store: Dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Optional[Any]:
        entry = self._store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at and time.time() >= expires_at:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        expires_at = (time.time() + self._ttl) if self._ttl > 0 else 0.0
        self._store[key] = (expires_at, value)

    def get_or_compute(self, key: str, factory: Callable[[], Any]) -> Any:
        cached = self.get(key)
        if cached is not None:
            return cached
        value = factory()
        self.set(key, value)
        return value

    def clear(self) -> None:
        self._store.clear()


__all__ = [
    "SAVED_AT_KEY",
    "TTLCache",
    "is_expired",
    "load_fresh_json",
    "now_iso",
    "remove_quietly",
    "stamp",
    "write_json_atomic",
]
