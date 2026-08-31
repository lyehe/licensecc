import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ENV_ALIASES = {
  baseUrl: ["STAGING_PORTAL_BASE_URL", "LICENSECC_PORTAL_URL"],
  sessionCookie: ["STAGING_PORTAL_SESSION_COOKIE", "LICENSECC_PORTAL_SESSION_COOKIE"],
  email: ["STAGING_PORTAL_EMAIL", "LICENSECC_PORTAL_EMAIL"],
  otpCode: ["STAGING_PORTAL_OTP_CODE", "LICENSECC_PORTAL_OTP_CODE"],
  bootstrapBearer: ["STAGING_PORTAL_BOOTSTRAP_BEARER", "LICENSECC_PORTAL_BOOTSTRAP_BEARER"],
  bootstrapAccessJwt: ["STAGING_PORTAL_ACCESS_JWT", "LICENSECC_PORTAL_ACCESS_JWT"],
  requestOtp: ["STAGING_PORTAL_REQUEST_OTP", "LICENSECC_PORTAL_REQUEST_OTP"],
  allowSeatMutation: ["STAGING_PORTAL_ALLOW_SEAT_MUTATION", "LICENSECC_PORTAL_ALLOW_SEAT_MUTATION"],
  floatingEntitlementId: ["STAGING_PORTAL_FLOATING_ENTITLEMENT_ID", "LICENSECC_PORTAL_FLOATING_ENTITLEMENT_ID"],
  allowDownload: ["STAGING_PORTAL_ALLOW_DOWNLOAD", "LICENSECC_PORTAL_ALLOW_DOWNLOAD"],
  downloadEntitlementId: ["STAGING_PORTAL_DOWNLOAD_ENTITLEMENT_ID", "LICENSECC_PORTAL_DOWNLOAD_ENTITLEMENT_ID"],
  deviceKeyId: ["STAGING_PORTAL_DEVICE_KEY_ID", "LICENSECC_PORTAL_DEVICE_KEY_ID"],
  logout: ["STAGING_PORTAL_LOGOUT", "LICENSECC_PORTAL_LOGOUT"],
};

const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
const MAX_DOCUMENT_RESPONSE_BYTES = 64 * 1024;
const MAX_DOWNLOAD_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedBytes(response, limit, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} exceeded the bounded response limit`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeded the bounded response limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedText(response, limit, label) {
  const bytes = await readBoundedBytes(response, limit, label);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
}

function envText(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function envBool(env, names, defaultValue = false) {
  const value = envText(env, names);
  if (value === undefined) {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function configured(env) {
  return Object.values(ENV_ALIASES).some((names) => envText(env, names) !== undefined);
}

function requireUrl(value, label) {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }
  return new URL(value);
}

function validateOptions(env = process.env) {
  if (!configured(env)) {
    return { skipped: true, reason: "staging portal drill environment is not configured" };
  }

  const sessionCookie = envText(env, ENV_ALIASES.sessionCookie);
  const email = envText(env, ENV_ALIASES.email);
  const otpCode = envText(env, ENV_ALIASES.otpCode);
  const bootstrapBearer = envText(env, ENV_ALIASES.bootstrapBearer);

  let authMode = null;
  if (sessionCookie !== undefined) {
    authMode = "session_cookie";
  } else if (email !== undefined && otpCode !== undefined) {
    authMode = "otp_code";
  } else if (email !== undefined && bootstrapBearer !== undefined) {
    authMode = "bootstrap_bearer";
  } else {
    throw new Error(
      "configure STAGING_PORTAL_SESSION_COOKIE, or STAGING_PORTAL_EMAIL plus STAGING_PORTAL_OTP_CODE, or STAGING_PORTAL_EMAIL plus STAGING_PORTAL_BOOTSTRAP_BEARER",
    );
  }

  return {
    skipped: false,
    baseUrl: requireUrl(envText(env, ENV_ALIASES.baseUrl), "STAGING_PORTAL_BASE_URL or LICENSECC_PORTAL_URL"),
    authMode,
    sessionCookie,
    email,
    otpCode,
    bootstrapBearer,
    bootstrapAccessJwt: envText(env, ENV_ALIASES.bootstrapAccessJwt),
    requestOtp: envBool(env, ENV_ALIASES.requestOtp, false),
    allowSeatMutation: envBool(env, ENV_ALIASES.allowSeatMutation, false),
    floatingEntitlementId: envText(env, ENV_ALIASES.floatingEntitlementId),
    allowDownload: envBool(env, ENV_ALIASES.allowDownload, false),
    downloadEntitlementId: envText(env, ENV_ALIASES.downloadEntitlementId),
    deviceKeyId: envText(env, ENV_ALIASES.deviceKeyId) ?? `staging-${randomUUID()}`,
    logout: envBool(env, ENV_ALIASES.logout, authMode !== "session_cookie"),
  };
}

function splitSetCookieHeader(value) {
  if (typeof value !== "string" || value === "") {
    return [];
  }
  return value.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  add(setCookie) {
    const pair = String(setCookie ?? "").split(";")[0]?.trim() ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) {
      return;
    }
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value === "") {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, value);
    }
  }

  capture(response) {
    const getSetCookie = response.headers?.getSetCookie;
    const values = typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : splitSetCookieHeader(response.headers?.get("set-cookie"));
    for (const value of values) {
      this.add(value);
    }
    return values;
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function jsonHeaders(options) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (options.method !== undefined && options.method !== "GET" && options.method !== "HEAD") {
    headers.set("origin", options.origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  const cookie = options.cookieJar.header();
  if (cookie !== "") {
    headers.set("cookie", cookie);
  }
  return headers;
}

async function requestJson(options, path, init = {}) {
  const url = new URL(path, options.baseUrl);
  const method = init.method ?? "GET";
  const response = await options.fetchFn(url, {
    method,
    headers: jsonHeaders({
      ...init,
      method,
      origin: options.baseUrl.origin,
      cookieJar: options.cookieJar,
    }),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const setCookies = options.cookieJar.capture(response);
  const text = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES, `${method} ${path}`);
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON response with status ${response.status}`);
  }
  return { response, body, setCookies };
}

