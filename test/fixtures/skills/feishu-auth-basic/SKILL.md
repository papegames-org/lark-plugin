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

Suggested manual test:

1. Read this `SKILL.md` through the Feishu channel.
2. Confirm the plugin detects `contact:user.base:readonly`.
3. If the scope is missing, confirm the auth card is sent or the read is blocked.
