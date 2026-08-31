import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HEX_64 = /^[0-9a-fA-F]{64}$/;

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/validate-access-admin.mjs --url <admin-worker-url> [--access-jwt <jwt>] [--non-admin-access-jwt <jwt>] [--require-non-admin] [--project DEFAULT] [--feature DEFAULT] [--fingerprint <64-hex>] [--read-only]

Access JWT defaults to the LICENSECC_ACCESS_JWT environment variable. Optional
non-admin JWT defaults to LICENSECC_NON_ADMIN_ACCESS_JWT. The script creates a
scratch entitlement, verifies idempotent replay, revokes it for cleanup, and
confirms revoked-terminal reactivation denial. Pass --read-only (or set
LICENSECC_ADMIN_READ_ONLY=1) for a production-safe UI and authenticated summary
check that performs no entitlement mutation.`);
  process.exit(exitCode);
}

function configValue(value) {
  if (value === undefined || value === true || value === "" || String(value).toLowerCase() === "true") {
    return undefined;
  }
  return value;
}

function truthy(value) {
  return /^(1|true|yes|on)$/iu.test(String(value ?? ""));
}

function npmConfigName(name) {
  return `npm_config_${name.replace(/^--/, "").replaceAll("-", "_")}`;
}

function parseArgs(argv, env = process.env) {
  const options = {};
  const positional = [];
  for (let index = 2; index < argv.length; ++index) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--read-only") {
      options.readOnly = true;
      continue;
    }
    if (arg === "--require-non-admin") {
      options.requireNonAdmin = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const assignment = /^--([^=]+)=(.*)$/.exec(arg);
    if (assignment !== null) {
      options[assignment[1]] = assignment[2];
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    options[arg.slice(2)] = value;
  }
  const valuedOptions = [
    ["url", 0],
    ["project", 1],
    ["feature", 2],
    ["fingerprint", 3],
  ];
  for (const [name, positionalIndex] of valuedOptions) {
    options[name] ??= configValue(env[npmConfigName(name)]) ?? positional[positionalIndex];
  }
  options["access-jwt"] ??= configValue(env[npmConfigName("access-jwt")]);
  options["non-admin-access-jwt"] ??= configValue(env[npmConfigName("non-admin-access-jwt")]);
  options.readOnly ??= truthy(configValue(env[npmConfigName("read-only")])) || truthy(env.LICENSECC_ADMIN_READ_ONLY);
  return options;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function safeName(value, label, maxLength) {
  const raw = requiredString(value, label);
  if (raw.length > maxLength || !/^[A-Za-z0-9_.:-]+$/.test(raw)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return raw;
}

function validatedFingerprint(value) {
  const raw = value === undefined ? randomBytes(32).toString("hex") : String(value);
  if (!HEX_64.test(raw)) {
    throw new Error("fingerprint must be exactly 64 hex characters");
  }
  return raw.toLowerCase();
}

function validateOptions(options, env = process.env) {
  if (options.help) {
    usage(0);
  }
  const baseUrl = new URL(requiredString(options.url, "url"));
  const token = options["access-jwt"] ?? env.LICENSECC_ACCESS_JWT;
  if (typeof token !== "string" || token === "") {
    throw new Error("access JWT is required through --access-jwt or LICENSECC_ACCESS_JWT");
  }
  const nonAdminAccessJwt = options["non-admin-access-jwt"] ?? env.LICENSECC_NON_ADMIN_ACCESS_JWT;
  if (options.requireNonAdmin === true && (typeof nonAdminAccessJwt !== "string" || nonAdminAccessJwt === "")) {
    throw new Error("non-admin Access JWT is required for this protected validation");
  }
  return {
    baseUrl,
    accessJwt: token,
    nonAdminAccessJwt,
    requireNonAdmin: options.requireNonAdmin === true,
    readOnly: options.readOnly === true || truthy(options.readOnly),
    project: safeName(options.project ?? "DEFAULT", "project", 127),
    feature: safeName(options.feature ?? "DEFAULT", "feature", 15),
    fingerprint: validatedFingerprint(options.fingerprint),
  };
}

function urlFor(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

function accessHeaders(token, extra = {}) {
  return {
    "cf-access-jwt-assertion": token,
    "cookie": `CF_Authorization=${token}`,
    "content-type": "application/json",
    ...extra,
  };
}

const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
const MAX_DOCUMENT_RESPONSE_BYTES = 64 * 1024;

async function readBoundedText(response, limit, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} exceeded the bounded response limit`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
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
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${label} returned invalid UTF-8`);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(urlFor(baseUrl, path), options);
  const text = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES, `${options.method ?? "GET"} ${path}`);
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    body,
    bodyKind: text === "" ? "empty" : body === null ? "non_json" : "json",
  };
}

async function requestText(baseUrl, path, options = {}) {
  const response = await fetch(urlFor(baseUrl, path), options);
  const text = await readBoundedText(response, MAX_DOCUMENT_RESPONSE_BYTES, `${options.method ?? "GET"} ${path}`);
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") ?? "",
    text: text.slice(0, 512),
  };
}

function assertEnvelope(response, code, label) {
  if (!response.ok || response.body?.ok !== true || response.body?.code !== code) {
    throw new Error(`${label} failed: status=${response.status}; response_ok=${response.ok}; envelope_ok=${response.body?.ok === true}; code_matches=${response.body?.code === code}`);
  }
  return response.body;
}

function assertRejected(response, label) {
  if (response.status >= 200 && response.status < 300) {
    throw new Error(`${label} unexpectedly succeeded: status=${response.status}`);
  }
}

function entitlementPayload(options) {
  return {
    project: options.project,
    feature: options.feature,
    license_fingerprint: options.fingerprint,
    status: "active",
    assertion_ttl_seconds: 120,
    customer_id: "access-validator",
    license_id: `access-validator-${randomUUID().slice(0, 8)}`,
    notes: "Cloudflare Access staging validation scratch row",
  };
}

async function runAccessAdminValidation(options) {
  const unauthenticated = await requestJson(options.baseUrl, "/api/admin/summary");
  assertRejected(unauthenticated, "unauthenticated admin summary");

  const malformed = await requestJson(options.baseUrl, "/api/admin/summary", {
    headers: accessHeaders("not-a-jwt"),
  });
  assertRejected(malformed, "malformed Access JWT");

  let nonAdmin = null;
  if (typeof options.nonAdminAccessJwt === "string" && options.nonAdminAccessJwt !== "") {
    nonAdmin = await requestJson(options.baseUrl, "/api/admin/entitlements", {
      method: "POST",
      headers: accessHeaders(options.nonAdminAccessJwt),
      body: JSON.stringify(entitlementPayload(options)),
    });
    assertRejected(nonAdmin, "non-admin Access JWT mutation");
  }

  const authenticatedHeaders = accessHeaders(options.accessJwt);
  const ui = await requestText(options.baseUrl, "/", { headers: authenticatedHeaders });
  if (!ui.ok || !/^text\/html(?:;|$)/iu.test(ui.contentType) || !/<(?:!doctype\s+html|html)\b/iu.test(ui.text)) {
    throw new Error(`authenticated admin UI failed: ${JSON.stringify({ status: ui.status, content_type: ui.contentType })}`);
  }

  const summary = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/summary", {
    headers: authenticatedHeaders,
  }), "summary", "Access JWT summary");

  const baseResult = {
    ok: true,
    summary_code: summary.code,
    ui_status: ui.status,
    ui_content_type: ui.contentType,
    unauthenticated_status: unauthenticated.status,
    malformed_status: malformed.status,
  };

  if (options.readOnly === true) {
    return {
      ...baseResult,
      mode: "read_only",
      mutation_performed: false,
      non_admin_status: null,
      created_revocation_seq: null,
      replay_revocation_seq: null,
      revoked_revocation_seq: null,
      final_status: "not_mutated",
    };
  }

  const createIdempotency = `access-create-${randomUUID()}`;
  const payload = entitlementPayload(options);
  const create = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/entitlements", {
    method: "POST",
    headers: accessHeaders(options.accessJwt, { "idempotency-key": createIdempotency }),
    body: JSON.stringify(payload),
  }), "entitlement_saved", "Access JWT create");
  const created = create.data;
  if (created?.license_fingerprint !== options.fingerprint || created.status !== "active" || typeof created.id !== "string") {
    throw new Error("create response did not contain the expected scratch-entitlement shape");
  }

  const replay = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/entitlements", {
    method: "POST",
    headers: accessHeaders(options.accessJwt, { "idempotency-key": createIdempotency }),
    body: JSON.stringify(payload),
  }), "entitlement_saved", "Access JWT idempotent replay");
  if (replay.data?.revocation_seq !== created.revocation_seq) {
    throw new Error("idempotent replay advanced revocation_seq");
  }

  const detail = assertEnvelope(await requestJson(options.baseUrl, `/api/admin/entitlements/${created.id}`, {
    headers: accessHeaders(options.accessJwt),
  }), "entitlement", "Access JWT detail");
  if (detail.data?.license_fingerprint !== options.fingerprint) {
    throw new Error("detail response did not return the expected scratch entitlement");
  }

  const revoke = assertEnvelope(await requestJson(options.baseUrl, `/api/admin/entitlements/${created.id}/revoke`, {
    method: "POST",
    headers: accessHeaders(options.accessJwt, { "idempotency-key": `access-revoke-${randomUUID()}` }),
    body: JSON.stringify({ reason: "access validation cleanup" }),
  }), "entitlement_revoked", "Access JWT revoke cleanup");
  if (revoke.data?.status !== "revoked" || revoke.data.revocation_seq <= created.revocation_seq) {
    throw new Error("revoke cleanup did not advance the scratch entitlement to revoked");
  }

  const reactivate = await requestJson(options.baseUrl, `/api/admin/entitlements/${created.id}/reenable`, {
    method: "POST",
    headers: accessHeaders(options.accessJwt, { "idempotency-key": `access-reactivate-${randomUUID()}` }),
    body: JSON.stringify({ reason: "terminal-state validation" }),
  });
  if (reactivate.status !== 409 || reactivate.body?.code !== "revoked_entitlement_is_terminal") {
    throw new Error(`revoked terminal check failed: status=${reactivate.status}; code_matches=${reactivate.body?.code === "revoked_entitlement_is_terminal"}`);
  }

  return {
    ...baseResult,
    mode: "mutation_drill",
    mutation_performed: true,
    created_revocation_seq: created.revocation_seq,
    replay_revocation_seq: replay.data.revocation_seq,
    revoked_revocation_seq: revoke.data.revocation_seq,
    non_admin_status: nonAdmin?.status ?? null,
    final_status: "revoked",
  };
}

async function main() {
  const options = validateOptions(parseArgs(process.argv));
  const summary = await runAccessAdminValidation(options);
  console.log(JSON.stringify(summary, null, 2));
}

export {
  accessHeaders,
  entitlementPayload,
  parseArgs,
  requestJson,
  runAccessAdminValidation,
  validateOptions,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
