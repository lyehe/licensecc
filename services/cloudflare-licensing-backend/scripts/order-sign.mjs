#!/usr/bin/env node
// order-sign.mjs — offline HMAC signer for the order-ingest endpoint (POST /v1/orders).
//
// Produces the three request headers (X-LCC-Key-Id / X-LCC-Timestamp / X-LCC-Signature)
// the operator's commerce/CRM must send. It signs over the SAME canonical bytes the
// Worker verifies (imported from src/fulfillment/order_hmac.mjs, so the framing can
// never drift) using HMAC-SHA256 with the shared secret.
//
// Usage:
//   node scripts/order-sign.mjs --key-id k1 --secret-b64 <b64-secret> \
//     --audience prod --body order.json [--timestamp 1750000000] [--url https://host/v1/orders]
//   echo '{"event_id":"e1",...}' | node scripts/order-sign.mjs --key-id k1 --secret-b64 ... --audience prod
//
// The secret is base64 of >= 32 raw bytes (matches the Worker's ORDER_HMAC_SECRETS map
// value). Output: the three headers, plus a ready-to-run curl when --url is given.
//
// Design: docs/superpowers/plans/2026-06-24-slice1-order-ingest-blueprint.md

import { readFileSync } from "node:fs";
import { canonicalOrderSignedText } from "../src/fulfillment/order_hmac.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(
      "order-sign — sign an order body for POST /v1/orders\n" +
        "  --key-id <id> --secret-b64 <b64> --audience <aud> [--body <file> | stdin] [--timestamp <unix>] [--url <endpoint>]\n",
    );
    return;
  }
  const body =
    typeof args.body === "string"
      ? readFileSync(args.body, "utf8")
      : readFileSync(0, "utf8"); // stdin
  const signed = await signOrder({
    keyId: args["key-id"],
    secretB64: args["secret-b64"],
    audience: args.audience,
    body,
    timestamp: args.timestamp,
  });
  process.stdout.write("# headers\n");
  for (const [name, value] of Object.entries(signed.headers)) {
    process.stdout.write(`${name}: ${value}\n`);
  }
  if (typeof args.url === "string") {
    process.stdout.write("\n# curl\n");
    const h = signed.headers;
    process.stdout.write(
      `curl -sS -X POST ${args.url} \\\n` +
        `  -H 'Content-Type: application/json' \\\n` +
        `  -H 'X-LCC-Key-Id: ${h["X-LCC-Key-Id"]}' \\\n` +
        `  -H 'X-LCC-Timestamp: ${h["X-LCC-Timestamp"]}' \\\n` +
        `  -H 'X-LCC-Signature: ${h["X-LCC-Signature"]}' \\\n` +
        `  --data-binary @${typeof args.body === "string" ? args.body : "-"}\n`,
    );
  }
}

// Run as CLI only when invoked directly (not when imported by the round-trip test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("order-sign.mjs")) {
  main().catch((err) => {
    process.stderr.write(`order-sign: ${err.message}\n`);
    process.exit(1);
  });
}
