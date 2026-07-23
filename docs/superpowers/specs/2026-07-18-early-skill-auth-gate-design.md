# Early Skill Authorization Gate Design

## Goal

Treat `SKILL.md` as the declarative authorization manifest and run the Feishu scope preflight at the earliest deterministic skill-activation boundary.

## Activation paths

- Explicit prompt-dispatched skill commands are detected in OpenClaw's canonical rewritten prompt and checked by `before_agent_run`, before the model runs.
- Tool-dispatched skill commands continue through `before_tool_call`, where OpenClaw supplies `ctx.skillCommand`.
- Model-selected skills continue to be checked when their `SKILL.md` is first read. This is the earliest deterministic signal for natural-language skill selection.
- Ambiguous natural-language references are not guessed. A plain assistant marker without an activation signal is not treated as skill execution.

## Architecture

Extract the existing scope check, card delivery, retry, polling, caching, and block-result logic into one internal preflight function. Both `before_agent_run` and `before_tool_call` resolve a skill to the same `{ skillName, skillPath }` representation and call that function.

Maintain a reverse skill index by name in addition to the existing path index. Parse only OpenClaw's anchored canonical explicit invocation form (`Use the "<name>" skill for this request.`); do not fuzzy-match arbitrary conversation text.

Authorization decisions are deduplicated by account, skill path, and run so the early gate and fallback cannot send duplicate cards. Existing conservative behavior remains: runtime or scope-check failures block when `blockRead !== false`.

## OpenClaw compatibility

OpenClaw 2026.5.28 exposes `before_agent_run` as a fail-closed gate with `prompt`, `accountId`, `channelId`, and `senderId`. Non-bundled plugins must be configured with `plugins.entries.openclaw-skill-runtime.hooks.allowConversationAccess=true` to register that hook. The installer and README must add this setting while preserving existing plugin configuration.

If the hook is unavailable or not permitted on an older host, `before_tool_call` remains functional as the compatibility fallback.

## Testing

- Explicit canonical skill invocation with missing scopes sends one card and blocks before the model.
- Explicit invocation with granted scopes passes.
- Unrelated prompts do not trigger authorization.
- Tool/read fallback behavior remains covered.
- Installer output enables conversation access without overwriting unrelated config.
- Full `release:check` and local package creation must pass.

