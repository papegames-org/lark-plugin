# OpenClaw Gateway Notes

This note collects the OpenClaw plugin and gateway behaviors that matter most to `openclaw-skill-runtime`.

## 1. Plugin install and load path

OpenClaw's documented plugin lifecycle is:

1. install plugin
2. configure plugin under `plugins.entries.<id>.config`
3. enable plugin
4. restart the Gateway
5. verify runtime registration with `openclaw plugins inspect <id> --runtime --json`

Operationally, this means our plugin should optimize for:

- clear install docs
- stable config schema
- explicit post-install verification steps
- restart-aware health checks

## 2. Restart requirements are real

OpenClaw docs explicitly treat plugin code install/update/uninstall as requiring a Gateway restart.

Implication for this plugin:

- code changes should not assume hot reload is enough
- when users report "plugin updated but behavior did not change", ask whether they did a full Gateway restart
- runtime diagnostics should distinguish "config changed" from "plugin code changed"

## 3. Manifest quality matters before runtime even boots

`openclaw.plugin.json` is read before plugin runtime loads.

That means this file should stay:

- strict
- cheap to inspect
- explicit about config schema
- aligned with actual runtime defaults

For this repository, the `blockRead` default mismatch is especially important because plugin-local validation and manifest inspection happen before runtime hooks execute.

## 4. Hooks are the correct surface for policy control

OpenClaw distinguishes between:

- internal file-based hooks for coarse automation
- typed plugin hooks via `api.on(...)` for runtime lifecycle control

`openclaw-skill-runtime` is correctly using typed plugin hooks today because it needs to inspect and potentially block `read` calls at runtime.

This is the right long-term extension surface.

## 5. Gateway recovery should assume validation and runtime checks can fail independently

OpenClaw docs separate several operational concerns:

- config validation
- gateway reachability
- runtime RPC proof
- channel readiness
- operator-driven repair

Practical implication:

- our plugin should avoid assuming "gateway process is up" means "plugin runtime is healthy"
- startup checks should be idempotent
- any state that matters after restart should be cheaply reconstructible
- runtime diagnostics should help operators distinguish plugin problems from gateway problems

## 6. Last-known-good config does not mean automatic rollback

OpenClaw keeps a trusted last-known-good config snapshot, but docs say startup and hot reload do not automatically restore it; `openclaw doctor --fix` is the repair path.

Implication:

- plugin config validation must be conservative
- docs should clearly show how to recover from a bad config
- plugin startup logs should be actionable enough that operators know whether the issue is config, auth, or runtime availability

## 7. Verification must be runtime-aware

The docs distinguish between inventory-style inspection and runtime proof.

Implication:

- after install or config changes, verify the runtime surface explicitly
- prefer `openclaw plugins inspect <id> --runtime --json` over assuming manifest discovery is enough
- prefer `openclaw gateway status --require-rpc` over plain reachability checks when debugging live behavior

## 8. What this means for `openclaw-skill-runtime`

The plugin should evolve in this direction:

- startup checks that validate Feishu config, auth state, and config shape
- runtime warnings that are specific about recovery actions
- documentation that includes install, enable, inspect, restart, and verify steps
- minimal volatile state; anything non-essential should be rebuilt after restart
- no hidden dependency on global shell state

## 9. Recommended operator checklist

When debugging a production installation:

1. `openclaw plugins inspect openclaw-skill-runtime --runtime --json`
2. `openclaw gateway status --require-rpc`
3. `openclaw logs --follow`
4. if plugin code changed, do a full Gateway restart
5. if runtime/config seems stale, repair the service install and restart again
