import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createLarkCliAuthAdapter } from "../lark-cli-auth.js";

function makeExecFile(handlers) {
  return (file, args, options, cb) => {
    const key = [file, ...args].join(" ");
    const handler = handlers.get(key);
    if (!handler) {
      const error = new Error(`unexpected execFile: ${key}`);
      error.code = 1;
      return cb(error, "", "");
    }
    const result = typeof handler === "function" ? handler({ file, args, options }) : handler;
    if (result.error) return cb(result.error, result.stdout || "", result.stderr || "");
    return cb(null, result.stdout || "", result.stderr || "");
  };
}

function makeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("adapter defaults to PATH-discovered lark-cli without a profile argument", async () => {
  const handlers = new Map([
    ["lark-cli auth login --help", { stdout: "--no-wait --json --device-code" }],
    ["lark-cli --version", { stdout: "lark-cli version 1.0.63" }],
  ]);
  const adapter = createLarkCliAuthAdapter({
    execFile: makeExecFile(handlers),
    spawn() { throw new Error("unexpected spawn"); },
  });

  assert.equal(adapter.cliPath, "lark-cli");
  assert.deepEqual(await adapter.capabilityCheck(), { ok: true, version: "lark-cli version 1.0.63" });
});

test("adapter accepts command-name and absolute-path CLI overrides", () => {
  const options = { execFile() {}, spawn() {} };
  assert.equal(createLarkCliAuthAdapter({ ...options, cliPath: "lark-cli-custom" }).cliPath, "lark-cli-custom");
  assert.equal(createLarkCliAuthAdapter({ ...options, cliPath: "/opt/bin/lark-cli" }).cliPath, "/opt/bin/lark-cli");
  assert.throws(() => createLarkCliAuthAdapter({ ...options, cliPath: "" }));
});

test("missing CLI fails capability detection without installing software", async () => {
  const calls = [];
  const adapter = createLarkCliAuthAdapter({
    execFile(file, args, options, cb) {
      calls.push([file, ...args].join(" "));
      const error = new Error("not found");
      error.code = "ENOENT";
      cb(error, "", "not found");
    },
    spawn() { throw new Error("unexpected spawn"); },
  });

  assert.deepEqual(await adapter.capabilityCheck(), { ok: false, error: "lark-cli unsupported" });
  assert.deepEqual(calls, ["lark-cli auth login --help"]);
});

test("bind and subsequent authentication commands use the CLI active profile", async () => {
  const handlers = new Map([
    ["lark-cli config bind --source openclaw --app-id cli_app_123 --identity user-default", { stdout: "bound" }],
    ["lark-cli auth check --scope s.a", { stdout: JSON.stringify({ ok: false, missing: ["s.a"] }) }],
    ["lark-cli auth login --scope s.a --no-wait --json", {
      stdout: JSON.stringify({ verification_url: "https://example.test/verify", device_code: "device-code", expires_in: 600 }),
    }],
  ]);
  const adapter = createLarkCliAuthAdapter({
    execFile: makeExecFile(handlers),
    spawn() { throw new Error("unexpected spawn"); },
  });

  assert.deepEqual(await adapter.bind({ appId: "cli_app_123" }), { ok: true });
  assert.deepEqual(await adapter.check({ scopes: ["s.a"] }), { ok: false, missing: ["s.a"] });
  assert.deepEqual(await adapter.startDeviceFlow({ scopes: ["s.a"] }), {
    ok: true,
    verificationUrl: "https://example.test/verify",
    deviceCode: "device-code",
    expiresIn: 600,
  });
});

test("device-flow waiting invokes lark-cli without a profile argument", async () => {
  let received = null;
  const adapter = createLarkCliAuthAdapter({
    execFile() { throw new Error("unexpected execFile"); },
    spawn(file, args, options) {
      received = { file, args, options };
      const child = makeChild();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  const result = await adapter.waitForDeviceFlow({ deviceCode: "device-code", timeoutMs: 1000 });
  assert.equal(received.file, "lark-cli");
  assert.deepEqual(received.args, ["auth", "login", "--device-code", "device-code"]);
  assert.deepEqual(result.status, "completed");
});
