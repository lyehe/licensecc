# Security hardening patch — closing the remaining review gaps

Date: 2026-06-17. Branch: `improve/codebase-smells-fixes`.

This is an applyable patch. Each finding gives the **gap**, the **exact change with real code**, the **file it touches**, and **whether that file is WIP** (so you know what merges into your in-flight tree vs what commits clean). A verification section follows.

> **Red-team corrections applied to this revision.** Two changes from the prior draft were **withdrawn** because they break committed tests, and one prose claim was rewritten to match the code. The replay-cache work (Finding 1) is unchanged: it remains fail-closed and atomic. Specifically:
> - **Withdrawn — Finding 2b (no-never-expires for config tokens).** Rejecting `expires_at == 0` in `ConfigAttestation.cpp::validate_claims` breaks the SUCCESS-path test `verify_config_allows_valid_token_and_denies_tamper`, because its token is built by the **shared** helper `config_token_for()` (`test/library/config_public_api_test.cpp:124-143`), which sets `c.issued_at = 0; c.expires_at = 0;` at lines 138-139. That token is built at line 158 and the test asserts `LICENSE_OK` + `LCC_LICENSE_DECISION_ALLOW` at lines 174-175. Under the proposed change it would fail with `ConfigVerifyFailure::Expired`. This is a real regression in a committed test, so the no-never-expires change is **not** in this patch. (Note: the never-expiring config token remains a genuine parity gap with the online protocol; closing it now requires first giving that shared helper a real future `expires_at`, which touches multiple config tests and is therefore deferred to its own change — see "Deferred" below.)
> - **Withdrawn — Finding 4 (v200 legacy key floor 3072).** Setting `policy.min_public_key_bits = 3072` in `legacy_v200_signature_policy()` breaks at least five committed `signature_verifier_test.cpp` cases that build requests with this exact policy (via `legacy_request()`, lines 46-56) using **2048-bit** RSA keys and assert `FUNC_RET_OK` / `signature_request_allowed == true`: `verify_signature_policy_handles_payload_edge_cases` (genKey 2048 at line 435, OK at 449), `verify_signature_policy_rejects_alternate_payload_spelling` (2048 at 459, OK at 467), `verify_signature_policy_rejects_duplicate_and_retired_key_ids` (2048 at 522, OK at 527), `verify_signature_policy_selects_public_key_by_key_id` (2048 ring entries 564-567, `signature_request_allowed == true` at 569 and `FUNC_RET_OK` at 570), and `verify_signature_policy_rejects_duplicate_public_key_ring_entries` (2048 at 580). The 3072 floor is enforced both at ring level (`signature_public_key_record_allowed` -> `signature_verifier.hpp:391`) and at selected-key level (`signature_request_allowed`, lines 469-474), so every one of these denies. `test_signature_verifier` is a registered ctest matched by this patch's own `ctest -R 'signature'` command. The v200 floor is therefore **not** in this patch.
> - **Rewritten — Finding 1d prose.** The earlier draft claimed the bare-`device_hash` change "tightens" binding so a request-controlled `device_hash` "must not independently satisfy" a device-bound entitlement. The code only **adds** an OR clause (`proofVerified && mode === "required"`); it does **not** remove `row.device_hash === "" || row.device_hash === verifyRequest.device_hash`. So the change strictly **loosens** the accept condition — it never tightens. The prose below is corrected to state exactly that, with no overclaim. (The unchanged no-device branch `row.device_hash === ""` keeps no-device entitlements passing — no regression there.)

WIP files (you apply these into your WIP and review them there):
- `services/cloudflare-licensing-backend/src/index.ts`
- `services/cloudflare-licensing-backend/schema.sql`
- `include/licensecc/licensecc.h`

Commits-clean files (committed policy, change directly):
- `src/library/config_attestation/ConfigAttestation.cpp` (Finding 2a only)

