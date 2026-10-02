#!/usr/bin/env node
// order-sign.mjs — offline HMAC signer for the order-ingest endpoint (POST /v1/orders).
//
// Produces the three request headers (X-LCC-Key-Id / X-LCC-Timestamp / X-LCC-Signature)
// the operator's commerce/CRM must send. It signs over the SAME canonical bytes the
// Worker verifies (imported from src/fulfillment/order_hmac.mjs, so the framing can
// never drift) using HMAC-SHA256 with the shared secret.
//
// Usage:
//   ORDER_SIGNING_SECRET_B64=<b64-secret> node scripts/order-sign.mjs --key-id k1 \
//     --audience prod --body order.json [--timestamp 1750000000] [--url https://host/v1/orders]
//   node scripts/order-sign.mjs --key-id k1 --audience prod --secret-file signing.secret < order.json
//
// The secret is base64 of >= 32 raw bytes (matches the Worker's ORDER_HMAC_SECRETS map
// value). It is read from the ORDER_SIGNING_SECRET_B64 environment variable or from the
// file named by --secret-file, never from the command line, where it would land in shell
// history and the process list. Without --body the order is read from piped standard
// input; a terminal on standard input gets the usage instead of a silent wait.
// Output: the three headers, plus a ready-to-run curl when --url is given.
//
// Design: docs/superpowers/plans/2026-06-24-slice1-order-ingest-blueprint.md

import { readFileSync } from "node:fs";
import { canonicalOrderSignedText } from "../src/fulfillment/order_hmac.mjs";

const SECRET_ENV = "ORDER_SIGNING_SECRET_B64";
const VALUE_OPTIONS = new Set(["key-id", "audience", "body", "timestamp", "url", "secret-file"]);
const USAGE =
  "usage: order-sign --key-id <id> --audience <aud> [--body <file>] [--timestamp <unix>] [--url <endpoint>] [--secret-file <path>]\n" +
  "  Signs an order body for POST /v1/orders.\n" +
  `  The base64 HMAC secret comes from ${SECRET_ENV} or from the file named by --secret-file, not both.\n` +
  "  Without --body the order is read from standard input, which must be piped, not a terminal.\n";

class UsageError extends Error {}

/** Parse argv strictly: only the known options, each value option exactly once and with a value. */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    // Name only the option, never its value: a refused value may be a secret.
    if (name === null) throw new UsageError(`unexpected argument at position ${i + 1}`);
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option --${name}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`--${name} is given more than once`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    options[name] = value;
    i += 1;
  }
  return options;
}

function readSecret(options, env, readFile) {
  const fromEnv = env[SECRET_ENV];
  const hasEnv = typeof fromEnv === "string" && fromEnv.trim() !== "";
  const file = options["secret-file"];
  if (hasEnv && file !== undefined) throw new UsageError(`set ${SECRET_ENV} or pass --secret-file, not both`);
  if (file !== undefined) return readFile(file).trim();
  if (hasEnv) return fromEnv.trim();
  throw new UsageError(`no signing secret: set ${SECRET_ENV} or pass --secret-file <path>`);
}

/**
 * Sign an order body. Returns { headers, signature, signedText, timestamp }.
 * Uses Web Crypto HMAC (the same primitive the Worker verifies with) over the shared
 * canonical bytes so a round-trip against verifyOrderHmac is guaranteed to agree.
 */
export async function signOrder({ keyId, secretB64, audience, body, timestamp }) {
  if (!keyId || !secretB64 || !audience) {
    throw new Error("signOrder requires keyId, secretB64, audience");
  }
  const ts = timestamp === undefined ? Math.floor(Date.now() / 1000) : Number(timestamp);
  if (!Number.isInteger(ts) || ts < 0) {
    throw new Error("timestamp must be a non-negative integer (unix seconds)");
  }
  const secretBytes = Uint8Array.from(Buffer.from(secretB64, "base64"));
  if (secretBytes.length < 32) {
    throw new Error("secret must decode to >= 32 bytes");
  }
  const signedText = canonicalOrderSignedText(audience, String(ts), body);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedText));
  const signature = Buffer.from(new Uint8Array(sig)).toString("base64");
  return {
    timestamp: ts,
    signature,
    signedText,
    headers: {
      "X-LCC-Key-Id": keyId,
      "X-LCC-Timestamp": String(ts),
      "X-LCC-Signature": signature,
    },
  };
}

/**
 * The CLI, with its process surfaces injected: `env`, `stdinIsTTY`, `readStdin()`,
 * `readFile(path)`, `writeOut(text)` and `writeErr(text)`. Resolves to the exit status:
 * 0 when signed, 2 for a usage error (the usage is printed), 1 for any other failure.
 */
export async function runOrderSign(argv, io) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      io.writeOut(USAGE);
      return 0;
    }
    if (options["key-id"] === undefined || options.audience === undefined) {
      throw new UsageError("--key-id and --audience are required");
    }
    if (options.body === undefined && io.stdinIsTTY) {
      throw new UsageError("no order body: pass --body <file> or pipe the order on standard input");
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.writeErr(`order-sign: ${error.message}\n${USAGE}`);
    return 2;
  }

  let signed;
  try {
    const secretB64 = readSecret(options, io.env, io.readFile);
    const body = options.body === undefined ? io.readStdin() : io.readFile(options.body);
    signed = await signOrder({
      keyId: options["key-id"],
      secretB64,
      audience: options.audience,
      body,
      timestamp: options.timestamp,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      io.writeErr(`order-sign: ${error.message}\n${USAGE}`);
      return 2;
    }
    io.writeErr(`order-sign: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let out = "# headers\n";
  for (const [name, value] of Object.entries(signed.headers)) {
    out += `${name}: ${value}\n`;
  }
  if (options.url !== undefined) {
    const h = signed.headers;
    out +=
      "\n# curl\n" +
      `curl -sS -X POST ${options.url} \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -H 'X-LCC-Key-Id: ${h["X-LCC-Key-Id"]}' \\\n` +
      `  -H 'X-LCC-Timestamp: ${h["X-LCC-Timestamp"]}' \\\n` +
      `  -H 'X-LCC-Signature: ${h["X-LCC-Signature"]}' \\\n` +
      `  --data-binary @${options.body ?? "-"}\n`;
  }
  io.writeOut(out);
  return 0;
}

// Run as CLI only when invoked directly (not when imported by the round-trip test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("order-sign.mjs")) {
  runOrderSign(process.argv.slice(2), {
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: () => readFileSync(0, "utf8"),
    readFile: (path) => readFileSync(path, "utf8"),
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  }).then(
    (status) => {
      process.exitCode = status;
    },
    (err) => {
      process.stderr.write(`order-sign: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
