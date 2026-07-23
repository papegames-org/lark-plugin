function validateCliPath(cliPath) {
  const value = String(cliPath || "").trim();
  if (!value) throw new Error("missing cliPath");
  if (/\s/.test(value)) throw new Error("invalid cliPath");
  return value;
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes.map((s) => typeof s === "string" ? s.trim() : "").filter(Boolean))];
}

function parseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const DEFAULT_LARK_CLI_PATH = "lark-cli";

export function createLarkCliAuthAdapter(options = {}) {
  const execFile = options.execFile;
  const spawn = options.spawn;
  if (typeof execFile !== "function") throw new Error("missing execFile");
  if (typeof spawn !== "function") throw new Error("missing spawn");

  const cliPath = validateCliPath("cliPath" in options ? options.cliPath : DEFAULT_LARK_CLI_PATH);
  const defaultTimeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 20000;
  const log = typeof options.log === "function" ? options.log : () => {};

  const state = { checked: false, version: null };

  function exec(args, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve) => {
      execFile(cliPath, args, {
        timeout: timeoutMs,
        shell: false,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      });
    });
  }

  async function capabilityCheck() {
    if (state.checked) return { ok: true, version: state.version };
    const help = await exec(["auth", "login", "--help"], 8000);
    const combined = `${help.stdout}\n${help.stderr}`.toLowerCase();
    const ok = combined.includes("--no-wait") && combined.includes("--json") && combined.includes("device");
    if (!ok) {
      log("lark-cli capabilityCheck failed: auth login --help missing required flags");
      return { ok: false, error: "lark-cli unsupported" };
    }
    const version = await exec(["--version"], 8000);
    state.version = (version.stdout || version.stderr || "").trim() || null;
    state.checked = true;
    return { ok: true, version: state.version };
  }

  async function bind({ appId }) {
    const normalizedAppId = String(appId || "").trim();
    if (!normalizedAppId) return { ok: false, error: "missing appId" };
    const result = await exec(["config", "bind", "--source", "openclaw", "--app-id", normalizedAppId, "--identity", "user-default"], 30000);
    if (!result.ok) return { ok: false, error: "bind failed", detail: (result.stderr || result.stdout || "").trim() };
    return { ok: true };
  }

  async function check({ scopes }) {
    const normalized = normalizeScopes(scopes);
    if (!normalized.length) return { ok: true, missing: [] };
    const result = await exec(["auth", "check", "--scope", normalized.join(" ")], 20000);
    const payload = parseJson(result.stdout) || parseJson(result.stderr);
    if (payload && payload.ok === true) return { ok: true, missing: [] };
    const missing = Array.isArray(payload?.missing)
      ? payload.missing.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    return { ok: false, missing: missing.length ? missing : normalized };
  }

  async function startDeviceFlow({ scopes }) {
    const normalized = normalizeScopes(scopes);
    if (!normalized.length) return { ok: false, error: "no scopes" };
    const result = await exec(["auth", "login", "--scope", normalized.join(" "), "--no-wait", "--json"], 30000);
    const payload = parseJson(result.stdout) || parseJson(result.stderr);
    if (!payload || typeof payload !== "object") return { ok: false, error: "login output is not json" };
    const verificationUrl = String(payload.verification_url || payload.verificationUrl || "").trim();
    const deviceCode = String(payload.device_code || payload.deviceCode || "").trim();
    const expiresIn = Number.isFinite(Number(payload.expires_in || payload.expiresIn))
      ? Number(payload.expires_in || payload.expiresIn)
      : null;
    if (!verificationUrl || !deviceCode) return { ok: false, error: "missing device flow fields" };
    return { ok: true, verificationUrl, deviceCode, expiresIn };
  }

  function waitForDeviceFlow({ deviceCode, timeoutMs }) {
    const code = String(deviceCode || "").trim();
    if (!code) return Promise.resolve({ ok: false, status: "failed" });
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 180000;
    const child = spawn(cliPath, ["auth", "login", "--device-code", code], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const startedAt = Date.now();
    return new Promise((resolve) => {
      const killAll = () => {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        try { child.kill("SIGKILL"); } catch {}
      };

      const drain = (stream) => {
        if (!stream) return;
        stream.on("data", () => {});
      };
      drain(child.stdout);
      drain(child.stderr);

      const timeout = setTimeout(() => {
        killAll();
        resolve({ ok: false, status: "timeout" });
      }, effectiveTimeoutMs);

      child.on("exit", (code) => {
        clearTimeout(timeout);
        const elapsedMs = Date.now() - startedAt;
        if (code === 0) return resolve({ ok: true, status: "completed", elapsedMs });
        return resolve({ ok: false, status: "failed", elapsedMs });
      });
      child.on("error", () => {
        clearTimeout(timeout);
        killAll();
        resolve({ ok: false, status: "failed" });
      });
    });
  }

  return {
    cliPath,
    capabilityCheck,
    bind,
    check,
    startDeviceFlow,
    waitForDeviceFlow,
  };
}
