---
name: feishu-auth-retry
description: Fixture skill for validating pending notice persistence and retry behavior.
larkAuth:
  identity: user
  scopes:
    - im:message
    - contact:user.base:readonly
---

# Feishu Auth Retry

This fixture is intended for failure-path validation.

Use it when you want to verify that:

- the YAML `larkAuth` format is parsed correctly
- missing scopes are detected for more than one scope at once
- auth-card send failures enter the pending notice queue
- retries survive restart and can be resumed on the next read

Suggested manual test:

1. Force `sendAuthCard` to fail, or temporarily make the bot unable to send messages.
2. Read this `SKILL.md` through the Feishu channel.
3. Confirm the read is still blocked.
4. Confirm a pending notice is written and retries are scheduled.
5. Restore message sending and read again to confirm the retry path recovers.
