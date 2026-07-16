---
name: feishu-auth-app-granted
description: Fixture skill for validating the app-scope path when the target application scopes are already granted.
metadata:
  openclaw:
    larkAuth:
      identity: app
      scopes:
        - "application:bot.basic_info:read"
        - "base:collaborator:read"
---

# Feishu Auth App Granted

This fixture is intended for manual validation of the "application scopes already granted" path.

Use it when you want to verify that:

- the plugin can still detect the `SKILL.md` normally
- the declared scopes correspond to application scopes you believe are already available on the Feishu app
- the pre-check passes without sending a new auth card
- the read or skill execution can continue directly

Before testing, replace the placeholder scopes in frontmatter with real application scopes that are already granted for the target app.

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-app-granted]`

After the marker, add one short sentence confirming the granted-app-scope fixture skill really ran.

Suggested manual test:

1. Replace the placeholder scopes with application scopes that are already available on the target app.
2. Read this `SKILL.md` through the Feishu channel.
3. Confirm the plugin recognizes the fixture and checks the declared scopes.
4. Confirm no new auth reminder card is sent for this fixture.
5. Run the skill and confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-app-granted]`.