async function requestBytes(options, path, init = {}) {
  const url = new URL(path, options.baseUrl);
  const method = init.method ?? "GET";
  const response = await options.fetchFn(url, {
    method,
    headers: jsonHeaders({
      ...init,
      method,
      origin: options.baseUrl.origin,
      cookieJar: options.cookieJar,
    }),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  options.cookieJar.capture(response);
  return {
    response,
    bytes: await readBoundedBytes(response, MAX_DOWNLOAD_RESPONSE_BYTES, `${method} ${path}`),
  };
}

async function requestDocument(options, path) {
  const url = new URL(path, options.baseUrl);
  const response = await options.fetchFn(url, {
    method: "GET",
    headers: jsonHeaders({
      method: "GET",
      origin: options.baseUrl.origin,
      cookieJar: options.cookieJar,
    }),
  });
  options.cookieJar.capture(response);
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") ?? "",
    text: await readBoundedText(response, MAX_DOCUMENT_RESPONSE_BYTES, `GET ${path}`),
  };
}

function assertEnvelope(result, expectedCode, label) {
  if (!result.response.ok || result.body?.ok !== true || result.body?.code !== expectedCode) {
    throw new Error(`${label} failed: status=${result.response.status}; response_ok=${result.response.ok}; envelope_ok=${result.body?.ok === true}; code_matches=${result.body?.code === expectedCode}`);
  }
  return result.body;
}

function assertAction(result, label) {
  if (!result.response.ok || result.body?.ok !== true) {
    throw new Error(`${label} failed: status=${result.response.status}; response_ok=${result.response.ok}; envelope_ok=${result.body?.ok === true}`);
  }
  return result.body;
}

function assertUnauthorized(result, label) {
  if (result.response.status !== 401 || result.body?.ok !== false || result.body?.code !== "unauthorized") {
    throw new Error(`${label} failed: status=${result.response.status}; envelope_denied=${result.body?.ok === false}; code_matches=${result.body?.code === "unauthorized"}`);
  }
}

function assertSecureSessionCookie(result, label) {
  const sessionCookie = result.setCookies.find((value) => /^lccp_session=/iu.test(value));
  const requiredAttributes = [
    /(?:^|;)\s*HttpOnly(?:;|$)/iu,
    /(?:^|;)\s*Secure(?:;|$)/iu,
    /(?:^|;)\s*SameSite=Lax(?:;|$)/iu,
    /(?:^|;)\s*Path=\/(?:;|$)/iu,
    /(?:^|;)\s*Max-Age=[1-9]\d*(?:;|$)/iu,
  ];
  if (sessionCookie === undefined || !requiredAttributes.every((pattern) => pattern.test(sessionCookie))) {
    throw new Error(`${label} did not issue the required secure session cookie policy`);
  }
}

function findStringKey(value, key) {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  if (typeof value[key] === "string" && value[key] !== "") {
    return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findStringKey(child, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function selectEntitlement(items, explicitId, predicate, label) {
  if (explicitId !== undefined) {
    return explicitId;
  }
  const match = items.find(predicate);
  if (typeof match?.id === "string" && match.id !== "") {
    return match.id;
  }
  throw new Error(`${label} entitlement id is required`);
}

async function authenticate(options) {
  if (options.authMode === "session_cookie") {
    options.cookieJar.add(options.sessionCookie);
    return false;
  }

  if (options.authMode === "bootstrap_bearer") {
    const headers = { authorization: `Bearer ${options.bootstrapBearer}` };
    if (options.bootstrapAccessJwt !== undefined) {
      headers["cf-access-jwt-assertion"] = options.bootstrapAccessJwt;
    }
    const bootstrap = assertEnvelope(await requestJson(options, "/portal/v1/admin/bootstrap-otp", {
      method: "POST",
      headers,
      body: { email: options.email },
    }), "bootstrap_otp", "portal bootstrap OTP");
    const secret = bootstrap.data?.secret;
    if (typeof secret !== "string" || secret === "") {
      throw new Error("portal bootstrap OTP did not return a secret for the configured email");
    }
    const signIn = await requestJson(options, "/portal/v1/auth/magic-redeem", {
      method: "POST",
      body: { token: secret },
    });
    assertEnvelope(signIn, "signed_in", "portal bootstrap sign-in");
    assertSecureSessionCookie(signIn, "portal bootstrap sign-in");
    return true;
  }

  if (options.requestOtp) {
    assertEnvelope(await requestJson(options, "/portal/v1/auth/request", {
      method: "POST",
      body: { email: options.email },
    }), "otp_requested", "portal OTP request");
  }
  const signIn = await requestJson(options, "/portal/v1/auth/verify", {
    method: "POST",
    body: { email: options.email, code: options.otpCode },
  });
  assertEnvelope(signIn, "signed_in", "portal OTP sign-in");
  assertSecureSessionCookie(signIn, "portal OTP sign-in");
  return true;
}

async function runSeatCycle(options, entitlements) {
  if (!options.allowSeatMutation) {
    return { enabled: false };
  }
  const entitlementId = selectEntitlement(
    entitlements,
    options.floatingEntitlementId,
    (item) => item?.license_mode === "floating",
    "floating seat-cycle",
  );
  const clientInstanceId = `staging-${randomUUID()}`;
  const checkout = assertAction(await requestJson(options, "/api/portal/checkout", {
    method: "POST",
    body: {
      entitlement_id: entitlementId,
      client_instance_id: clientInstanceId,
      nonce: randomBytes(32).toString("hex"),
    },
  }), "portal checkout");
  const seatId = findStringKey(checkout, "seat_id");
  if (seatId === undefined) {
    throw new Error("portal checkout did not return a seat_id for heartbeat/release");
  }
  assertAction(await requestJson(options, "/api/portal/heartbeat", {
    method: "POST",
    body: {
      entitlement_id: entitlementId,
      client_instance_id: clientInstanceId,
      seat_id: seatId,
      nonce: randomBytes(32).toString("hex"),
    },
  }), "portal heartbeat");
  assertAction(await requestJson(options, "/api/portal/release", {
    method: "POST",
    body: {
      entitlement_id: entitlementId,
      client_instance_id: clientInstanceId,
      seat_id: seatId,
      nonce: randomBytes(32).toString("hex"),
    },
  }), "portal release");
  return { enabled: true, entitlement_id_configured: options.floatingEntitlementId !== undefined };
}

async function runDownload(options, entitlements) {
  if (!options.allowDownload) {
    return { enabled: false };
  }
  const entitlementId = selectEntitlement(
    entitlements,
    options.downloadEntitlementId,
    (item) => typeof item?.id === "string" && item.id !== "",
    "download",
  );
  const downloaded = await requestBytes(options, "/api/portal/download", {
    method: "POST",
    body: {
      entitlement_id: entitlementId,
      device_key_id: options.deviceKeyId,
    },
  });
  const disposition = downloaded.response.headers.get("content-disposition") ?? "";
  if (!downloaded.response.ok || downloaded.bytes.byteLength === 0 || !/attachment/i.test(disposition)) {
    throw new Error(`portal download failed: ${JSON.stringify({ status: downloaded.response.status, disposition, bytes: downloaded.bytes.byteLength })}`);
  }
  if (downloaded.response.headers.get("authorization") !== null) {
    throw new Error("portal download leaked an Authorization response header");
  }
  return { enabled: true, entitlement_id_configured: options.downloadEntitlementId !== undefined, bytes: downloaded.bytes.byteLength };
}

async function runStagingPortalDrill(options, dependencies = {}) {
  if (options.skipped) {
    return { ok: true, skipped: true, reason: options.reason };
  }
  const runtime = {
    ...options,
    fetchFn: dependencies.fetchFn ?? fetch,
    cookieJar: dependencies.cookieJar ?? new CookieJar(),
  };

  const ui = await requestDocument(runtime, "/");
  if (!ui.ok || !/^text\/html(?:;|$)/iu.test(ui.contentType) || !/<(?:!doctype\s+html|html)\b/iu.test(ui.text)) {
    throw new Error(`portal UI failed: ${JSON.stringify({ status: ui.status, content_type: ui.contentType })}`);
  }
  const health = assertEnvelope(await requestJson(runtime, "/health"), "healthy", "portal health");
  const unauthenticated = await requestJson({ ...runtime, cookieJar: new CookieJar() }, "/api/portal/me");
  assertUnauthorized(unauthenticated, "portal unauthenticated read denial");
  const sessionCookiePolicyChecked = await authenticate(runtime);

  const me = assertEnvelope(await requestJson(runtime, "/api/portal/me"), "me", "portal me");
  const entitlements = assertEnvelope(await requestJson(runtime, "/api/portal/entitlements"), "entitlements", "portal entitlements");
  const devices = assertEnvelope(await requestJson(runtime, "/api/portal/devices"), "devices", "portal devices");
  const usage = assertEnvelope(await requestJson(runtime, "/api/portal/usage"), "usage", "portal usage");

  const entitlementItems = Array.isArray(entitlements.data?.items) ? entitlements.data.items : [];
  const seatCycle = await runSeatCycle(runtime, entitlementItems);
  const download = await runDownload(runtime, entitlementItems);

  let postLogoutStatus = null;
  if (runtime.logout) {
    assertEnvelope(await requestJson(runtime, "/portal/v1/auth/logout", {
      method: "POST",
      body: {},
    }), "logged_out", "portal logout");
    const postLogout = await requestJson(runtime, "/api/portal/me");
    assertUnauthorized(postLogout, "portal post-logout read denial");
    postLogoutStatus = postLogout.response.status;
  }

  return {
    ok: true,
    skipped: false,
    auth_mode: runtime.authMode,
    ui_status: ui.status,
    ui_content_type: ui.contentType,
    health_code: health.code,
    unauthenticated_status: unauthenticated.response.status,
    session_cookie_policy_checked: sessionCookiePolicyChecked,
    post_logout_status: postLogoutStatus,
    customer_id_present: typeof me.data?.customer_id === "string" && me.data.customer_id !== "",
    entitlement_count: entitlementItems.length,
    device_count: Array.isArray(devices.data?.items) ? devices.data.items.length : null,
    usage_count: Array.isArray(usage.data?.items) ? usage.data.items.length : null,
    seat_cycle: seatCycle,
    download,
    logout_performed: runtime.logout,
  };
}

async function main() {
  const result = await runStagingPortalDrill(validateOptions());
  console.log(JSON.stringify(result, null, 2));
}

export {
  CookieJar,
  ENV_ALIASES,
  configured,
  runStagingPortalDrill,
  splitSetCookieHeader,
  validateOptions,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
