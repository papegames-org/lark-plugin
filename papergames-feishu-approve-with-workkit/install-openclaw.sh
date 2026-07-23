#!/usr/bin/env bash
# Link OpenClaw bridge extension to the skill's bundled extensions/ (single unzip install).
# Auto-configure OpenClaw's openclaw.json to load the bridge plugin.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-$HOME/.openclaw/extensions}"
SKILL_NAME="papergames-feishu-approve"
BRIDGE_NAME="papergames-approval-handler"
BRIDGE_DST="$EXTENSIONS_DIR/$BRIDGE_NAME"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"

resolve_skill_root() {
  # 优先：从脚本所在目录直接识别（解压后就地运行，最常见也最可靠）。
  if [[ -f "$SCRIPT_DIR/SKILL.md" && -d "$SCRIPT_DIR/extensions/$BRIDGE_NAME" ]]; then
    echo "$SCRIPT_DIR"
    return
  fi
  # 回退：常见技能安装目录逐个探测（含 .agents/skills 与 OpenClaw workspace）。
  local candidate
  for candidate in \
    "$WORKSPACE/skills/$SKILL_NAME" \
    "$HOME/.agents/skills/$SKILL_NAME" \
    "$HOME/.openclaw/workspace/skills/$SKILL_NAME"; do
    if [[ -f "$candidate/SKILL.md" && -d "$candidate/extensions/$BRIDGE_NAME" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo "$WORKSPACE/skills/$SKILL_NAME"
}

# 查找 OpenClaw 配置文件
find_openclaw_config() {
  if [[ -f "$CONFIG_PATH" ]]; then
    echo "$CONFIG_PATH"
    return
  fi
  if [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
    echo "$HOME/.openclaw/openclaw.json"
    return
  fi
  # 尝试从目录找
  for candidate in \
    "$HOME/.openclaw/openclaw.json" \
    "$HOME/openclaw/openclaw.json" \
    "$PWD/openclaw.json"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

# 更新 OpenClaw 配置
update_openclaw_config() {
  local config_file="$1"
  local plugin_name="$2"
  
  if [[ ! -f "$config_file" ]]; then
    echo "⚠️  找不到 OpenClaw 配置: $config_file"
    echo "    请手动在 openclaw.json 中添加插件配置"
    return 1
  fi
  
  # 备份配置
  cp "$config_file" "$config_file.bak.$(date +%s)"
  
  echo "📝 更新 OpenClaw 配置: $config_file"
  
  # 使用 Python 安全地修改 JSON
  python3 <<END
import json
import sys

config_path = "$config_file"
plugin_name = "$plugin_name"

try:
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
except Exception as e:
    print(f"❌ 无法读取配置: {e}")
    sys.exit(1)

# 确保必要的结构存在
if 'plugins' not in config:
    config['plugins'] = {}
if 'allow' not in config['plugins']:
    config['plugins']['allow'] = []
if 'entries' not in config['plugins']:
    config['plugins']['entries'] = {}

# 添加插件到 allow 列表
if plugin_name not in config['plugins']['allow']:
    config['plugins']['allow'].append(plugin_name)
    print(f"   ✅ 添加到 plugins.allow: {plugin_name}")
else:
    print(f"   ℹ️  已在 plugins.allow: {plugin_name}")

# 添加插件到 entries
if plugin_name not in config['plugins']['entries']:
    config['plugins']['entries'][plugin_name] = {
        "enabled": True,
        "hooks": {
            "allowConversationAccess": True,
            "timeoutMs": 500
        }
    }
    print(f"   ✅ 添加到 plugins.entries: {plugin_name}")
else:
    # 确保 enabled 设置正确
    if not config['plugins']['entries'][plugin_name].get('enabled', False):
        config['plugins']['entries'][plugin_name]['enabled'] = True
        print(f"   ✅ 启用插件: {plugin_name}")
    else:
        print(f"   ℹ️  已在 plugins.entries: {plugin_name}")

# 保存修改
try:
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    print(f"   ✅ 配置已更新")
except Exception as e:
    print(f"❌ 无法保存配置: {e}")
    sys.exit(1)

END
  return 0
}

SKILL_DST="$(resolve_skill_root)"
BRIDGE_SRC="$SKILL_DST/extensions/$BRIDGE_NAME"

if [[ ! -d "$BRIDGE_SRC" ]]; then
  echo "❌ 未找到桥接插件: $BRIDGE_SRC" >&2
  echo "   请先解压 skill zip 到 \$OPENCLAW_WORKSPACE/skills/，再运行本脚本。" >&2
  exit 1
fi

mkdir -p "$EXTENSIONS_DIR"

# 关键: 先彻底删除目标，再创建符号链接。
# `ln -sfn` 在目标是符号链接时会原地替换，但目标若是**实体目录**（之前某次 unzip
# 误把目录写进来）则会报错或表现异常 —— gateway 仍会加载实体目录里的旧文件，
# 这次的代码改动就不会生效。
# 历史上 v0.0.40 曾出现过这个问题，导致 actionName 解析修复在生产环境无感。
rm -rf "$BRIDGE_DST"
ln -sfn "$BRIDGE_SRC" "$BRIDGE_DST"

# 校验链接是否指向预期源目录
if [[ ! -L "$BRIDGE_DST" ]]; then
  echo "❌ 链接创建失败: $BRIDGE_DST 不是符号链接" >&2
  exit 1
fi
LINK_TARGET="$(readlink "$BRIDGE_DST")"
if [[ "$LINK_TARGET" != "$BRIDGE_SRC" ]]; then
  echo "❌ 链接指向错误: $BRIDGE_DST -> $LINK_TARGET (应为 $BRIDGE_SRC)" >&2
  exit 1
fi

echo "✅ OpenClaw 桥接已链接"
echo "   Skill  : $SKILL_DST"
echo "   Bridge : $BRIDGE_DST -> $BRIDGE_SRC"

# 自动更新 OpenClaw 配置
CONFIG_FILE="$(find_openclaw_config)"
if [[ -n "$CONFIG_FILE" ]]; then
  echo ""
  if update_openclaw_config "$CONFIG_FILE" "$BRIDGE_NAME"; then
    echo "✅ OpenClaw 配置已自动更新"
  fi
else
  echo ""
  echo "⚠️  无法自动定位 OpenClaw 配置"
  echo "    请手动在 openclaw.json 中添加:"
  echo "    - plugins.allow: $BRIDGE_NAME"
  echo "    - plugins.entries: { \"$BRIDGE_NAME\": { \"enabled\": true, ... } }"
fi

echo ""
echo "⚠️  请重启 OpenClaw gateway："
echo "    openclaw gateway restart"
