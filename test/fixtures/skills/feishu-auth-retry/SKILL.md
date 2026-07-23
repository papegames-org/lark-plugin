---
name: feishu-auth-retry
description: Fixture skill for validating pending notice persistence and retry behavior.
metadata:
  openclaw:
    larkAuth:
      identity: user
      scopes:
        - "aily:data_asset:upload_file"
        - "base:block:create"
---

# Feishu Auth Retry

This fixture is intended for failure-path validation.

Use it when you want to verify that:

- the nested YAML `metadata.openclaw.larkAuth` format is parsed correctly
- missing mail scopes are detected for more than one scope at once
- auth-card send failures enter the pending notice queue
- retries survive restart and can be resumed on the next read

When this fixture skill is actually executed, the response must begin with the fixed marker:

`[FIXTURE-SKILL-TRIGGERED: feishu-auth-retry]`

After the marker, add one short sentence confirming the retry fixture skill really ran.

Suggested manual test:

1. Force `sendAuthCard` to fail, or temporarily make the bot unable to send messages.
2. Read this `SKILL.md` through the Feishu channel.
3. Confirm the read is still blocked.
4. Confirm a pending notice is written and retries are scheduled.
5. Restore message sending and read again to confirm the retry path recovers.
6. After the retry path succeeds, confirm the reply starts with `[FIXTURE-SKILL-TRIGGERED: feishu-auth-retry]`.
