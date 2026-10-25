import test from "node:test";
import assert from "node:assert/strict";

import { installOpenClawWorkflow } from "../bin/openclaw-skill-runtime.js";

function result(status = 0, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

test("install helper restarts and inspects OpenClaw after installation", () => {
  const calls = [];
  const runCommand = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "npm") return result(0, "jianguo_paper-openclaw-skill-runtime-2.0.5.tgz\n");
    return result(0, "{}");
  };

  const outcome = installOpenClawWorkflow({
    runCommand,
    stagingDir: "/tmp/install-helper-test",
    packageRoot: "/tmp/package-root",
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.installed, true);
  assert.equal(outcome.restarted, true);
  assert.equal(outcome.inspected, true);
  assert.ok(calls.some((args) => args.join(" ") === "openclaw gateway restart"));
  assert.ok(calls.some((args) => args.join(" ") === "openclaw plugins inspect openclaw-skill-runtime --runtime --json"));
});

test("install helper reports activation failure separately", () => {
  const runCommand = (cmd, args) => {
    if (cmd === "npm") return result(0, "jianguo_paper-openclaw-skill-runtime-2.0.5.tgz\n");
    if (cmd === "openclaw" && args[0] === "gateway" && args[1] === "restart") return result(9, "", "restart failed");
    return result(0, "{}");
  };

  const outcome = installOpenClawWorkflow({
    runCommand,
    stagingDir: "/tmp/install-helper-test",
    packageRoot: "/tmp/package-root",
  });

  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.installed, true);
  assert.equal(outcome.restarted, false);
  assert.match(outcome.error, /restart failed/);
});
