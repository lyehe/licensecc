// Round-trip: the offline order signer (scripts/order-sign.mjs) and the in-Worker
// verifier (src/fulfillment/order_hmac.mjs) MUST agree on the canonical bytes. They
// share canonicalOrderSignedText, so this proves the framing/HMAC compose end to end
// and guards against signer<->verifier drift (the classic webhook-auth bug).
//
// The CLI half: the secret never travels on the command line (where it would land in shell
// history and the process list), and a missing --body never leaves the CLI waiting on a terminal.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as orderSign from "../../scripts/order-sign.mjs";
import { verifyOrderHmac } from "../../src/fulfillment/order_hmac.mjs";

const { signOrder } = orderSign;
const SCRIPT = fileURLToPath(new URL("../../scripts/order-sign.mjs", import.meta.url));

const AUDIENCE = "prod";
const KEY_ID = "k1";

function freshSecretB64() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

function requestFrom(headers, body) {
  return new Request("https://verifier.example/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function envFor(secretB64) {
  return {
    ORDER_HMAC_SECRETS: JSON.stringify({ [KEY_ID]: secretB64 }),
    ORDER_INGEST_AUDIENCE: AUDIENCE,
  };
}

test("a freshly signed order verifies", async () => {
  const secretB64 = freshSecretB64();
  const body = JSON.stringify({ event_id: "e1", subscription_id: "sub_A", seq: 1, intent: "subscription.active" });
  const signed = await signOrder({ keyId: KEY_ID, secretB64, audience: AUDIENCE, body, timestamp: Math.floor(Date.now() / 1000) });
  const res = await verifyOrderHmac(requestFrom(signed.headers, body), envFor(secretB64), body);
  assert.equal(res.ok, true);
  assert.equal(res.code, "ok");
  assert.equal(res.keyId, KEY_ID);
});

test("a tampered body fails the signature", async () => {
  const secretB64 = freshSecretB64();
  const body = JSON.stringify({ event_id: "e1", subscription_id: "sub_A", seq: 1, intent: "subscription.active" });
  const signed = await signOrder({ keyId: KEY_ID, secretB64, audience: AUDIENCE, body, timestamp: Math.floor(Date.now() / 1000) });
  const tampered = body.replace("sub_A", "sub_B");
  const res = await verifyOrderHmac(requestFrom(signed.headers, tampered), envFor(secretB64), tampered);
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_signature");
});

test("a signature for a different audience does not verify against prod", async () => {
  const secretB64 = freshSecretB64();
  const body = JSON.stringify({ event_id: "e1" });
  const signed = await signOrder({ keyId: KEY_ID, secretB64, audience: "staging", body, timestamp: Math.floor(Date.now() / 1000) });
  const res = await verifyOrderHmac(requestFrom(signed.headers, body), envFor(secretB64), body);
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_signature");
});

test("signOrder rejects a too-short secret", async () => {
  await assert.rejects(
    () => signOrder({ keyId: KEY_ID, secretB64: Buffer.from("short").toString("base64"), audience: AUDIENCE, body: "{}" }),
    />= 32 bytes/,
  );
});

// --- CLI ------------------------------------------------------------------------------------------

const ORDER_BODY = JSON.stringify({ event_id: "e1", subscription_id: "sub_A", seq: 1, intent: "subscription.active" });

function cliEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!Object.hasOwn(extra, "ORDER_SIGNING_SECRET_B64")) delete env.ORDER_SIGNING_SECRET_B64;
  return env;
}

function runCli(args, { env = {}, input } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: cliEnvironment(env), input, encoding: "utf8", timeout: 30_000 });
}

function withTempDir(action) {
  const dir = mkdtempSync(join(tmpdir(), "order-sign-"));
  try {
    return action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printedHeaders(stdout) {
  const headers = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(X-LCC-[A-Za-z-]+): (.+)$/u.exec(line);
    if (match !== null) headers[match[1]] = match[2];
  }
  return headers;
}

async function assertVerifies(stdout, secretB64, body) {
  const headers = printedHeaders(stdout);
  assert.equal(headers["X-LCC-Key-Id"], KEY_ID);
  const res = await verifyOrderHmac(requestFrom(headers, body), envFor(secretB64), body);
  assert.equal(res.ok, true, stdout);
}

test("the CLI signs with the secret from ORDER_SIGNING_SECRET_B64", async () => {
  const secretB64 = freshSecretB64();
  const result = withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    writeFileSync(bodyPath, ORDER_BODY);
    return runCli(["--key-id", KEY_ID, "--audience", AUDIENCE, "--body", bodyPath], { env: { ORDER_SIGNING_SECRET_B64: secretB64 } });
  });
  assert.equal(result.status, 0, result.stderr);
  await assertVerifies(result.stdout, secretB64, ORDER_BODY);
});

