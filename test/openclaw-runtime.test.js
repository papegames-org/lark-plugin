import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPluginConfigHints,
  formatOpenClawDoctorReport,
} from "../openclaw-runtime.js";

test("extractPluginConfigHints reads common config surfaces", () => {
  const hints = extractPluginConfigHints({
    config: {
      plugins: {
        allow: ["openclaw-skill-runtime"],
        entries: {
          "openclaw-skill-runtime": {
            enabled: true,
            config: { blockRead: true },
          },
        },
      },
    },
  });

  assert.deepEqual(hints, {
    pluginId: "openclaw-skill-runtime",
    hasEntry: true,
    enabled: true,
    configPresent: true,
    allowListed: true,
  });
});

test("formatOpenClawDoctorReport renders gateway and runtime status", () => {
  const text = formatOpenClawDoctorReport({
    cli: {
      ok: false,
      command: "openclaw",
      version: null,
      error: "Unable to execute openclaw",
    },
    gateway: {
      ok: false,
      checked: false,
      error: "openclaw CLI unavailable",
    },
    pluginConfig: {
      ok: false,
      checked: false,
      pluginId: "openclaw-skill-runtime",
      error: "openclaw CLI unavailable",
      hints: null,
    },
    pluginRuntime: {
      ok: false,
      checked: false,
      pluginId: "openclaw-skill-runtime",
      error: "openclaw CLI unavailable",
    },
  });

  assert.match(text, /OpenClaw gateway checks/);
  assert.match(text, /OpenClaw CLI available: no/);
  assert.match(text, /Plugin entry present: not-checked/);
  assert.match(text, /Plugin runtime loaded: not-checked/);
});
