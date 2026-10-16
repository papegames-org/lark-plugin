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

function uniqueScopes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((scope) => String(scope).trim()).filter(Boolean))];
}

function splitLegacyScopesByInstallGrant(scopes, scopeInstallGrant) {
  const legacy = uniqueScopes(scopes);
  if (!legacy.length || !scopeInstallGrant || typeof scopeInstallGrant !== "object") {
    return { tenant: [], user: legacy };
  }
  const tenant = legacy.filter((scope) => scopeInstallGrant[scope] === "app");
  const user = legacy.filter((scope) => scopeInstallGrant[scope] !== "app");
  return { tenant, user };
}

function buildScopeAddons({
  scopes,
  identity = "user",
  tenantScopes = null,
  userScopes = null,
  scopeInstallGrant = null,
}) {
  const addonScopes = {};
  const tenant = uniqueScopes(tenantScopes);
  const user = uniqueScopes(userScopes);
  if (tenant.length) addonScopes.tenant = tenant;
  if (user.length) addonScopes.user = user;

  if (!tenant.length && !user.length && uniqueScopes(scopes).length) {
    const split = splitLegacyScopesByInstallGrant(scopes, scopeInstallGrant);
    if (split.tenant.length) addonScopes.tenant = split.tenant;
    if (split.user.length) addonScopes.user = split.user;
    if (!Object.keys(addonScopes).length) {
      const legacyKey = String(identity || "user").toLowerCase() === "app" ? "tenant" : "user";
      addonScopes[legacyKey] = uniqueScopes(scopes);
    }
  }

  if (!Object.keys(addonScopes).length) {
    throw new Error("no scopes");
  }
  return addonScopes;
}

export async function beginScopeGrantFlow({
  appId,
  brand,
  scopes,
  identity = "user",
  tenantScopes = null,
  userScopes = null,
  scopeInstallGrant = null,
  source = "openclaw-skill-runtime",
}) {
  const scopeAddons = buildScopeAddons({
    scopes,
    identity,
    tenantScopes,
    userScopes,
    scopeInstallGrant,
  });

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

  const verificationUrl = new URL(payload.verification_uri_complete || payload.verification_uri);
  verificationUrl.searchParams.set("from", source);
  verificationUrl.searchParams.set("source", source);
  verificationUrl.searchParams.set("tp", "openclaw");
  verificationUrl.searchParams.set("clientID", appId);
  verificationUrl.searchParams.set("addons", encodeAddons({
    scopes: scopeAddons,
  }));

  return {
    verificationUrl: verificationUrl.toString(),
    userCode: payload.user_code || null,
    deviceCode: payload.device_code || null,
    expiresIn: payload.expires_in || 600,
    interval: payload.interval || 5,
  };
}

function classifyRegistrationPollResponse(response, payload) {
  const error = String(payload?.error || "").trim().toLowerCase();
  if (error === "authorization_pending" || error === "slow_down") {
    return { status: "pending", error, raw: payload };
  }
  if (error === "access_denied" || error === "expired_token") {
    return { status: "denied", error, raw: payload };
  }
  const hasToken =
    Boolean(payload?.access_token) ||
    Boolean(payload?.token) ||
    Boolean(payload?.data?.access_token);
  if (!error && (response.ok || hasToken)) {
    return { status: "authorized", raw: payload };
  }
  return {
    status: "failed",
    error: error || `HTTP ${response.status}`,
    raw: payload,
    httpStatus: response.status,
  };
}

async function postRegistrationPoll(baseUrl, bodyParams) {
  const fetchOptions = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams).toString(),
  };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    fetchOptions.signal = AbortSignal.timeout(15000);
  }
  const response = await fetch(`${baseUrl}/oauth/v1/app/registration`, fetchOptions);
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { parseError: true, bodyPreview: text.slice(0, 240) };
  }
  return { response, payload, text };
}

export async function pollScopeGrantRegistration({ brand, deviceCode, appId }) {
  const code = String(deviceCode || "").trim();
  const clientId = String(appId || "").trim();
  if (!code) return { status: "invalid", reason: "no deviceCode" };

  const baseUrl = resolveRegistrationBaseUrl(brand);
  const attempts = [
    {
      label: "token+client_id+grant_type",
      params: {
        action: "token",
        device_code: code,
        ...(clientId ? { client_id: clientId, clientID: clientId } : {}),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    },
    {
      label: "token+client_id",
      params: {
        action: "token",
        device_code: code,
        ...(clientId ? { client_id: clientId, clientID: clientId } : {}),
      },
    },
    {
      label: "token",
      params: {
        action: "token",
        device_code: code,
      },
    },
  ];

  let lastResult = { status: "failed", error: "no attempts" };
  for (const attempt of attempts) {
    const { response, payload } = await postRegistrationPoll(baseUrl, attempt.params);
    const classified = classifyRegistrationPollResponse(response, payload);
    lastResult = { ...classified, attempt: attempt.label };
    if (classified.status === "authorized" || classified.status === "pending" || classified.status === "denied") {
      return lastResult;
    }
  }
  return lastResult;
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

export async function uploadImFile(credentials, { fileName, content, fileType = "stream", timeoutMs = 60000 }) {
  const name = String(fileName || "diagnostic.log").trim() || "diagnostic.log";
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (!bytes || !bytes.length) {
    throw new Error("im file upload: empty content");
  }
  const baseUrl = resolveOpenApiBaseUrl(credentials);
  const token = await getTenantAccessToken(credentials);
  const form = new FormData();
  form.append("file_type", fileType);
  form.append("file_name", name);
  form.append("file", new Blob([bytes], { type: "text/plain" }), name);

  const fetchOptions = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  };
  const timeout = Number(timeoutMs);
  if (Number.isFinite(timeout) && timeout > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    fetchOptions.signal = AbortSignal.timeout(timeout);
  }

  const response = await fetch(`${baseUrl}/open-apis/im/v1/files`, fetchOptions);
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0 || !payload?.data?.file_key) {
    throw new Error(payload?.msg || payload?.message || `im file upload failed: HTTP ${response.status}`);
  }
  return payload.data.file_key;
}

export async function callFeishuOpenApi(credentials, { method = "GET", path, params, body, timeoutMs = 25000 }) {
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

  const fetchOptions = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  };
  const timeout = Number(timeoutMs);
  if (Number.isFinite(timeout) && timeout > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    fetchOptions.signal = AbortSignal.timeout(timeout);
  }

  const response = await fetch(url, fetchOptions);
  return response.json();
}
