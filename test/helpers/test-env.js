import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { resetRuntimeCaches } from "../../utils.js";

export function normalizePathForAssert(value) {
  return normalize(String(value));
}

export function isolateOpenClawDataDir(prefix = "openclaw-skill-runtime-test-") {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const prevDataDir = process.env.OPENCLAW_DATA_DIR;
  const prevHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_DATA_DIR = dataDir;
  process.env.OPENCLAW_HOME = dataDir;
  resetRuntimeCaches();
  return {
    dataDir,
    restore() {
      resetRuntimeCaches();
      if (prevDataDir === undefined) delete process.env.OPENCLAW_DATA_DIR;
      else process.env.OPENCLAW_DATA_DIR = prevDataDir;
      if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prevHome;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
