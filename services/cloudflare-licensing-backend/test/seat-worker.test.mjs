// HTTP-level tests for the floating Worker (/v1/checkout, /v1/heartbeat, /v1/release).
// The seat token is an lccoa1 online assertion (the same one /v1/verify mints and the C++
// online_verification validates); here we confirm it is correctly signed, plus the pool /
// borrow / reclaim / auth behaviors. The faithful atomic seat-pool cap is verified against
// real SQLite in test/sql/seat-pool.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createPublicKey, verify as nodeVerify } from "node:crypto";
import worker, { resetSigningKeyCacheForTests } from "../dist/index.js";

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

const { publicKey: spkiDer, privateKey: pkcs8Der } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
const ONLINE_PEM = bytesToPem(new Uint8Array(pkcs8Der), "PRIVATE KEY");
const ONLINE_PUBLIC = createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" });

function makeEnv(state, overrides = {}) {
  return {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: ONLINE_PEM,
    ONLINE_SIGNING_KEY_ID: "sha256:" + "0".repeat(64),
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                // Match ONLY the lookupSeatEntitlement SELECT — not the `FROM entitlements e` EXISTS
                // that the T7-hardened heartbeat/checkout statements now embed (those must fall through
                // to the UPDATE/INSERT branches below).
                if (sql.startsWith("SELECT status, valid_from, valid_until")) return state.entitlement ?? null;
                if (sql.startsWith("INSERT INTO seat_checkouts")) {
                  state.checkoutAttempts = (state.checkoutAttempts ?? 0) + 1;
                  // bind order: project, feature, fingerprint, seatId, instance, mode, now, deadline
                  state.insertedMode = args[5];
                  state.insertedDeadline = args[7];
                  return state.seatGranted === false ? null : { seat_id: args[3] };
                }
                if (sql.startsWith("UPDATE seat_checkouts")) {
                  return state.heartbeatFound === false ? null : { seat_id: args[4] };
                }
                if (sql.startsWith("DELETE FROM seat_checkouts WHERE project")) {
                  // release: DELETE ... RETURNING seat_id (removed iff a row existed)
                  state.released = true;
                  return state.releaseRemoved === false ? null : { seat_id: args[3] };
                }
                return null;
              },
              async all() {
                // checkout's lapsed-seat sweep: DELETE ... heartbeat_deadline < now ... RETURNING
                return { results: state.swept ?? [] };
              },
              async run() {
                if (sql.startsWith("INSERT INTO usage_events")) {
                  // bind: project, feature, fingerprint, event_type, seat_id, device_key_id, reason, ts
                  state.usageEvents = state.usageEvents ?? [];
                  state.usageEvents.push({ event_type: args[3], seat_id: args[4], ts: args[7] });
                }
                return {};
              },
            };
          },
        };
      },
    },
    ...overrides,
  };
}

function seatEntitlement(overrides = {}) {
  return {
    status: "active",
    valid_from: null,
    valid_until: null,
    pool_size: 2,
    heartbeat_grace_sec: 900,
    max_borrow_sec: 0,
    allow_overdraft: 0,
    revocation_seq: 0,
    ...overrides,
  };
}