test("the CLI signs with the secret read from --secret-file", async () => {
  const secretB64 = freshSecretB64();
  const result = withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    const secretPath = join(dir, "order-signing.secret");
    writeFileSync(bodyPath, ORDER_BODY);
    writeFileSync(secretPath, `${secretB64}\n`);
    return runCli(["--key-id", KEY_ID, "--audience", AUDIENCE, "--body", bodyPath, "--secret-file", secretPath]);
  });
  assert.equal(result.status, 0, result.stderr);
  await assertVerifies(result.stdout, secretB64, ORDER_BODY);
});

test("--secret-b64 is an unknown option: nothing is signed and the value is not echoed", () => {
  const secretB64 = freshSecretB64();
  const result = withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    writeFileSync(bodyPath, ORDER_BODY);
    return runCli(["--key-id", KEY_ID, "--secret-b64", secretB64, "--audience", AUDIENCE, "--body", bodyPath]);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option --secret-b64/u);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes(secretB64), "the refused value is never printed");
});

test("the CLI refuses a secret given both ways, and asks for one when none is given", () => {
  const secretB64 = freshSecretB64();
  withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    const secretPath = join(dir, "order-signing.secret");
    writeFileSync(bodyPath, ORDER_BODY);
    writeFileSync(secretPath, secretB64);
    const both = runCli(["--key-id", KEY_ID, "--audience", AUDIENCE, "--body", bodyPath, "--secret-file", secretPath], { env: { ORDER_SIGNING_SECRET_B64: secretB64 } });
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /not both/u);
    assert.equal(both.stdout, "");

    const neither = runCli(["--key-id", KEY_ID, "--audience", AUDIENCE, "--body", bodyPath]);
    assert.notEqual(neither.status, 0);
    assert.match(neither.stderr, /ORDER_SIGNING_SECRET_B64/u);
    assert.match(neither.stderr, /--secret-file/u);
    assert.equal(neither.stdout, "");
  });
});

test("without --body the CLI signs an order piped on standard input", async () => {
  const secretB64 = freshSecretB64();
  const result = runCli(["--key-id", KEY_ID, "--audience", AUDIENCE], { env: { ORDER_SIGNING_SECRET_B64: secretB64 }, input: ORDER_BODY });
  assert.equal(result.status, 0, result.stderr);
  await assertVerifies(result.stdout, secretB64, ORDER_BODY);
});

test("without --body and with a terminal on standard input, the CLI prints its usage and exits non-zero instead of waiting", async () => {
  assert.equal(typeof orderSign.runOrderSign, "function", "order-sign.mjs exports runOrderSign for its CLI");
  const out = [];
  const err = [];
  const status = await orderSign.runOrderSign(["--key-id", KEY_ID, "--audience", AUDIENCE], {
    env: { ORDER_SIGNING_SECRET_B64: freshSecretB64() },
    stdinIsTTY: true,
    readStdin: () => assert.fail("standard input is never read from a terminal"),
    readFile: () => assert.fail("no file is named"),
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  });
  assert.notEqual(status, 0);
  assert.deepEqual(out, []);
  assert.match(err.join(""), /--body/u);
  assert.match(err.join(""), /usage/iu);
});

test("--secret-b64=<value> is refused by name only: the value after = is never echoed", () => {
  const secretB64 = freshSecretB64();
  const result = withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    writeFileSync(bodyPath, ORDER_BODY);
    return runCli(["--key-id", KEY_ID, `--secret-b64=${secretB64}`, "--audience", AUDIENCE, "--body", bodyPath]);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option --secret-b64\n/u);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes(secretB64), "the refused value is never printed");
  assert.ok(!result.stderr.includes("--secret-b64="), "not even the = form of the refused argument is printed");
});

test("value options also take the --name=value form", async () => {
  const secretB64 = freshSecretB64();
  const result = withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    const secretPath = join(dir, "order-signing.secret");
    writeFileSync(bodyPath, ORDER_BODY);
    writeFileSync(secretPath, secretB64);
    return runCli([`--key-id=${KEY_ID}`, `--audience=${AUDIENCE}`, `--body=${bodyPath}`, `--secret-file=${secretPath}`]);
  });
  assert.equal(result.status, 0, result.stderr);
  await assertVerifies(result.stdout, secretB64, ORDER_BODY);
});

test("an empty secret file is reported as empty", () => {
  const result = withTempDir((dir) => {
    const bodyPath = join(dir, "order.json");
    const secretPath = join(dir, "order-signing.secret");
    writeFileSync(bodyPath, ORDER_BODY);
    writeFileSync(secretPath, " \n");
    return runCli(["--key-id", KEY_ID, "--audience", AUDIENCE, "--body", bodyPath, "--secret-file", secretPath]);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret file is empty/u);
  assert.equal(result.stdout, "");
});
