---
name: feishu-auth-basic
description: Minimal fixture skill for validating the normal pre-auth card flow.
metadata:
  openclaw:
    larkAuth:
      identity: user
      scopes:
        - "search:message"
        - "mail:user_mailbox.message:readonly"
        - "mail:user_mailbox.message.body:read"
        - "mail:user_mailbox.message.address:read"
        - "mail:user_mailbox.message.subject:read"
---

# Feishu Auth Basic

This is a minimal fixture skill used to validate that:

- `openclaw-skill-runtime` can detect a `SKILL.md`
- the nested YAML `metadata.openclaw.larkAuth` format is parsed correctly
- missing mail scopes can trigger the normal auth-card path

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-basic]`

After the marker, add one short sentence confirming the fixture skill really ran.

Suggested manual test:

1. Read this `SKILL.md` through the Feishu channel.
2. Confirm the plugin detects the declared mail scopes.
3. If any scope is missing, confirm the auth card is sent or the read is blocked.
4. After authorization is complete, run the skill again and confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-basic]`.
