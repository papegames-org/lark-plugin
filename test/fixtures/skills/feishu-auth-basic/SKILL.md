---
name: feishu-auth-basic
description: Minimal fixture skill for validating the normal pre-auth card flow.
metadata: { "openclaw": { "larkAuth": { "identity": "user", "scopes": ["contact:user.base:readonly"] } } }
---

# Feishu Auth Basic

This is a minimal fixture skill used to validate that:

- `openclaw-skill-runtime` can detect a `SKILL.md`
- the inline `metadata.openclaw.larkAuth` format is parsed correctly
- a missing scope can trigger the normal auth-card path

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-basic]`

After the marker, add one short sentence confirming the fixture skill really ran.

Suggested manual test:

1. Read this `SKILL.md` through the Feishu channel.
2. Confirm the plugin detects `contact:user.base:readonly`.
3. If the scope is missing, confirm the auth card is sent or the read is blocked.
4. After authorization is complete, run the skill again and confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-basic]`.
