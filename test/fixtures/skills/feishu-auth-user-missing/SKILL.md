---
name: feishu-auth-user-missing
description: Fixture skill for validating the user-scope path when the target user scopes are not yet granted.
metadata:
  openclaw:
    larkAuth:
      identity: user
      scopes:
        - "base:block:create"
        - "base:block:update"
---

# Feishu Auth User Missing

This fixture is intended for manual validation of the "user scopes missing" path.

Use it when you want to verify that:

- the nested YAML `metadata.openclaw.larkAuth` format is parsed correctly
- the declared scopes correspond to user scopes that are not yet granted for the current user
- the pre-check identifies those scopes as missing
- the plugin sends an auth reminder card or blocks the read according to configuration

Before testing, replace the placeholder scopes in frontmatter with real user scopes that are currently missing for the current user.

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-user-missing]`

After the marker, add one short sentence confirming the retry fixture skill really ran.

Suggested manual test:

1. Replace the placeholder scopes with user scopes that are not yet granted for the current user.
2. Read this `SKILL.md` through the Feishu channel.
3. Confirm the plugin recognizes the fixture and detects the declared scopes as missing.
4. Confirm an auth reminder card is sent, or the read is blocked, depending on current plugin configuration.
5. After the user authorization is completed, run the same flow again.
6. Confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-user-missing]`.
