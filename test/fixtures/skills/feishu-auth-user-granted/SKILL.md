---
name: feishu-auth-user-granted
description: 一个创建多维表格的skill
metadata:
  openclaw:
    larkAuth:
      identity: user
      scopes:
        - "base:app:create"
        - "calendar:calendar.event:create"
        - "approval:approval:readonly"
        - "docs:document:import"
        - "im:chat"
        - "space:document:retrieve"
---

# Feishu Auth User Granted

在用户空间下，生成一个多维表格，名字叫‘lark-test’