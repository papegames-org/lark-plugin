# Automatic Install Authorization Design

## Goal

Installing `openclaw-skill-runtime` should not require a follow-up chat command or a manually configured recipient when the matching `lark-cli` profile already contains exactly one verified Feishu user.

The completed flow is:

1. Install the plugin.
2. Start or restart the OpenClaw Gateway so the plugin is registered.
3. Discover the Feishu applications from OpenClaw account and agent bindings.
4. Scan all visible `SKILL.md` files and aggregate their `larkAuth` declarations per application.
5. Resolve one trusted card recipient from the matching `lark-cli` profile.
6. Check granted scopes and send one aggregate authorization card per application when permissions are missing.

No chat phrase such as `initialize Skill authorization` is required.

## Current State

The plugin already:

- maps agents to Feishu accounts through OpenClaw bindings;
- maps Feishu accounts to `appId` and credentials;
- resolves `lark-cli` profiles by `appId`;
- runs `lark-cli auth status --verify`;
- validates a known user's `openId`, granted scopes, and verification state;
- scans Skill roots and aggregates `larkAuth` scopes;
- sends authorization cards and polls for completion.

The missing connection is recipient discovery. `checkUserGrant` requires an `openId` before it invokes the verifier, while `getAuthedUser` only reads the in-memory sender cache populated by Feishu message hooks. The existing `selectAuthedUserProfile` helper is not connected to plugin startup.

## Recipient Resolution

Add a startup-safe recipient resolver with the following precedence:

1. Explicit `installAuth.openId` or an `open_id` `installAuth.receiveId`.
2. A unique verified user discovered from matching `lark-cli` profiles.
3. No recipient.

Automatic discovery must:

- resolve the expected Feishu `appId` from the selected OpenClaw account;
- list profiles and keep only profiles matching that `appId`;
- run `lark-cli auth status --verify` for each matching profile;
- require the returned `appId` to equal the expected application;
- require `identities.user.available === true`;
- require `identities.user.verified === true`;
- require a non-empty user `openId`;
- retain the exact profile that produced each verified identity;
- return a recipient only when exactly one verified `(profile, openId)` tuple remains.

The result is a verified identity tuple, not only a string:

```text
{ appId, accountId, profile, openId }
```

The exact `profile` from this tuple must be passed through user-grant checks, login, waiter, and polling. Later stages must not resolve another profile by `appId`. If two profiles match the application but only the second is verified, every subsequent `lark-cli` command must continue using the second profile.

An explicit normalized `openId` is trusted as the configured card recipient and may bootstrap first-time OAuth. Profile selection remains separate:

- if exactly one matching application profile already verifies that `openId`, use and persist it;
- if no profile has a verified user and exactly one application profile exists, use that profile to start OAuth, then require the completed verified identity to equal the configured `openId` before recording success;
- if more than one application profile could bootstrap the configured user, profile selection is ambiguous and no OAuth starts until configuration selects a profile;
- if a matching profile verifies a different user, fail with an identity-mismatch result and do not overwrite that login.

An optional `installAuth.profile` selects one named profile only for an explicit recipient. The selected profile must match the expected `appId`, and OAuth completion must still verify the configured `openId`.

Automatic recipient discovery without explicit configuration never chooses between duplicate profiles. Even when two profiles expose the same verified `openId`, the result is `recipient_ambiguous` because subsequent mutable OAuth state must remain profile-specific.

The resolver must never infer a user from an OS account, application administrator, agent ID, account ID, arbitrary first profile, or unverified status response.

## Startup Behavior

Aggregate install authorization becomes automatic unless explicitly disabled:

```json
{
  "installAuth": {
    "enabled": false
  }
}
```

When `installAuth` is absent, plugin registration still builds the aggregate manifest. Each application resolves its recipient independently because different Feishu applications may use different profiles and users.

An explicit recipient is accepted only as one normalized `open_id`. `receiveIdType` must be absent or `open_id`. When both `openId` and `receiveId` are supplied they must be equal; conflicting values or a non-`open_id` recipient type disable startup authorization with a configuration error. This restriction applies only to automatic install authorization; normal runtime cards may continue replying to trusted chats.

