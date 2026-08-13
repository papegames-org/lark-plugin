import { gzipSync } from "node:zlib";

const tenantTokenCache = new Map();

function isUsableHostname(hostname) {
  if (!hostname) return false;
  if (hostname === "localhost") return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.includes(":")) return true;
  return hostname.includes(".");
}

function toHttpsOrigin(value) {
  if (!value) return null;
  const source = String(value).trim();
  if (!source) return null;
  try {
    const direct = new URL(source);
    return isUsableHostname(direct.hostname) ? direct.origin : null;
  } catch {
    try {
      const normalized = new URL(`https://${source.replace(/^\/+|\/+$/g, "")}`);
      return isUsableHostname(normalized.hostname) ? normalized.origin : null;
    } catch {
      return null;
    }
  }
}

export function resolveFeishuBrand(domain) {
  const normalized = String(domain || "").trim().toLowerCase();
  if (normalized === "lark") return "lark";
  const origin = toHttpsOrigin(normalized);
  const hostname = origin ? new URL(origin).hostname.toLowerCase() : normalized.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (
    hostname === "lark.com" ||
    hostname === "larksuite.com" ||
    hostname.endsWith(".lark.com") ||
    hostname.endsWith(".larksuite.com")
  ) {
    return "lark";
  }
  return "feishu";
}

export function resolveRegistrationBaseUrl(brand) {
  if (brand === "lark") return "https://accounts.larksuite.com";
  return "https://accounts.feishu.cn";
}

function normalizeOpenApiBaseUrl(domain) {
  const origin = toHttpsOrigin(domain);
  if (!origin) return null;
  if (origin.includes("accounts.")) {
    return origin.replace("accounts.", "open.");
  }
  return origin;
}

export function resolveOpenApiBaseUrl({ brand, domain }) {
  const normalized = normalizeOpenApiBaseUrl(domain);
  if (normalized) return normalized;
  if (brand === "lark") return "https://open.larksuite.com";
  return "https://open.feishu.cn";
}

function encodeAddons(addons) {
  const json = JSON.stringify(addons);
  return gzipSync(Buffer.from(json, "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function beginScopeGrantFlow({ appId, brand, scopes, identity = "user", source = "openclaw-skill-runtime" }) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("no scopes");
  }

  const baseUrl = resolveRegistrationBaseUrl(brand);
  const response = await fetch(`${baseUrl}/oauth/v1/app/registration`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    }).toString(),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`scope grant init failed: HTTP ${response.status}`);
  }

  if (!response.ok || payload?.error) {
    throw new Error(payload?.error_description || payload?.error || `scope grant init failed: HTTP ${response.status}`);
  }

  const normalizedIdentity = String(identity || "user").toLowerCase() === "app" ? "app" : "user";
  const verificationUrl = new URL(payload.verification_uri_complete || payload.verification_uri);
  verificationUrl.searchParams.set("from", source);
  verificationUrl.searchParams.set("source", source);
  verificationUrl.searchParams.set("tp", "openclaw");
  verificationUrl.searchParams.set("clientID", appId);
  verificationUrl.searchParams.set("addons", encodeAddons({
    scopes: {
      [normalizedIdentity]: [...new Set(scopes)],
    },
  }));

  return {
    verificationUrl: verificationUrl.toString(),
    userCode: payload.user_code || null,
    deviceCode: payload.device_code || null,
    expiresIn: payload.expires_in || 600,
    interval: payload.interval || 5,
  };
}

export async function getTenantAccessToken(credentials) {
  const cacheKey = `${credentials.appId}::${credentials.appSecret}::${credentials.domain || ""}`;
  const cached = tenantTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const baseUrl = resolveOpenApiBaseUrl(credentials);
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0 || !payload?.tenant_access_token) {
    throw new Error(payload?.msg || payload?.message || `tenant_access_token request failed: HTTP ${response.status}`);
  }

  const expiresInMs = Math.max(60, Number(payload.expire || 7200) - 120) * 1000;
  tenantTokenCache.set(cacheKey, {
    token: payload.tenant_access_token,
    expiresAt: Date.now() + expiresInMs,
  });
  return payload.tenant_access_token;
}

export async function callFeishuOpenApi(credentials, { method = "GET", path, params, body }) {
  const baseUrl = resolveOpenApiBaseUrl(credentials);
  const token = await getTenantAccessToken(credentials);
  const url = new URL(path, baseUrl);

  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return response.json();
}
