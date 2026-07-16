---
name: feishu-auth-user-granted
description: Fixture skill for validating the user-scope path when the target user scopes are already granted.
metadata:
  openclaw:
    larkAuth:
      identity: user
      scopes:
        - "search:message"
        - "base:app:create"
        - "calendar:calendar.event:create"
        - "approval:approval:readonly"
        - "docs:document:import"
        - "im:chat"
        - "space:document:retrieve"
---

# Feishu Auth User Granted

This fixture is intended for manual validation of the "user scopes already granted" path.

Use it when you want to verify that:

- `openclaw-skill-runtime` can detect a `SKILL.md`
- the nested YAML `metadata.openclaw.larkAuth` format is parsed correctly
- the declared scopes correspond to user scopes you believe are already granted for the current user
- the pre-check passes without sending a new auth card
- the read or skill execution can continue directly

Before testing, replace the placeholder scopes in frontmatter with real user scopes that are already granted for the current user.

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-user-granted]`

After the marker, add one short sentence confirming the fixture skill really ran.

Suggested manual test:

1. Replace the placeholder scopes with user scopes that are already granted for the current user.
2. Read this `SKILL.md` through the Feishu channel.
3. Confirm the plugin recognizes the fixture and checks the declared scopes.
4. Confirm no new auth reminder card is sent for this fixture.
5. Run the skill and confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-user-granted]`.
