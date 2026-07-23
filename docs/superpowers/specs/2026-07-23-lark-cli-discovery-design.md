# Lark CLI discovery and default-profile design

## Goal

Make the optional `userAuthProvider: "lark-cli"` path match the established
Papergames Feishu approval skill: discover the CLI from `PATH`, do not install
software at runtime, and let Lark CLI use its currently active profile.

## Behaviour

- The adapter invokes `lark-cli` by command name unless the caller explicitly
  supplies a command path. Node's `execFile` and `spawn` resolve that command
  through the process `PATH`.
- Capability checks run `lark-cli auth login --help` and require the existing
  Device Flow flags. A missing, unusable, or incompatible CLI returns an
  unsuccessful capability check; the plugin's existing fail-closed gate then
  blocks the skill.
- The adapter sends no `--profile` argument. It uses the CLI's active/default
  profile, just as the approval skill activates a profile before binding and
  then calls `config bind` without a profile flag.
- Binding remains `lark-cli config bind --source openclaw --app-id <appId>
  --identity user-default`. Subsequent `auth check`, device login, and device
  wait commands use the same active CLI profile.

## Removed surface area

- Delete automatic global npm installation and its pinned package constant.
- Delete the `installLarkCliIfMissing` plugin configuration and its pending
  authorization persistence.
- Delete `larkCliProfile` plugin configuration and its runtime propagation.

`larkCliPath` remains optional as an explicit override for deployments whose
PATH intentionally does not include the executable. It accepts either an
absolute path or a command name; the default is `lark-cli`.

## Documentation and configuration

- Remove `larkCliProfile` and `installLarkCliIfMissing` from the plugin schema,
  examples, and README reference material.
- Update `larkCliPath` documentation to describe an optional command/path
  override and the `PATH`-based `lark-cli` default. Do not claim an ArkClaw
  fixed binary location.

## Tests

- Confirm the default adapter invokes `lark-cli` without `--profile`.
- Confirm a missing CLI fails capability detection and never invokes npm.
- Confirm bind, scope check, device-flow initiation, and device-flow waiting
  retain the active/default profile by omitting `--profile`.
- Confirm the retained `larkCliPath` override accepts both an absolute path
  and a command name.
- Update pending-notice and configuration tests to ensure removed settings are
  no longer accepted or persisted.
- Run the complete test suite and `npm run pack:dry`, then inspect the
  resulting package listing before handing over the installable archive.
