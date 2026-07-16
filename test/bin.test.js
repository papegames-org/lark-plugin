import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("helper CLI help shows the published scoped package name", () => {
  const result = spawnSync(process.execPath, ["bin/openclaw-skill-runtime.js", "--help"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /@jianguo_paper\/openclaw-skill-runtime@latest install-openclaw/u);
});
