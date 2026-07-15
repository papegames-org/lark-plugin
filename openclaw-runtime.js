import { execFile } from "node:child_process";

export function execFileAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : 1,
        error,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

export async function runOpenClaw(args, options = {}) {
  const result = await execFileAsync(options.command || "openclaw", args, {
    timeout: options.timeoutMs ?? 20000,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    ...result,
    command: options.command || "openclaw",
  };
}

export async function inspectOpenClaw(options = {}) {
  const versionResult = await runOpenClaw(["--version"], options);
  if (!versionResult.ok) {
    return {
      ok: false,
      command: versionResult.command,
      version: null,
      error: versionResult.error?.message || versionResult.stderr || "Unable to execute openclaw",
    };
  }

  const versionMatch = `${versionResult.stdout}\n${versionResult.stderr}`.match(/(\d+\.\d+\.\d+)/);
  return {
    ok: true,
    command: versionResult.command,
    version: versionMatch ? versionMatch[1] : "unknown",
    error: null,
  };
}

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch {}
  }
  return null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function coerceBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function hasOwnEntries(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function findPluginNode(payload, pluginId) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.id === pluginId) return payload;

  const directCandidates = [
    payload.plugin,
    payload.result,
    payload.data,
    payload.item,
    payload.entry,
  ];
  for (const candidate of directCandidates) {
    if (candidate && typeof candidate === "object") {
      if (candidate.id === pluginId) return candidate;
      if (candidate.plugin && candidate.plugin.id === pluginId) return candidate.plugin;
    }
  }

  const collections = [
    payload.plugins,
    payload.items,
    payload.results,
    payload.entries,
    payload.list,
  ];
  for (const collection of collections) {
    if (Array.isArray(collection)) {
      const match = collection.find((item) => item?.id === pluginId || item?.plugin?.id === pluginId);
      if (match) return match.plugin || match;
    }
  }

  if (hasOwnEntries(payload.plugins) && payload.plugins[pluginId]) return payload.plugins[pluginId];
  if (hasOwnEntries(payload.entries) && payload.entries[pluginId]) return payload.entries[pluginId];
  return null;
}

export function extractPluginConfigHints(payload, pluginId = "openclaw-skill-runtime") {
  const pluginNode = findPluginNode(payload, pluginId);
  const entryNode = firstDefined(
    payload?.entries?.[pluginId],
    payload?.plugins?.entries?.[pluginId],
    payload?.config?.plugins?.entries?.[pluginId],
    payload?.effectiveConfig?.plugins?.entries?.[pluginId],
    payload?.runtimeConfig?.plugins?.entries?.[pluginId],
    pluginNode?.entry,
    pluginNode?.configEntry,
  );
  const entriesNode = firstDefined(
    payload?.entries,
    payload?.plugins?.entries,
    payload?.config?.plugins?.entries,
    payload?.effectiveConfig?.plugins?.entries,
    payload?.runtimeConfig?.plugins?.entries,
  );
  const allowNode = firstDefined(
    payload?.allow,
    payload?.plugins?.allow,
    payload?.config?.plugins?.allow,
    payload?.effectiveConfig?.plugins?.allow,
    payload?.runtimeConfig?.plugins?.allow,
  );

  const hasEntry = coerceBoolean(firstDefined(
    pluginNode?.hasEntry,
    pluginNode?.entryExists,
    entryNode ? true : undefined,
    hasOwnEntries(entriesNode) ? Object.prototype.hasOwnProperty.call(entriesNode, pluginId) : undefined,
  ));

  const enabled = coerceBoolean(firstDefined(
    pluginNode?.enabled,
    pluginNode?.isEnabled,
    pluginNode?.status === "enabled" ? true : undefined,
    pluginNode?.status === "disabled" ? false : undefined,
    entryNode?.enabled,
    entryNode?.isEnabled,
  ));

  const configPresent = coerceBoolean(firstDefined(
    pluginNode?.configPresent,
    pluginNode?.hasConfig,
    entryNode?.config ? true : undefined,
    pluginNode?.config ? true : undefined,
  ));

  const allowListed = coerceBoolean(firstDefined(
    pluginNode?.allowListed,
    pluginNode?.isAllowed,
    Array.isArray(allowNode) ? allowNode.includes(pluginId) : undefined,
  ));

  return {
    pluginId,
    hasEntry,
    enabled,
    configPresent,
    allowListed,
  };
}