function req(path, body, headers = {}) {
  return new Request(`https://verifier.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function checkoutBody(overrides = {}) {
  return {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    client_instance_id: "instance-1",
    nonce: "b".repeat(64),
    ...overrides,
  };
}

function assertSignedAssertion(assertion) {
  const parts = assertion.split(".");
  assert.equal(parts[0], "lccoa1");
  const payload = Buffer.from(parts[1], "base64");
  const sig = Buffer.from(parts[2], "base64");
  assert.ok(nodeVerify("RSA-SHA256", payload, ONLINE_PUBLIC, sig), "seat lccoa1 verifies under the online key");
}

test("checkout grants a seat with a verifiable lccoa1 token", async () => {
  resetSigningKeyCacheForTests();
  const res = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv({ entitlement: seatEntitlement() }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.mode, "live");
  assert.ok(out.seat_id && typeof out.seat_id === "string");
  assert.ok(out.expires_at > out.server_time);
  assert.ok(out.heartbeat_in >= 1 && out.heartbeat_in < out.expires_at - out.server_time);
  assertSignedAssertion(out.assertion);
});

test("checkout returns 409 pool_exhausted when the atomic cap lands no row", async () => {
  const res = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv({ entitlement: seatEntitlement(), seatGranted: false }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "pool_exhausted");
});

test("checkout 403 floating_disabled when pool_size is 0", async () => {
  const res = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv({ entitlement: seatEntitlement({ pool_size: 0 }) }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "floating_disabled");
});

test("checkout 403 no_active_entitlement when missing or inactive", async () => {
  const missing = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv({ entitlement: null }));
  assert.equal(missing.status, 403);
  const revoked = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv({ entitlement: seatEntitlement({ status: "revoked" }) }));
  assert.equal((await revoked.json()).code, "no_active_entitlement");
});

test("borrow is bounded by max_borrow_sec and gated by it", async () => {
  resetSigningKeyCacheForTests();
  // Disabled by default.
  const disabled = await worker.fetch(req("/v1/checkout", checkoutBody({ borrow_seconds: 1000 })), makeEnv({ entitlement: seatEntitlement() }));
  assert.equal((await disabled.json()).code, "borrowing_disabled");

  // Enabled but the request exceeds the max: clamp to max_borrow_sec.
  const env = makeEnv({ entitlement: seatEntitlement({ max_borrow_sec: 500 }) });
  const res = await worker.fetch(req("/v1/checkout", checkoutBody({ borrow_seconds: 100000 })), env);
  const out = await res.json();
  assert.equal(out.mode, "borrowed");
  assert.equal(out.expires_at - out.server_time, 500, "borrow clamped to max_borrow_sec");
});

test("heartbeat refreshes a live seat, and returns 410 once reclaimed", async () => {
  resetSigningKeyCacheForTests();
  const ok = await worker.fetch(
    req("/v1/heartbeat", checkoutBody({ seat_id: "seat-1" })),
    makeEnv({ entitlement: seatEntitlement(), heartbeatFound: true }),
  );
  assert.equal(ok.status, 200);
  assertSignedAssertion((await ok.json()).assertion);

  const reclaimed = await worker.fetch(
    req("/v1/heartbeat", checkoutBody({ seat_id: "seat-1" })),
    makeEnv({ entitlement: seatEntitlement(), heartbeatFound: false }),
  );
  assert.equal(reclaimed.status, 410);
  assert.equal((await reclaimed.json()).code, "seat_reclaimed");
});

// T7 revocation SLA — the signed seat token's offline deadline must never outlive the entitlement
// window. A borrowed seat needs no heartbeat to deny it, so an unclamped max_borrow_sec would grant
// offline access PAST valid_until; the clamp is the bound.
test("borrow checkout clamps the seat deadline to valid_until (offline access cannot outlive expiry)", async () => {
  resetSigningKeyCacheForTests();
  const now = Math.floor(Date.now() / 1000);
  const validUntil = now + 100;
  const state = {
    entitlement: seatEntitlement({ pool_size: 1, max_borrow_sec: 86400, valid_until: validUntil }),
  };
  const res = await worker.fetch(
    req("/v1/checkout", checkoutBody({ borrow_seconds: 86400 })),
    makeEnv(state),
  );
  assert.equal(res.status, 200);
  assert.equal(state.insertedMode, "borrowed");
  // Unclamped this would be now+86400; clamped it is exactly valid_until.
  assert.equal(state.insertedDeadline, validUntil, "borrow deadline clamped to valid_until");
  const body = await res.json();
  assert.ok(body.expires_at <= validUntil, "signed token expiry within the entitlement window");
});

test("live checkout clamps the seat deadline to valid_until when grace would overrun it", async () => {
  resetSigningKeyCacheForTests();
  const now = Math.floor(Date.now() / 1000);
  const validUntil = now + 10; // sooner than the 900s grace
  const state = { entitlement: seatEntitlement({ pool_size: 1, heartbeat_grace_sec: 900, valid_until: validUntil }) };
  const res = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv(state));
  assert.equal(res.status, 200);
  assert.equal(state.insertedMode, "live");
  assert.equal(state.insertedDeadline, validUntil, "live deadline clamped to valid_until");
});

test("release frees the seat (idempotent)", async () => {
  const state = { entitlement: seatEntitlement() };
  const res = await worker.fetch(req("/v1/release", checkoutBody({ seat_id: "seat-1" })), makeEnv(state));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(state.released, true);
});

test("checkout sweeps lapsed seats and records reclaim at the seat's ACTUAL deadline", async () => {
  resetSigningKeyCacheForTests();
  const state = {
    entitlement: seatEntitlement(),
    swept: [
      { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: "a".repeat(64), seat_id: "old", heartbeat_deadline: 5000 },
    ],
  };
  const res = await worker.fetch(req("/v1/checkout", checkoutBody()), makeEnv(state));
  assert.equal(res.status, 200);
  const reclaim = (state.usageEvents ?? []).find((e) => e.event_type === "reclaim");
  assert.ok(reclaim, "a reclaim event was recorded for the swept seat");
  assert.equal(reclaim.seat_id, "old");
  assert.equal(reclaim.ts, 5000, "reclaim ts is the seat's heartbeat_deadline, not the sweep time");
});

test("auth + availability fail closed", async () => {
  const bad = await worker.fetch(
    req("/v1/checkout", checkoutBody(), { authorization: "Bearer wrong" }),
    makeEnv({ entitlement: seatEntitlement() }, { LEASE_ISSUE_BEARER: "secret" }),
  );
  assert.equal(bad.status, 401);

  const unsigned = await worker.fetch(
    req("/v1/checkout", checkoutBody()),
    makeEnv({ entitlement: seatEntitlement() }, { ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: undefined, ONLINE_SIGNING_KEY_ID: undefined }),
  );
  assert.equal(unsigned.status, 503);
});