Registration installs all hooks first and returns before manifest collection starts. The startup preflight is explicitly deferred to a later event-loop turn before synchronous filesystem traversal begins. It runs in the background, logs a structured result, and does not prevent hook registration from completing.

Per-application outcomes are:

- `card sent`: one verified recipient and missing scopes;
- `already authorized`: all required application and user scopes are verified;
- `recipient unavailable`: no verified matching user;
- `recipient ambiguous`: more than one verified matching user;
- `runtime unavailable`: `lark-cli`, Feishu credentials, or authorization APIs are unavailable.

Application scopes are checked before recipient discovery. An app-identity bucket that is already authorized returns `already_authorized` without requiring `lark-cli`. Recipient/profile discovery runs only when a card must be delivered or user-grant scopes must be checked.

The preflight emits this redacted structured summary internally and in diagnostics:

```json
{
  "manifestComplete": true,
  "partial": false,
  "skills": 56,
  "skillsWithAuth": 12,
  "applications": [
    {
      "accountId": "default",
      "appId": "cli_xxx",
      "status": "card_sent",
      "reasonCode": null,
      "recipientSource": "verified_profile",
      "missingAppScopeCount": 2,
      "missingUserScopeCount": 3
    }
  ]
}
```

Application `status` is one of `already_authorized`, `card_sent`, `recipient_unavailable`, `recipient_ambiguous`, `identity_mismatch`, `runtime_unavailable`, `delivery_failed`, or `queued_scope_delta`. `partial` is exactly `!manifestComplete` and never changes an individual application status. No global authorization status is emitted. The summary contains counts and stable reason codes, never credentials, tokens, profile secrets, device codes, full authorization URLs, message content, or full `openId` values.

### Durable deduplication and retry

Startup authorization uses a persistent subject key derived from application, verified profile/openId, and authorization stage. The manifest hash and requested scopes are task data, not part of the mutual-exclusion key. The state is stored under the existing OpenClaw plugin data directory.

- An in-memory key may reserve a task while one attempt is running.
- The reservation is cleared when health checks, login creation, or card delivery fail.
- A successfully delivered card is recorded through the existing persistent auth-card record store before the attempt is considered complete.
- Registration after a Gateway restart restores an active card/poll session and does not send a duplicate.
- Card delivery failures create an install-auth retry record with the recipient, application, profile, manifest hash, scopes, and bounded retry state.
- Install-auth retries reuse the existing backoff policy in `pending-auth.js`, but use an explicit batch/install record type rather than pretending to be a single Skill path.
- While a task is active, a changed manifest does not mutate its immutable requested-scope snapshot and does not create another card. Newly required scopes are stored as a deduplicated pending delta under the same subject key.
- When the active task completes, the plugin rechecks grants. If the pending delta is still missing, it starts exactly one follow-up task; otherwise it clears the delta.
- Expired or definitively denied tasks are finalized before one queued delta may start. Transient delivery/poll failures retain the same subject task and retry budget.
- A changed manifest containing no scopes beyond the active snapshot produces no queue entry.

## Installation Helper

`install-openclaw` continues to package and install the plugin, then detects restart support with `openclaw gateway restart --help`. When supported it executes `openclaw gateway restart`. If that command is unavailable, it checks both `openclaw gateway stop --help` and `openclaw gateway start --help` and uses the stop/start pair only when both are supported. Installation success and restart success are reported separately.

The helper must not edit OpenClaw JSON directly or invent an unsupported configuration command. Runtime inspection remains the source of truth after restart. The output and exit contract is:

- install failure: report installation failure and return the install command's non-zero status;
- install success plus restart success: report both stages and return `0`;
- install success plus no supported restart or stop/start command: report that installation succeeded, state that this OpenClaw CLI cannot activate it automatically, instruct the operator to restart the Gateway through the deployment's service manager, and return `3`;
- install success plus restart failure: report that installation succeeded but activation failed, include the restart status, and return `3`.

