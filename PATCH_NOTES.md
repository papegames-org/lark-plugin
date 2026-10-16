# openclaw-skill-runtime 1.0.1 patched-default-fallback

本包基于 @jianguo_paper/openclaw-skill-runtime v1.0.1，包含以下修复：

1. 修复多飞书账号场景下 main agent 的 skill-runtime hook ctx 缺少 accountId/agentId 时无法发授权卡的问题。
2. 新增插件私有配置读取链路：`api.pluginConfig.defaultFeishuAccountId`。
3. 新增 `defaultFeishuAccountId` 到 `openclaw.plugin.json` 的 `configSchema`，避免 Gateway 因 `additionalProperties:false` 过滤该配置。
4. 当 hook ctx 无账号信息且存在多个 Feishu accounts 时，仅在管理员显式配置 `defaultFeishuAccountId` 后使用该账号作为 fallback；插件不会自动猜测 default。
5. 已在当前环境验证：`papergames-chat-matter` 授权卡可使用 `Feishu[default]` 账号发送到 main DM。

推荐配置：

```json
{
  "plugins": {
    "entries": {
      "openclaw-skill-runtime": {
        "enabled": true,
        "config": {
          "defaultFeishuAccountId": "default"
        }
      }
    }
  }
}
```
