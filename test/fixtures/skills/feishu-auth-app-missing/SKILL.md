---
name: feishu-auth-app-missing
description: Fixture skill for validating the app-scope path when the target application scopes are not yet granted.
metadata:
  openclaw:
    larkAuth:
      identity: app
      scopes:
        - "calendar:room:readonly"
        - "calendar:calendar:read"
---

# Feishu Auth App Missing

This fixture is intended for manual validation of the "application scopes missing" path.

Use it when you want to verify that:

- the plugin can still detect the `SKILL.md` normally
- the declared scopes correspond to application scopes that are not yet available on the Feishu app
- the pre-check identifies those scopes as missing
- the plugin sends an auth reminder card or blocks the read according to configuration

Before testing, replace the placeholder scopes in frontmatter with real application scopes that are currently missing for the target app.

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-app-missing]`

After the marker, add one short sentence confirming the missing-app-scope fixture skill really ran.

Suggested manual test:

1. Replace the placeholder scopes with application scopes that are not yet available on the target app.
2. Read this `SKILL.md` through the Feishu channel.
3. Confirm the plugin recognizes the fixture and detects the declared scopes as missing.
4. Confirm an auth reminder card is sent, or the read is blocked, depending on current plugin configuration.
5. After the application scopes become available, run the same flow again and confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-app-missing]`.