Note on directory: the live, modified service is `services/cloudflare-licensing-backend/` (the prompt's `licensecc.h` / `schema.sql` / `src/index.ts` WIP set). The older `cloudflare-online-verifier/` is a stale sibling — do not edit it.

---

## Finding 1 — RELAY-RESISTANCE (HIGH): request proof is replayable; add a fail-closed nonce store

### Gap
`evaluateRequestProof` (src/index.ts:696-770) ECDSA-verifies a device-signed request proof that binds `project/feature/license-fingerprint/device-hash/nonce/request-timestamp/device-key-id`, but the server **never records the consumed nonce**. Any captured valid request body replays inside the skew window (default 300s, `REQUEST_SIGNATURE_MAX_SKEW_SECONDS`, src/index.ts:710). There is no `verify_nonces` / jti / replay table in `schema.sql` or any migration. This is the Phase-3 acceptance gap the relay plan itself flags (`2026-06-12-relay-resistant-licensing-ux-implementation-plan.md`, lines 200/215/356).

The replay store models the existing `rate_limit_counters` TTL pattern (schema.sql:128-139; cleanup at src/index.ts:309-311): PK on the replay identity, `expires_at = consumed + skew`, opportunistic `DELETE ... WHERE expires_at < ?`.

### 1a. Migration — new table (lands now; commits clean as a new file)

**New file (commits clean):** `services/cloudflare-licensing-backend/migrations/0009_create_request_proof_nonces.sql`

```sql
-- Replay defense for device request-proofs. One row per consumed
-- (project, feature, license_fingerprint, device_key_id, nonce). A row's presence
-- means that nonce was already spent for that device within the skew window, so a
-- replay of the same signed request body must be denied. Rows are short-lived:
-- expires_at = consumed_at + skew window, swept opportunistically (mirrors
-- rate_limit_counters in migration 0002).
CREATE TABLE IF NOT EXISTS request_proof_nonces (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, device_key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_request_proof_nonces_expires_at
  ON request_proof_nonces(expires_at);
```

### 1b. Snapshot — keep schema parity (WIP file: schema.sql)

**File (WIP):** `services/cloudflare-licensing-backend/schema.sql` — append after the `rate_limit_counters` block (after line 139). `check-schema-parity.py` rebuilds an in-memory DB from migrations and from the snapshot and asserts the normalized objects are equal, so the snapshot MUST contain the identical table + index.

```sql

CREATE TABLE IF NOT EXISTS request_proof_nonces (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, device_key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_request_proof_nonces_expires_at
  ON request_proof_nonces(expires_at);
```

> Postgres parity (`supabase-postgres/schema.pg.sql` + `statements.pg.sql`) — the same table must be mirrored there for the Postgres backend. Lands now alongside 1a/1b (the file already mirrors `entitlement_devices` at line 78 and `rate_limit_counters` at line 196); same DDL, `INTEGER` is fine for the timestamps.

### 1c. Worker — consume-and-check the nonce, fail CLOSED (WIP file: src/index.ts)

**File (WIP):** `services/cloudflare-licensing-backend/src/index.ts`.

The replay check must run **only for an otherwise-valid proof** (after the ECDSA signature, skew, and active-device checks pass) so an attacker cannot burn a victim's nonce with an unsigned request, and it must **fail closed**: any D1 error returns a deny-shaped result, never an allow.

Add a `result` variant to the evaluation union. Edit `RequestProofEvaluation` (src/index.ts:107-121):

```ts
interface RequestProofEvaluation {
  mode: RequestSignatureMode;
  result:
    | "not_configured"
    | "missing"
    | "valid"
    | "stale_timestamp"
    | "unknown_device"
    | "disabled_device"
    | "invalid_signature"
    | "malformed_public_key"
    | "replayed_nonce"
    | "d1_error";
  detail?: string;
  device_key_id?: string;
}
```

Add the atomic consume helper. The `INSERT ... ON CONFLICT DO NOTHING RETURNING nonce` is the race-free primitive: the first request for a `(project, feature, fingerprint, device_key_id, nonce)` gets a row back; a concurrent or later replay gets `null`. The opportunistic sweep mirrors `checkD1RateLimitTier` (src/index.ts:309-311). Insert near `lookupEntitlementDevice` (after src/index.ts:619):

```ts
// Returns "fresh" if this is the first time the nonce is consumed for this device,
// "replayed" if it was already consumed within the skew window, or "error" if the
// store is unavailable. The caller MUST treat "error" as deny (fail closed).
async function consumeRequestProofNonce(
  env: Env,
  request: VerifyRequest,
  proof: RequestProof,
  nowSeconds: number,
  skewSeconds: number,
): Promise<"fresh" | "replayed" | "error"> {
  // A replay can only land inside the accepted skew window on either side of the
  // signed request-timestamp, so keep the row until the window certainly closes.
  const expiresAt = nowSeconds + skewSeconds * 2;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO request_proof_nonces (project, feature, license_fingerprint, device_key_id, nonce, request_timestamp, consumed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, feature, license_fingerprint, device_key_id, nonce) DO NOTHING RETURNING nonce",
    )
      .bind(
        request.project,
        request.feature,
        request.license_fingerprint,
        proof.device_key_id,
        request.nonce,
        proof.request_timestamp,
        nowSeconds,
        expiresAt,
      )
      .first<{ nonce: string }>();
    if (row === null) {
      return "replayed";
    }
    // Opportunistic sweep (mirrors checkD1RateLimitTier). Best-effort; a sweep
    // failure must not turn a fresh nonce into a denial, so swallow it.
    try {
      await env.DB.prepare("DELETE FROM request_proof_nonces WHERE expires_at < ?").bind(nowSeconds).run();
    } catch {
      // ignore: cleanup is not load-bearing for correctness
    }
    return "fresh";
  } catch {
    // Store unavailable: fail closed. Never allow a request we cannot dedupe.
    return "error";
  }
}
```

Wire it into `evaluateRequestProof` at the success branch (src/index.ts:748-769). Replace the existing `try { const valid = ... }` block:

```ts
  let valid: boolean;
  try {
    valid = await verifyRequestSignature(
      device.public_key_spki_der_base64,
      canonicalRequestProofPayload(verifyRequest),
      proof.signature,
    );
  } catch (error) {
    return {
      mode,
      result: "malformed_public_key",
      detail: error instanceof Error ? error.message : "request proof verification failed",
      device_key_id: proof.device_key_id,
    };
  }
  if (!valid) {
    return {
      mode,
      result: "invalid_signature",
      detail: "request proof signature did not verify",
      device_key_id: proof.device_key_id,
    };
  }

  // Signature, skew, and device are good. Now spend the nonce. This is the relay
  // defense: a replay of this exact signed body finds the nonce already consumed.
  const nonceState = await consumeRequestProofNonce(env, verifyRequest, proof, nowSeconds, maxSkewSeconds);
  if (nonceState === "error") {
    // Fail CLOSED: a replay store we cannot reach denies, never allows.
    return {
      mode,
      result: "d1_error",
      detail: "request proof nonce store is unavailable",
      device_key_id: proof.device_key_id,
    };
  }
  if (nonceState === "replayed") {
    return {
      mode,
      result: "replayed_nonce",
      detail: "request proof nonce was already consumed",
      device_key_id: proof.device_key_id,
    };
  }
  return { mode, result: "valid", device_key_id: proof.device_key_id };
```

Note `maxSkewSeconds` is already in scope at src/index.ts:710 — the new call reuses it; do not re-read the env var.

Map the new result to a client failure code. Edit `proofFailureCode` (src/index.ts:646-660) — add `replayed_nonce` to the invalid group:

```ts
    case "unknown_device":
    case "disabled_device":
    case "invalid_signature":
    case "malformed_public_key":
    case "replayed_nonce":
      return "request_proof_invalid";
```

The existing `required`-mode gate already denies anything where `result !== "valid"` (src/index.ts:819) and the existing `d1_error` arm already returns HTTP 500 (src/index.ts:820-822), so the fail-closed `"d1_error"` path needs no new wiring. The severity selector at src/index.ts:815-816 already logs non-valid, non-d1_error results as `warn`, which is correct for `replayed_nonce`.

> **Soft-mode note (by design):** in `soft` mode a replayed nonce is logged (`verify.request_proof`, result `replayed_nonce`) but still allowed, matching the existing soft-mode contract (soft logs, required denies). Relay resistance is only enforced in `required` mode — which is why 1e makes `required` the documented production default.

### 1d. Add a cryptographic-binding accept path so a verified device key satisfies binding without the self-asserted device_hash (WIP file: src/index.ts)

### Gap (corrected)
`handleVerify` accepts the entitlement when `row.device_hash === "" || row.device_hash === verifyRequest.device_hash` (src/index.ts:843-849). When `required` request-proof mode is on and a device key is enrolled, the real binding is the cryptographic device identity (the ECDSA key), but the current condition only consults the plaintext `device_hash`. Today, a request whose ECDSA proof verified but whose self-asserted `device_hash` does **not** match the entitlement's bound hash would be denied even though the device is cryptographically proven.

### Change (WIP: src/index.ts) — what the code actually does
The change **adds** an OR clause so a verified `required`-mode proof also satisfies binding. It **does not** remove or tighten the existing plaintext-`device_hash` clause — `row.device_hash === "" || row.device_hash === verifyRequest.device_hash` stays exactly as before. Net effect: the accept condition is **loosened** (a verified device key is now an additional way to satisfy binding); it is not tightened, and no security property is removed. The no-device case (`row.device_hash === ""`) is untouched, so no-device entitlements still pass exactly as before. Replace the `activeRow` computation (src/index.ts:843-849):

```ts
  // Binding is satisfied by EITHER the (unchanged) plaintext device_hash match,
  // OR — additionally — a cryptographically verified device key in required mode.
  // The plaintext clause is request-controlled and is intentionally left as-is for
  // back-compat; the new clause lets a proven ECDSA device satisfy binding even
  // when the self-asserted device_hash does not match. This LOOSENS the accept
  // condition (adds an accept path); it removes nothing.
  const proofVerified = proofEvaluation.result === "valid";
  const deviceHashSatisfied =
    row !== null &&
    (row.device_hash === "" ||
      row.device_hash === verifyRequest.device_hash ||
      (proofVerified && proofEvaluation.mode === "required"));
  const activeRow =
    row !== null && row.status === "active" && entitlementWithinValidity(row, now) && deviceHashSatisfied
      ? row
      : null;
```

> **Honest scope note.** A self-asserted `device_hash` still independently satisfies a device-bound entitlement exactly as it did before this patch (the `row.device_hash === verifyRequest.device_hash` clause is unchanged). If you want the plaintext hash to *stop* independently satisfying binding once a device key is enrolled, that is a **separate, behavior-removing** change (drop or gate the plaintext clause) and must ship with its own tests, because it can deny clients that relied on the plaintext path. It is **not** in this patch. Existing off/soft behavior is unchanged.

### 1e. Make `required` the documented production default (WIP file: src/index.ts + wrangler.example.toml)

### Gap
`REQUEST_SIGNATURE_MODE` defaults to `off` (`requestSignatureMode`, src/index.ts:276-281; wrangler.example.toml:14). The relay defense is inert until `required`. The code default must stay back-compatible, but the **documented production default** must be `required`.

### Change (WIP)
1. `services/cloudflare-licensing-backend/wrangler.example.toml` — flip the example var and document the rollout, line 11-14:

```toml
# Request proof-of-possession rollout mode: off, soft, or required.
# off keeps legacy clients compatible. soft logs missing/invalid/replayed proof but
# still allows otherwise-valid entitlements. required denies missing/invalid/replayed
# proof and is the PRODUCTION DEFAULT. Roll out off -> soft (observe) -> required.
REQUEST_SIGNATURE_MODE = "required"
```

2. Document the runtime default behind the env flag in the `requestSignatureMode` doc (src/index.ts:276) — leave the runtime fallback `off` (so an unconfigured dev Worker is permissive) but state the intent:

```ts
// Production deployments MUST set REQUEST_SIGNATURE_MODE = "required" (see
// wrangler.example.toml). The runtime fallback stays "off" only so an unconfigured
// dev Worker does not silently reject legacy clients.
function requestSignatureMode(env: Env): RequestSignatureMode {
  if (env.REQUEST_SIGNATURE_MODE === "soft" || env.REQUEST_SIGNATURE_MODE === "required") {
    return env.REQUEST_SIGNATURE_MODE;
  }
  return "off";
}
```

### 1f. Tests (node --test) — replay denied, fail-closed deny, soft logs (WIP-adjacent test file)

**File:** `services/cloudflare-licensing-backend/test/online-verifier.test.mjs` (extend; uses the existing `requestProofFixture`/`testKeyEnv`/`worker.fetch` harness).

The existing mock `DB.prepare` (test lines 35-73) only branches on `FROM entitlement_devices` and a generic entitlement query. The replay store needs a third branch. Add a helper env that carries a stateful in-memory nonce set, then three tests:

```js
// Stateful test env: real entitlement + device rows + an in-memory nonce store so a
// second identical request observes the consumed nonce.
async function replayTestEnv(row, proof, envOverrides = {}) {
  const base = await testKeyEnv(row, {
    REQUEST_SIGNATURE_MODE: "required",
    deviceRows: [proof.deviceRow],
    ...envOverrides,
  });
  const consumed = new Set();
  const innerPrepare = base.DB.prepare.bind(base.DB);
  base.DB.prepare = (sql) => {
    if (sql.includes("INSERT INTO request_proof_nonces")) {
      return {
        bind(project, feature, fingerprint, deviceKeyId, nonce) {
          const key = [project, feature, fingerprint, deviceKeyId, nonce].join("|");
          return {
            async first() {
              if (consumed.has(key)) return null; // ON CONFLICT DO NOTHING -> no row
              consumed.add(key);
              return { nonce };
            },
          };
        },
      };
    }
    if (sql.includes("DELETE FROM request_proof_nonces")) {
      return { bind: () => ({ async run() {} }) };
    }
    return innerPrepare(sql);
  };
  return { env: base, failNonceStore: () => { base.DB.prepare = failingNoncePrepare(innerPrepare); } };
}

function failingNoncePrepare(innerPrepare) {
  return (sql) => {
    if (sql.includes("request_proof_nonces")) {
      return { bind: () => ({ async first() { throw new Error("d1 down"); }, async run() { throw new Error("d1 down"); } }) };
    }
    return innerPrepare(sql);
  };
}

test("required mode denies a replayed request proof on the second identical request", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env } = await replayTestEnv(row, proof);
    const send = () =>
      worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
    const first = await send();
    assert.equal((await first.json()).ok, true);

    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: false, code: "request_proof_invalid", server_time: 1_000_000 });
  } finally {
    Date.now = originalNow;
  }
});

test("required mode fails CLOSED when the nonce store errors", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env, failNonceStore } = await replayTestEnv(row, proof);
    failNonceStore();
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proof.body),
      }),
      env,
    );
    // d1_error on the proof path returns HTTP 500 verification_error (never an allow).
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
  } finally {
    Date.now = originalNow;
  }
});

test("soft mode logs a replayed nonce but still allows", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env } = await replayTestEnv(row, proof, { REQUEST_SIGNATURE_MODE: "soft" });
    const send = () =>
      worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
    await (await send()).json();
    const logs = await captureConsoleEvents(async () => {
      const replay = await send();
      assert.equal((await replay.json()).ok, true); // soft still allows
    });
    const proofLog = logs.find((e) => e.event === "verify.request_proof");
    assert.equal(proofLog?.result, "replayed_nonce");
    assert.equal(proofLog?.mode, "soft");
  } finally {
    Date.now = originalNow;
  }
});
```

> **Test-harness caveat (read before relying on the existing valid-path test).** The EXISTING required-mode-valid test "request proof required mode accepts a registered device signature" (test lines 486-521) uses the **unmodified** `testKeyEnv` mock, which has **no branch** for the new `INSERT INTO request_proof_nonces`. With that mock the INSERT falls through to the generic entitlement branch whose `.bind().first()` returns the matching (non-null) row, so the worker reads `"fresh"` only **coincidentally**. The subsequent opportunistic sweep `DELETE ... .run()` then hits a generic mock object that has **no `run()` method** and would throw `TypeError` — it survives **only** because `consumeRequestProofNonce` wraps the sweep in `try { ... } catch {}`. That test passes by luck, not by design. To make the valid path robust against future harness changes, **extend `testKeyEnv` itself** with the same `INSERT INTO request_proof_nonces` / `DELETE FROM request_proof_nonces` branches used in `replayTestEnv` (or have the existing valid test use `replayTestEnv`), so the live valid path does not depend on the swallowed sweep or on the generic mock coincidentally returning a non-null row. Do not remove the `try/catch` around the sweep as a "cleanup" — it is load-bearing for these mocks; if it is ever removed, also fix every nonce-aware mock to expose `run()`.

> The skew/timestamp check (src/index.ts:711) still runs *before* the nonce consume, so a captured body older than the skew window is rejected as `stale_timestamp` before it can even touch the store — the nonce table only has to cover the live skew window, which is why TTL = `now + skew*2` is sufficient.

---

## Finding 2 — CONFIG-ATTESTATION PARITY (MEDIUM): key floor only (no-never-expires withdrawn)

### Gap
`config_signature_policy` sets `policy.min_public_key_bits = 0` (ConfigAttestation.cpp:31) while the online policy floors at 3072 (signature_verifier.hpp:249). A config token signed by an undersized RSA key passes signature verification. (The separate `expires_at == 0` never-expiring gap is a real parity hole too, but closing it now breaks a committed test — see the withdrawal note below.)

### 2a. Key floor — 3072 bits (LANDS NOW; commits clean)

**File (commits clean):** `src/library/config_attestation/ConfigAttestation.cpp`, line 31:

```cpp
	policy.min_public_key_bits = 3072;
```

**Test-key caveat (verified):** the enforcement gate only checks bits when `min_public_key_bits > 0` and reads them from the PKCS#1 DER (`signature_request_allowed`, signature_verifier.hpp:469-474). The config tests bind the *embedded project key* via `embedded_public_key_bits()` (config_attestation_test.cpp:38; config_public_api_test.cpp:119), and the generated DEFAULT/test project key is RSA-3072 (`#define LCC_PUBLIC_KEY_BITS 3072` in the generated `public_key.h`; the release floor `LCC_MIN_RELEASE_PUBLIC_KEY_BITS` is 3072, CMakeLists.txt:29). The one explicit-bits fixture at config_attestation_test.cpp:291 already uses `key.bits = 3072`. So this floor passes with current test keys. If a test project is ever regenerated with a sub-3072 key (e.g. a legacy RSA-1024 fixture like release_safety_smoke.cmake:247), that config-attestation test would now correctly fail — desired, but call it out in the test project's keygen.

### 2b. No-never-expires policy — **WITHDRAWN from this patch (would break a committed test)**

The intended change was to reject `claims.expires_at == 0` in `validate_claims` so config tokens cannot be issued with no expiry (matching online assertions, which always enforce expiry at OnlineVerification.cpp:194). **This is not in this patch** because it breaks the SUCCESS-path test:

- `test/library/config_public_api_test.cpp` builds every config token through the **shared** helper `config_token_for()` (lines 124-143), which sets `c.issued_at = 0; c.expires_at = 0;` (lines 138-139).
- `verify_config_allows_valid_token_and_denies_tamper` builds its token via that helper (line 158) and asserts `lcc_verify_config(...) == LICENSE_OK` and `decision.decision == LCC_LICENSE_DECISION_ALLOW` (lines 174-175).
- Rejecting `expires_at == 0` makes that token fail with `ConfigVerifyFailure::Expired`, regressing a committed test.

To close this gap later (recommended, since the never-expiring config token is genuinely weaker than the online protocol), the **shared** `config_token_for()` helper must first be given a real future `expires_at` (and a sensible `issued_at`), and any other fixture that builds a token with `expires_at == 0` must be migrated the same way. That fixture migration plus the `ConfigAttestation.cpp` `validate_claims` change ship together as their own commit. Note this is a **different** file from the earlier draft's caveat: the breaking fixture is `config_public_api_test.cpp:138-139`, **not** `config_attestation_test.cpp` (whose `make_claims` default `expires_at = 1100` is nonzero and fine) and **not** `test/vectors/config_attestation/golden.config` (golden uses `--expires-at 2000`, also fine).

### 2c. Durable `min_config_seq` floor — **Plan 2b** (does NOT land now)

The rollback floor is currently caller-supplied only: `LccConfigVerifyOptions.min_config_seq` (datatypes.h:271), enforced at ConfigAttestation.cpp:111. The header itself says "persistent per-config-id floor storage is a later phase" (datatypes.h:265). The durable equivalent of the revocation floor should mirror the existing `LCC_REVOCATION_FLOOR_LOAD`/`STORE` shape (datatypes.h:197-206), keyed per `config_id`. **Plan-2b scoped** — design only, shown for the reader's plan:

```c
/* PLAN 2b — not in this patch. Parallels LccRevocationFloorRecord (datatypes.h:174). */
typedef struct LccConfigSeqFloorRecord {
	uint32_t size;
	uint32_t version;
	char project[LCC_API_ONLINE_PROJECT_SIZE + 1];
	char feature[LCC_API_FEATURE_NAME_SIZE + 1];
	char config_id[LCC_API_CONFIG_ID_SIZE + 1];
	uint64_t config_seq;
} LccConfigSeqFloorRecord;

/* Return true + strongest stored seq in *config_seq_out; storage read failure
 * returns false so lcc_verify_config fails CLOSED (mirrors the revocation-floor
 * contract at datatypes.h:190-198). */
typedef bool (*LCC_CONFIG_SEQ_FLOOR_LOAD)(void* user_data,
                                          const LccConfigSeqFloorRecord* key,
                                          uint64_t* config_seq_out);
/* Persist max-seen config_seq for the exact project/feature/config_id; false on
 * failure fails CLOSED. */
typedef bool (*LCC_CONFIG_SEQ_FLOOR_STORE)(void* user_data,
                                           const LccConfigSeqFloorRecord* record);
```

The wiring in `lcc_verify_config` would mirror `acquire_license_ex`'s floor flow (licensecc.cpp:796-883): if a config-seq floor callback set is present, `load` the floor into `expected.min_config_seq`, fail closed on load failure, and `store` the accepted `claims.config_seq` on success. Not in this patch.

---

## Finding 3 — DOC REFRAME: "secure wrapper" overclaim, `bound_to_device`, raw-path floor caveat

### Gap
`lcc_acquire_license_decision`'s doc (the "Secure decision wrapper" block beginning at licensecc.h:167, on the function declared at licensecc.h:183) calls itself a "Secure decision wrapper" with "enforced anti-tamper checks" — overstated on an attacker-controlled host (it *configures* policy and *requires* floor callbacks but cannot prove probes ran). `bound_to_device` (datatypes.h:287) reads as an attestation property but is only `!device_hash.empty()` (licensecc.cpp:1092). And `acquire_license_ex`'s doc (licensecc.h:146-164) does not warn that raw callers must wire the revocation-floor load/store themselves; the raw-path helpers note (the comment block at licensecc.h:207-211, above `lcc_set_online_revocation_floor` at line 213) under-documents this.

> **Anchor note (apply cleanliness):** the real current anchors are the `/**` "Secure decision wrapper for production integrations..." block at **licensecc.h:166-182** (declaration `lcc_acquire_license_decision` at **183**) and the revocation-floor helper comment block at **licensecc.h:207-211** (declarations at 213-214). Match the exact current text below when forming the `old_string` for each Edit; these are comment-only edits with no behavior impact.

### 3a. Reframe the wrapper doc-comment (WIP file: licensecc.h)

**File (WIP):** `include/licensecc/licensecc.h`, replace the comment block at lines 166-182 (the `/** Secure decision wrapper ... */` immediately above the `lcc_acquire_license_decision` declaration at line 183):

```c
/**
 * Production decision wrapper. It orchestrates the local license check,
 * configures anti-tamper enforcement, requires online verification, and enforces
 * a persisted revocation-sequence rollback floor, collapsing the result to a
 * single ::LICENSE_OK only when the decision is ::LCC_LICENSE_DECISION_ALLOW.
 *
 * What this DOES guarantee: required online verification ran and a signed
 * assertion was accepted; the persisted revocation floor was loaded and the
 * accepted revocation_seq stored; load/store failures fail closed so a restarted
 * process cannot accept an older assertion.
 *
 * What this does NOT guarantee: it cannot prove code ran on an attacker-controlled
 * host. `decision_out->tamper_enforced` means the wrapper *configured* tamper
 * enforcement for the call -- it does not prove every optional host-integrity
 * probe executed, and a local license failure can deny before any runtime
 * callback is evaluated. Treat the server (the online verifier) as authoritative;
 * this wrapper is defense-in-depth, not a guarantee about the client process.
 *
 * The host callbacks in ::LccLicenseDecisionOptions must load and store the
 * strongest revocation_seq seen for the exact project/feature/license
 * fingerprint.
 */
```

### 3b. Document `bound_to_device` honestly (WIP file: datatypes.h)

**File (WIP):** `include/licensecc/datatypes.h`, line 287 — add a field doc comment (currently none):

```c
	bool bound_to_license;
	/**
	 * Reflects only that a non-empty device_hash was supplied in ::LccConfigInput
	 * and matched the token's bound device_hash. It is NOT proof of device
	 * possession or attestation: device_hash is caller-supplied input. For
	 * cryptographic device binding use the online verifier's request-proof
	 * (ECDSA device key) path, not this flag.
	 */
	bool bound_to_device;
```

This matches the implementation exactly: `decision_out->bound_to_device = !expected.device_hash.empty();` (licensecc.cpp:1092).

### 3c. Raw-path revocation-floor caveat (WIP file: licensecc.h)

**File (WIP):** `include/licensecc/licensecc.h`, extend the `acquire_license_ex` doc (after line 161, before the closing `*/`):

```c
 *
 * Raw-path caveat: when you call ::acquire_license_ex directly with online
 * verification enabled, YOU own the revocation-floor lifecycle. The floor
 * load/store callbacks come from ::LicenseCheckOptions; if online verification is
 * enabled and they are absent, the call fails closed with
 * ::LICENSE_ONLINE_REQUIRED. Restore the persisted floor at startup and persist
 * the accepted revocation_seq after each success, or a restarted process can
 * accept a superseded assertion. ::lcc_acquire_license_decision does this
 * load/store wiring for you and is preferred for production hosts.
```

And tighten the helper note at the comment block at licensecc.h:207-211 (above `lcc_set_online_revocation_floor` at line 213) to point at the fail-closed behavior:

```c
/**
 * Process-local online revocation-floor helpers, useful for tests and for hosts
 * that restore a persisted floor at startup before calling ::acquire_license_ex
 * directly (which, used raw, requires the caller to own floor load/store -- see
 * its caveat). The secure decision wrapper above is preferred because it
 * loads/stores the floor on every successful online decision.
 */
```

---

## Finding 4 — V200 KEY FLOOR — **WITHDRAWN from this patch (would break committed signature tests)**

### Gap (still real, deferred)
`legacy_v200_signature_policy` never sets `min_public_key_bits`, so it stays at the struct default 0 (signature_verifier.hpp:215-225, default at line 202). v201 and the online policy both set 3072 (lines 236, 249). A v200 license signed by an undersized RSA key passes signature verification.

### Why it is withdrawn
Setting `policy.min_public_key_bits = 3072` in `legacy_v200_signature_policy()` breaks at least five committed `test/functional/signature_verifier_test.cpp` cases that build requests with this exact policy (via `legacy_request()`, lines 46-56) using **2048-bit** RSA keys and assert success:

- `verify_signature_policy_handles_payload_edge_cases` — `generateKeyPair(2048)` (line 435), `FUNC_RET_OK` (line 449).
- `verify_signature_policy_rejects_alternate_payload_spelling` — 2048 (line 459), `FUNC_RET_OK` (line 467).
- `verify_signature_policy_rejects_duplicate_and_retired_key_ids` — 2048 (line 522), `FUNC_RET_OK` (line 527).
- `verify_signature_policy_selects_public_key_by_key_id` — 2048 ring entries (lines 564-567), `signature_request_allowed == true` (line 569) and `FUNC_RET_OK` (line 570).
- `verify_signature_policy_rejects_duplicate_public_key_ring_entries` — 2048 (line 580).

The 3072 floor is enforced at **both** the ring level (`signature_public_key_record_allowed` -> the `min_public_key_bits == 0 || derived_bits >= min_public_key_bits` check at signature_verifier.hpp:391) **and** the selected-key level (`signature_request_allowed`, lines 469-474). `test_signature_verifier` is a registered ctest matched by this patch's own `ctest -R 'signature'` command (test/functional/CMakeLists.txt:74-80), so these failures would surface immediately.

### To land it later
Either (a) regenerate those five tests' ad-hoc keys to 3072 (they call `crypto->generateKeyPair(...)` inline, so this is a localized test edit), or (b) keep a deliberately-permissive v200 floor and only enforce 3072 for v201/online (status quo). Given v201, online, and config-attestation (Finding 2a) already enforce 3072 and the release gate floors at 3072 (CMakeLists.txt:29), option (a) plus the policy line is the clean close — but it is a **test-touching** change and ships separately, not in this committed-policy patch.

---

## What lands now vs deferred (summary)

| Change | File | WIP? | Lands now / Deferred |
|---|---|---|---|
| 1a nonce migration `0009` | migrations/0009_*.sql | new (clean) | now |
| 1b snapshot parity | schema.sql | WIP | now |
| 1b Postgres parity | supabase-postgres/schema.pg.sql | WIP | now |
| 1c consume-nonce + fail-closed | src/index.ts | WIP | now |
| 1d add verified-device accept path (loosens; removes nothing) | src/index.ts | WIP | now |
| 1e `required` documented default | wrangler.example.toml, src/index.ts | WIP | now |
| 1f replay/fail-closed/soft tests | test/online-verifier.test.mjs | WIP | now |
| 2a config key floor 3072 | ConfigAttestation.cpp | clean | now |
| 2b no-never-expires | ConfigAttestation.cpp + config_public_api_test.cpp | clean+test | **Deferred** (breaks shared `config_token_for()` fixture) |
| 2c durable config-seq floor | datatypes.h + licensecc.cpp | WIP | **Plan 2b** |
| 3a/3b/3c doc reframe | licensecc.h, datatypes.h | WIP | now |
| 4 v200 key floor 3072 | signature_verifier.hpp + signature_verifier_test.cpp | clean+test | **Deferred** (breaks 5 committed 2048-bit signature tests) |

---

## Verification

**Finding 1 (worker):**
```sh
cd services/cloudflare-licensing-backend
python scripts/check-schema-parity.py        # must print "schema parity ok" after 1a+1b
npm run build                                 # tsc compiles src/index.ts -> dist/index.js (tests import dist)
node --test test/online-verifier.test.mjs     # new replay/fail-closed/soft tests + all existing proof tests
node scripts/lint.mjs                          # per-service lint
```
Expect: the existing "request proof required mode" tests stay green (see the test-harness caveat in 1f — extend `testKeyEnv` with nonce-store branches so the valid path is not relying on the swallowed sweep); the three new tests pass (replay -> `request_proof_invalid`; store-error -> HTTP 500 `verification_error`; soft -> allow + `replayed_nonce` log).

**Finding 2a (config key floor) — C++ policy:**
```sh
cd build
cmake --build . --config Release --target install
ctest -C Release -R "config_attestation|config_public_api" --output-on-failure
```
Expect: config-attestation tests pass with the 3072 floor (DEFAULT/test key is RSA-3072). **Do not** add `-R signature` expecting the v200 floor — that change is withdrawn (Finding 4) and the signature suite still uses 2048-bit ad-hoc keys. On Windows use `ctest -C Release` with `CTEST_OUTPUT_ON_FAILURE=1`.

**Regression guard for the withdrawn changes:** to confirm nothing in this patch reintroduces the breaks, run the full suites that the withdrawn changes would have hit and confirm they stay green:
```sh
ctest -C Release -R "signature" --output-on-failure   # 2048-bit legacy tests must still pass (Finding 4 withdrawn)
ctest -C Release -R "config_public_api" --output-on-failure  # expires_at=0 success token must still pass (Finding 2b withdrawn)
```

**Finding 3 (docs):** header-only comment/doc changes — confirm the library still compiles (`cmake --build . --config Release`) and that `bound_to_device`'s new comment matches `licensecc.cpp:1092` (`!expected.device_hash.empty()`). No behavior change. When forming each Edit's `old_string`, match the current text at the corrected anchors (wrapper block 166-182 above the declaration at 183; helper block 207-211 above the declaration at 213).

**Cross-check the fail-closed property explicitly:** in 1c, every non-`fresh` D1 outcome returns `"d1_error"` or `"replayed_nonce"`, both of which are `!== "valid"`, so the `required`-mode gate (src/index.ts:819) denies. The store-error path returns HTTP 500 and never reaches the assertion-signing block (src/index.ts:876-926). There is no code path where a store failure yields `ok: true`. The 1d change only **adds** an accept clause (verified device key in required mode); it removes no existing deny, so it cannot turn a previously-denied request into an allow except by the intended cryptographic-binding path.