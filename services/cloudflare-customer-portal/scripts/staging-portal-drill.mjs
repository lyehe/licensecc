import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decodeDeviceLeaseEnvelope,
  deviceLeaseSigningInput,
  deviceOperationBody,
  deviceProofSigningInput,
  encodeBase64url,
} from "@licensecc/licensing-domain/lease/device_protocol";

const ENV_ALIASES = {
  baseUrl: ["STAGING_PORTAL_BASE_URL", "LICENSECC_PORTAL_URL"],
  sessionCookie: ["STAGING_PORTAL_SESSION_COOKIE", "LICENSECC_PORTAL_SESSION_COOKIE"],
  email: ["STAGING_PORTAL_EMAIL", "LICENSECC_PORTAL_EMAIL"],
  otpCode: ["STAGING_PORTAL_OTP_CODE", "LICENSECC_PORTAL_OTP_CODE"],
  bootstrapBearer: ["STAGING_PORTAL_BOOTSTRAP_BEARER", "LICENSECC_PORTAL_BOOTSTRAP_BEARER"],
  bootstrapAccessJwt: ["STAGING_PORTAL_ACCESS_JWT", "LICENSECC_PORTAL_ACCESS_JWT"],
  requestOtp: ["STAGING_PORTAL_REQUEST_OTP", "LICENSECC_PORTAL_REQUEST_OTP"],
  protectedEntitlementId: ["STAGING_PORTAL_PROTECTED_ENTITLEMENT_ID", "LICENSECC_PORTAL_PROTECTED_ENTITLEMENT_ID"],
  backendBaseUrl: ["STAGING_BACKEND_BASE_URL", "LICENSECC_BACKEND_URL"],
  deviceClientId: ["STAGING_DEVICE_CLIENT_ID", "LICENSECC_DEVICE_CLIENT_ID"],
  deviceProject: ["STAGING_DEVICE_PROJECT", "LICENSECC_DEVICE_PROJECT"],
  deviceFeature: ["STAGING_DEVICE_FEATURE", "LICENSECC_DEVICE_FEATURE"],
  deviceRedirectUri: ["STAGING_DEVICE_REDIRECT_URI", "LICENSECC_DEVICE_REDIRECT_URI"],
  deviceAudience: ["STAGING_DEVICE_AUDIENCE", "LICENSECC_DEVICE_AUDIENCE"],
  boundLeasePublicKey: ["STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM", "LICENSECC_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM"],
  logout: ["STAGING_PORTAL_LOGOUT", "LICENSECC_PORTAL_LOGOUT"],
};

// The protected device journey enrolls a real device and holds a device slot on the configured
// entitlement for up to a day, so it runs only when every one of these inputs is set. The
// production post-deploy drill sets none of them.
const PROTECTED_DEVICE_INPUTS = [
  "protectedEntitlementId",
  "backendBaseUrl",
  "deviceClientId",
  "deviceProject",
  "deviceFeature",
  "deviceRedirectUri",
  "deviceAudience",
  "boundLeasePublicKey",
];

const EXCHANGE_PATH = "/v2/device-authorizations/exchange";
const RENEW_PATH = "/v2/device-leases/renew";
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const SPKI_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/u;

const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
const MAX_DOCUMENT_RESPONSE_BYTES = 64 * 1024;

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

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function randomId(size) {
  return encodeBase64url(new Uint8Array(randomBytes(size)));
}

function leasePublicKey(pem) {
  const label = ENV_ALIASES.boundLeasePublicKey.join(" or ");
  let key;
  try {
    key = SPKI_PEM.test(pem) ? createPublicKey(pem) : null;
  } catch {
    key = null;
  }
  if (key?.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072) {
    throw new Error(`${label} must be an RSA-3072 public key in SPKI PEM form`);
  }
  return {
    key,
    keyId: `sha256:${sha256Hex(key.export({ type: "spki", format: "der" }))}`,
  };
}

function protectedDeviceOptions(env) {
  const values = Object.fromEntries(PROTECTED_DEVICE_INPUTS.map((name) => [name, envText(env, ENV_ALIASES[name])]));
  const missing = PROTECTED_DEVICE_INPUTS.filter((name) => values[name] === undefined);
  if (missing.length === PROTECTED_DEVICE_INPUTS.length) {
    return { enabled: false };
  }
  if (missing.length > 0) {
    throw new Error(
      `the protected device journey runs only when all of its inputs are set; missing ${missing.map((name) => ENV_ALIASES[name].join(" or ")).join(", ")}`,
    );
  }
  const lease = leasePublicKey(values.boundLeasePublicKey);
  const runId = envText(env, ["GITHUB_RUN_ID"]);
  return {
    enabled: true,
    entitlementId: values.protectedEntitlementId,
    backendBaseUrl: requireUrl(values.backendBaseUrl, ENV_ALIASES.backendBaseUrl.join(" or ")),
    clientId: values.deviceClientId,
    project: values.deviceProject,
    feature: values.deviceFeature,
    redirectUri: values.deviceRedirectUri,
    audience: values.deviceAudience,
    leasePublicKey: lease.key,
    leaseKeyId: lease.keyId,
    deviceLabel: `staging drill ${runId !== undefined && /^[0-9]{1,20}$/u.test(runId) ? runId : randomBytes(6).toString("hex")}`,
  };
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
    protectedDevice: protectedDeviceOptions(env),
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
  return { response, body: await readJson(response, `${method} ${path}`), setCookies };
}

