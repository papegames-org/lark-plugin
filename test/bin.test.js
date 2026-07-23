import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("helper CLI help shows the published scoped package name", () => {
  const result = spawnSync(process.execPath, ["bin/openclaw-skill-runtime.js", "--help"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /@jianguo_paper\/openclaw-skill-runtime@latest install-openclaw/u);
});

test("install-openclaw enables conversation access for the early authorization gate", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-skill-runtime-bin-test-"));
  const fakeBin = join(root, "bin");
  const logPath = join(root, "openclaw.log");
  const mkdir = spawnSync("mkdir", ["-p", fakeBin], { encoding: "utf8" });
  assert.equal(mkdir.status, 0);

  const openclawPath = join(fakeBin, "openclaw");
  writeFileSync(openclawPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_TEST_LOG"\nexit 0\n`);
  chmodSync(openclawPath, 0o755);

  const npmPath = join(fakeBin, "npm");
  writeFileSync(npmPath, "#!/bin/sh\nprintf '%s\\n' 'openclaw-skill-runtime-test.tgz'\nexit 0\n");
  chmodSync(npmPath, 0o755);

  const result = spawnSync(process.execPath, ["bin/openclaw-skill-runtime.js", "install-openclaw"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      OPENCLAW_TEST_LOG: logPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const invocations = readFileSync(logPath, "utf8");
  assert.match(invocations, /plugins install .*openclaw-skill-runtime-test\.tgz/u);
  assert.match(
    invocations,
    /config set plugins\.entries\.openclaw-skill-runtime\.hooks\.allowConversationAccess true/u,
  );
});