After a successful restart the helper runs `openclaw plugins inspect openclaw-skill-runtime --runtime --json`. Activation is proven only when the JSON identifies `openclaw-skill-runtime`, does not mark it disabled, and exposes an affirmative runtime-loaded/registered field supported by the local OpenClaw response adapter. Unknown JSON shapes, invalid JSON, a different plugin ID, disabled state, or a false loaded/registered field fail verification with exit `4`. Inspect failure is reported as activation verification failure and does not relabel package installation as failed. Fixtures for every accepted response shape document the adapter contract.

Direct installation through another OpenClaw surface is also supported: the automatic preflight runs whenever that surface starts or reloads the Gateway and registers the plugin.

## Failure Handling

Failure to discover a recipient does not weaken runtime authorization. Individual Skill execution remains guarded by the existing hook-time scope checks and trusted sender identity.

No authorization card is sent when recipient identity is missing or ambiguous. Logs include the application/account and reason, but redact credentials, tokens, device codes, and full authorization URLs.

Application-scope and user-scope completion remain separate. A verified user is a trusted recipient, not proof that every requested scope is already granted.

## Scan Boundary and Partial Results

The automatic scan uses these roots:

- configured `pluginConfig.skillRoots` when non-empty; these replace the generic default roots;
- otherwise `~/.agents/skills`, `<OPENCLAW_HOME>/skills`, and `<OPENCLAW_HOME>/workspace/skills`;
- in both cases, every configured `agents.list[].workspace/skills` root is added with its `agentId` for account routing.

Scanning follows the existing boundary: recurse through non-hidden directories to depth four, skip `node_modules`, and only read files named `SKILL.md`. Agent roots route through `bindings[].match.accountId`. Shared roots use the only configured account or explicit `defaultFeishuAccountId`; otherwise their authenticated Skills are unresolved.

Missing roots and malformed declarations are recorded as scan errors. Unresolved authenticated Skills are reported separately. Valid application buckets may still send cards when the manifest is partial, but logs and structured outcomes must say `partial`; a partial manifest must never produce a global `already authorized` claim.

## Tests

Add tests covering:

- one matching profile with one verified user sends the aggregate card without `installAuth` configuration;
- an explicit configured recipient overrides profile discovery;
- profile `appId` mismatch is rejected;
- unavailable or unverified users are rejected;
- zero verified users does not send a card;
- multiple distinct verified users is treated as ambiguous and does not send a card;
- duplicate profiles for the same verified `openId` are ambiguous and do not send a card;
- two matching profiles where only the second is verified keep using the second profile for checks, login, and polling;
- an explicit recipient can bootstrap OAuth through the sole matching profile and must verify the same user before completion;
- an explicit recipient with multiple matching profiles requires `installAuth.profile`, and the chosen profile persists through checks, login, polling, and restart recovery;
- an existing verified profile for a different user produces `identity_mismatch` and is never overwritten;
- failed and non-JSON `auth status --verify` responses never produce a recipient;
- non-`open_id` explicit recipients and conflicting `openId`/`receiveId` values are rejected;
- `installAuth.enabled: false` disables startup scanning and cards;
- `register()` installs hooks and returns before manifest collection starts;
- same-process delivery failure can retry and does not leave a stale reservation;
- a delivered card is not duplicated after Gateway restart;
- an active task followed by a changed manifest queues only the missing scope delta and sends no concurrent card;
- an already-authorized app-only bucket succeeds without `lark-cli` recipient discovery;
- missing roots, malformed declarations, and unresolved multi-account Skills produce partial results without a false global success claim;
- shared and agent-specific roots route to the expected applications;
- the install helper covers install failure, restart success, unsupported restart, restart failure, and inspect failure separately;
- runtime inspect fixtures cover every accepted JSON shape plus disabled, unloaded, wrong-ID, invalid, and unknown responses;
- structured summary fields, status enums, partial-manifest behavior, and redaction are asserted exactly;
- structured outcomes and logs do not contain credentials, tokens, device codes, or full authorization URLs.

Run the full `npm run release:check` before packaging the validation ZIP.