async function readJson(response, label) {
  const text = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES, label);
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response with status ${response.status}`);
  }
}

// Device calls go straight to the licensing backend. They never carry the portal session cookie
// or a portal Origin: the device proves possession of its key, not a browser session.
async function requestBackend(options, path, body) {
  const response = await options.fetchFn(new URL(path, options.protectedDevice.backendBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await readJson(response, `POST ${path}`) };
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

// ECDSA signatures are (r, s) pairs where s and n - s both verify; the backend accepts only the
// low-S form, so a proof is normalised before it is sent.
function lowS(signature) {
  if (signature.length !== 64) {
    throw new Error("device proof signature has an unexpected length");
  }
  const s = BigInt(`0x${Buffer.from(signature.subarray(32)).toString("hex")}`);
  if (s <= P256_ORDER / 2n) {
    return signature;
  }
  const normalized = new Uint8Array(signature);
  normalized.set(Buffer.from((P256_ORDER - s).toString(16).padStart(64, "0"), "hex"), 32);
  return normalized;
}

async function requestChallenge(options, body, label) {
  const challenge = assertEnvelope(await requestBackend(options, "/v2/device-challenges", body), "challenge_created", label).data;
  if (typeof challenge?.challenge_id !== "string" || typeof challenge.nonce !== "string" || !Number.isSafeInteger(challenge.expires_at)) {
    throw new Error(`${label} returned an invalid challenge`);
  }
  return challenge;
}

async function deviceProof(device, key, path, purpose, body, challenge) {
  const intent = {
    audience: device.audience,
    method: "POST",
    path,
    key_id: key.keyId,
    operation_id: body.operation_id,
    body_sha256: sha256Hex(deviceOperationBody(purpose, body)),
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    expires_at: challenge.expires_at,
  };
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, deviceProofSigningInput(intent)));
  return {
    key_id: key.keyId,
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    expires_at: challenge.expires_at,
    signature: encodeBase64url(lowS(signature)),
  };
}

// Verifies the lease signature against the configured lease key and that its claims name this
// device, binding and request. Failures name the claim, never its value or the lease itself.
function verifyDeviceLease(device, token, expected, label) {
  let lease;
  try {
    lease = decodeDeviceLeaseEnvelope(token);
  } catch {
    throw new Error(`${label} returned a malformed lease`);
  }
  let verified = false;
  try {
    verified = verify("RSA-SHA256", deviceLeaseSigningInput(lease.payload), device.leasePublicKey, lease.signature);
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error(`${label} lease signature did not verify against the configured lease public key`);
  }
  const claims = {
    "key-id": device.leaseKeyId,
    audience: device.audience,
    project: device.project,
    feature: device.feature,
    "device-key-id": expected.keyId,
    "binding-id": expected.bindingId,
    generation: expected.generation,
    "operation-id": expected.operationId,
  };
  const mismatched = Object.keys(claims).filter((claim) => lease.claims[claim] !== claims[claim]);
  if (mismatched.length > 0) {
    throw new Error(`${label} lease claims did not match: ${mismatched.join(", ")}`);
  }
}

function approvedCallbackCode(callbackUrl, redirectUri, state) {
  let callback = null;
  try {
    callback = new URL(callbackUrl);
  } catch {
    callback = null;
  }
  const expected = new URL(redirectUri);
  const code = callback?.searchParams.get("code");
  if (callback === null || callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.searchParams.get("state") !== state || typeof code !== "string" || code === "") {
    throw new Error("portal device consent approval returned a callback for a different device request");
  }
  return code;
}

// Enrolls a fresh software P-256 device through browser consent, exchanges and renews its lease
// with key-possession proofs, then retires the binding. The retired binding keeps its device slot
// until its hold ends, so each run occupies one slot on the configured entitlement for up to a day.
async function runProtectedDeviceJourney(options) {
  const device = options.protectedDevice;
  if (device?.enabled !== true) {
    return { enabled: false };
  }
  if (typeof options.customerId !== "string" || options.customerId === "") {
    throw new Error("the protected device journey requires the signed-in customer id");
  }
  const consentHeaders = { "x-expected-customer-id": encodeURIComponent(options.customerId) };

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const key = { privateKey: pair.privateKey, keyId: `sha256:${sha256Hex(spki)}` };
  const codeVerifier = randomId(32);
  const state = randomId(32);

  const attempt = assertEnvelope(await requestBackend(options, "/v2/device-authorizations", {
    client_id: device.clientId,
    project: device.project,
    public_key_spki: encodeBase64url(spki),
    device_label: device.deviceLabel,
    redirect_uri: device.redirectUri,
    state,
    code_challenge: encodeBase64url(new Uint8Array(createHash("sha256").update(codeVerifier).digest())),
    code_challenge_method: "S256",
    requested_feature: device.feature,
  }), "authorization_created", "protected device authorization").data;
  const attemptHandle = attempt?.attempt_handle;
  if (typeof attemptHandle !== "string" || attemptHandle === "") {
    throw new Error("protected device authorization did not return an attempt handle");
  }

  const inspection = assertEnvelope(await requestJson(options, "/api/portal/device-authorizations/inspect", {
    method: "POST",
    headers: consentHeaders,
    body: { attempt_handle: attemptHandle },
  }), "authorization_inspected", "portal device consent inspection").data;
  if (inspection?.status !== "pending" || inspection.revision !== 0
      || !Array.isArray(inspection.entitlements) || !inspection.entitlements.some((item) => item?.id === device.entitlementId)) {
    throw new Error("portal device consent inspection did not offer the protected entitlement to a pending authorization");
  }
  // The portal takes the approval's operation id from its Idempotency-Key header.
  const approval = assertEnvelope(await requestJson(options, "/api/portal/device-authorizations/approve", {
    method: "POST",
    headers: { ...consentHeaders, "idempotency-key": randomId(32) },
    body: { attempt_handle: attemptHandle, entitlement_id: device.entitlementId, expected_attempt_revision: 0 },
  }), "authorization_approved", "portal device consent approval").data;
  const code = approvedCallbackCode(approval?.callback_url, device.redirectUri, state);

  const exchange = {
    attempt_handle: attemptHandle,
    code,
    code_verifier: codeVerifier,
    redirect_uri: device.redirectUri,
    operation_id: randomId(32),
  };
  const exchangeChallenge = await requestChallenge(options, {
    purpose: "exchange",
    attempt_handle: attemptHandle,
    operation_id: exchange.operation_id,
  }, "protected device exchange challenge");
  const activated = assertEnvelope(await requestBackend(options, EXCHANGE_PATH, {
    ...exchange,
    proof: await deviceProof(device, key, EXCHANGE_PATH, "exchange", exchange, exchangeChallenge),
  }), "device_activated", "protected device exchange").data;
  const bindingId = activated?.binding_id;
  const generation = activated?.generation;
  if (typeof bindingId !== "string" || bindingId === "" || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("protected device exchange did not return a binding");
  }
  verifyDeviceLease(device, activated.lease, { keyId: key.keyId, bindingId, generation, operationId: exchange.operation_id }, "protected device exchange");

  const renewal = { binding_id: bindingId, generation, operation_id: randomId(32) };
  const renewChallenge = await requestChallenge(options, {
    purpose: "renew",
    binding_id: bindingId,
    operation_id: renewal.operation_id,
  }, "protected device renewal challenge");
  const renewed = assertEnvelope(await requestBackend(options, RENEW_PATH, {
    ...renewal,
    proof: await deviceProof(device, key, RENEW_PATH, "renew", renewal, renewChallenge),
  }), "device_renewed", "protected device renewal").data;
  if (renewed?.binding_id !== bindingId || renewed.generation !== generation) {
    throw new Error("protected device renewal returned a different binding");
  }
  verifyDeviceLease(device, renewed.lease, { keyId: key.keyId, bindingId, generation, operationId: renewal.operation_id }, "protected device renewal");

  // Retirement is guarded by the binding's current revision, which the portal reports.
  const listed = assertEnvelope(await requestJson(options, `/api/portal/device-bindings?${new URLSearchParams({ binding_id: bindingId })}`, {
    headers: consentHeaders,
  }), "device_bindings", "portal device binding read").data;
  const row = Array.isArray(listed?.items) && listed.items.length === 1 ? listed.items[0] : null;
  if (row?.binding_id !== bindingId || row.state !== "active" || !Number.isSafeInteger(row.revision)) {
    throw new Error("portal device binding read did not report the drill binding as active");
  }
  const retired = await requestJson(options, "/api/portal/device-bindings/retire", {
    method: "POST",
    headers: { ...consentHeaders, "idempotency-key": randomId(32) },
    body: { binding_id: bindingId, expected_revision: row.revision },
  });
  const retirement = assertEnvelope(retired, "binding_retired", "portal device binding retirement").data;
  if (retired.response.status !== 200 || retirement?.binding_id !== bindingId || retirement.state !== "retiring"
      || retirement.revision !== row.revision + 1) {
    throw new Error("portal device binding retirement did not retire the drill binding");
  }

  return { enabled: true, exchanged: true, renewed: true, retired: true, lease_key_id: device.leaseKeyId };
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

  const entitlementItems = Array.isArray(entitlements.data?.items) ? entitlements.data.items : [];
  const protectedDevice = await runProtectedDeviceJourney({ ...runtime, customerId: me.data?.customer_id });

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
    protected_device: protectedDevice,
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
