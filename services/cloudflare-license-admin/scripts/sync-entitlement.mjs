import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const STATUS = new Set(["active", "disabled", "revoked"]);

function usage() {
  console.error(`usage:
  node scripts/sync-entitlement.mjs --url <admin-worker-url> --fingerprint <64-hex> [--token <secret>] [--project DEFAULT] [--feature DEFAULT] [--device-hash <64-hex>] [--status active] [--assertion-ttl 300] [--valid-from <epoch>] [--valid-until <epoch>] [--customer-id <id>] [--license-id <id>] [--reason <text>] [--idempotency-key <key>]

Token defaults to the LICENSECC_SYNC_TOKEN environment variable.`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; ++i) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      usage();
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) {
      usage();
    }
    options[key] = value;
  }
  return options;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be at most ${maxLength} characters without line breaks`);
  }
  return value;
}

function validatedHex(value, label, required = true) {
  if (!required && (value === undefined || value === "")) {
    return "";
  }
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} must be exactly 64 hex characters`);
  }
  return value.toLowerCase();
}

function optionalEpoch(value, label) {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function optionalInt(value, label, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

export function buildSyncPayload(options) {
  const status = options.status ?? "active";
  if (!STATUS.has(status)) {
    throw new Error("status must be active, disabled, or revoked");
  }
  const validFrom = optionalEpoch(options["valid-from"], "valid-from");
  const validUntil = optionalEpoch(options["valid-until"], "valid-until");
  if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
    throw new Error("valid-from must be less than valid-until");
  }
  const payload = {
    project: options.project ?? "DEFAULT",
    feature: options.feature ?? "DEFAULT",
    license_fingerprint: validatedHex(options.fingerprint, "fingerprint"),
    device_hash: validatedHex(options["device-hash"], "device-hash", false),
    status,
    assertion_ttl_seconds: optionalInt(options["assertion-ttl"], "assertion-ttl", 300, 1, 3600),
    valid_from: validFrom,
    valid_until: validUntil,
    customer_id: optionalString(options["customer-id"], "customer-id", 128) ?? null,
    license_id: optionalString(options["license-id"], "license-id", 128) ?? null,
    notes: optionalString(options.notes, "notes", 1000) ?? "",
    reason: optionalString(options.reason, "reason", 1000) ?? "",
  };
  if ((status === "disabled" || status === "revoked") && payload.reason === "") {
    throw new Error("reason is required for disabled or revoked sync payloads");
  }
  return payload;
}

async function main() {
  const options = parseArgs(process.argv);
  const baseUrl = requiredString(options.url, "url");
  const token = options.token ?? process.env.LICENSECC_SYNC_TOKEN;
  if (typeof token !== "string" || token === "") {
    throw new Error("token is required through --token or LICENSECC_SYNC_TOKEN");
  }
  const payload = buildSyncPayload(options);
  const response = await fetch(new URL("/api/sync/entitlements", baseUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": options["idempotency-key"] ?? randomUUID(),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  console.log(body);
  if (!response.ok) {
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