export async function collectOpenClawDoctorReport(pluginId = "openclaw-skill-runtime", options = {}) {
  const cli = await inspectOpenClaw(options);
  if (!cli.ok) {
    return {
      cli,
      gateway: {
        ok: false,
        checked: false,
        error: "openclaw CLI unavailable",
      },
      pluginConfig: {
        ok: false,
        checked: false,
        pluginId,
        error: "openclaw CLI unavailable",
        hints: null,
      },
      pluginRuntime: {
        ok: false,
        checked: false,
        pluginId,
        error: "openclaw CLI unavailable",
      },
    };
  }

  const gatewayResult = await runOpenClaw(["gateway", "status", "--require-rpc"], {
    ...options,
    timeoutMs: 15000,
  });
  const pluginInspectResult = await runOpenClaw(["plugins", "inspect", pluginId, "--json"], {
    ...options,
    timeoutMs: 15000,
  });
  const pluginRuntimeResult = await runOpenClaw(["plugins", "inspect", pluginId, "--runtime", "--json"], {
    ...options,
    timeoutMs: 15000,
  });

  const inspectJson = parseJsonLoose(pluginInspectResult.stdout);
  const runtimeJson = parseJsonLoose(pluginRuntimeResult.stdout);
  return {
    cli,
    gateway: {
      ok: gatewayResult.ok,
      checked: true,
      error: gatewayResult.ok ? null : gatewayResult.error?.message || gatewayResult.stderr || "gateway status failed",
      summary: gatewayResult.stdout.trim() || gatewayResult.stderr.trim() || null,
    },
    pluginConfig: {
      ok: pluginInspectResult.ok,
      checked: true,
      pluginId,
      error: pluginInspectResult.ok ? null : pluginInspectResult.error?.message || pluginInspectResult.stderr || "plugin inspect failed",
      summary: pluginInspectResult.stdout.trim() || pluginInspectResult.stderr.trim() || null,
      json: inspectJson,
      hints: extractPluginConfigHints(inspectJson, pluginId),
    },
    pluginRuntime: {
      ok: pluginRuntimeResult.ok,
      checked: true,
      pluginId,
      error: pluginRuntimeResult.ok ? null : pluginRuntimeResult.error?.message || pluginRuntimeResult.stderr || "plugin runtime inspect failed",
      summary: pluginRuntimeResult.stdout.trim() || pluginRuntimeResult.stderr.trim() || null,
      json: runtimeJson,
    },
  };
}

export function formatOpenClawDoctorReport(report) {
  const hints = report.pluginConfig?.hints || {};
  const formatHint = (value) => value === undefined ? "unknown" : (value ? "yes" : "no");
  const lines = [
    "OpenClaw gateway checks",
    `- OpenClaw CLI available: ${report.cli.ok ? "yes" : "no"}`,
    `- OpenClaw command: ${report.cli.command || "<missing>"}`,
    `- OpenClaw version: ${report.cli.version || "<unknown>"}`,
    `- Gateway RPC reachable: ${report.gateway.checked ? (report.gateway.ok ? "yes" : "no") : "not-checked"}`,
    `- Plugin inspect available: ${report.pluginConfig?.checked ? (report.pluginConfig.ok ? "yes" : "no") : "not-checked"}`,
    `- Plugin entry present: ${report.pluginConfig?.checked ? formatHint(hints.hasEntry) : "not-checked"}`,
    `- Plugin enabled: ${report.pluginConfig?.checked ? formatHint(hints.enabled) : "not-checked"}`,
    `- Plugin config present: ${report.pluginConfig?.checked ? formatHint(hints.configPresent) : "not-checked"}`,
    `- Plugin allowlisted: ${report.pluginConfig?.checked ? formatHint(hints.allowListed) : "not-checked"}`,
    `- Plugin runtime loaded: ${report.pluginRuntime.checked ? (report.pluginRuntime.ok ? "yes" : "no") : "not-checked"}`,
  ];

  if (report.cli.error) lines.push(`- OpenClaw error: ${report.cli.error}`);
  if (report.gateway.error) lines.push(`- Gateway error: ${report.gateway.error}`);
  if (report.pluginConfig?.error) lines.push(`- Plugin inspect error: ${report.pluginConfig.error}`);
  if (report.pluginRuntime.error) lines.push(`- Plugin runtime error: ${report.pluginRuntime.error}`);
  if (report.pluginRuntime.checked && !report.pluginRuntime.ok) {
    lines.push("- Recovery hint: verify plugins.entries.openclaw-skill-runtime exists, the plugin is enabled, any plugin allowlist includes it, then restart Gateway and re-run doctor.");
  }

  return lines.join("\n");
}
