import {
  buildV201CanonicalPayload,
  buildLeaseLicenseText,
  leaseCanonicalFields,
  utcDateFromEpoch,
} from "@licensecc/licensing-domain/lease/canonical_payload";
import {
  LEASE_ISSUANCE_ATOMIC_SQL,
  leaseIssuanceSqlOwned,
} from "../lease/issuance_sql.mjs";
import { evaluateTrialActivation, trialLockKey } from "@licensecc/licensing-domain/lease/trial";
import { buildTrialActivationStamp } from "@licensecc/cloudflare-runtime/lease/trial_store";
import { json, requestId } from "@licensecc/cloudflare-runtime/http/kit";
import { readIdempotentResponse, writeIdempotentResponse } from "@licensecc/cloudflare-runtime/d1/idempotency_store";
import type { D1PreparedStatementLike, Env, ExecutionContextLike, IsolationBinding, RequestProof } from "../env.js";
import {
  LEASE_PROOF_PURPOSE,
  base64FromBytes,
  boundedTime,
  checkDeviceProof,
  clampToValidUntil,
  importSigningKey,
  parseRequestProofFields,
  readJsonBody,
  requireString,
  resolveIsolation,
} from "./verify.js";
import { logEvent } from "../observability/index.js";

// ============================ Lease platform (activate / renew) ============================
//
// Sliding-window, hardware-bound, signed v201 leases (design doc 2026-06-21). The Worker
// is the public edge: it authenticates, checks the entitlement, CLAMPS the lease expiry to
// the subscription end (so a cancelled/expired subscription cannot be over-issued), enforces
// the device-rebind cap ATOMICALLY (no check-then-insert TOCTOU), then signs a lease with
// the HOT lease key. The device-key ECDSA *proof* (relay-resistance) is the documented next
// layer, wired to the existing entitlement_devices + request_proof_nonces machinery.

const LEASE_DEFAULT_SKEW_DAYS = 2;
const LEASE_DEFAULT_SECONDS = 2592000;

interface LeaseEntitlementRow {
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  max_active_devices: number;
  lease_seconds: number;
  rebind_window_sec: number;
  // Frozen trial state (stamped at policy-stamp time; read from the SAME row, NEVER joined).
  is_trial: number;
  trial_expiration_basis: string | null;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
  trial_started_at: number | null;
  trial_device_hash: string | null;
}

interface LeaseIssueBody {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_key_id: string;
  hw_id?: string; // client-signature (XXXX-XXXX-XXXX) for the .lic offline HW binding
  client_signature_source_strength?: string;
  start_version?: string;
  end_version?: string;
  request_id?: string; // idempotency key
  nonce?: string; // required when a device proof is present (canonical payload + replay dedup)
  request_proof?: RequestProof;
}

let cachedLeaseSigningKey: { cacheKey: string; keyPromise: Promise<CryptoKey> } | undefined;

async function leaseSigningKeyFor(env: Env): Promise<CryptoKey> {
  const pem = env.LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM ?? "";
  const cacheKey = `${env.LEASE_SIGNING_KEY_ID ?? ""}\n${pem}`;
  if (cachedLeaseSigningKey === undefined || cachedLeaseSigningKey.cacheKey !== cacheKey) {
    cachedLeaseSigningKey = { cacheKey, keyPromise: importSigningKey(pem) };
  }
  return cachedLeaseSigningKey.keyPromise;
}

export function resetLeaseSigningKeyCacheForTests(): void {
  cachedLeaseSigningKey = undefined;
}

async function signLeaseLicense(fields: Record<string, string | undefined>, env: Env): Promise<string> {
  const payload = buildV201CanonicalPayload(fields);
  const key = await leaseSigningKeyFor(env);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, payload.bytes);
  return buildLeaseLicenseText(fields, base64FromBytes(new Uint8Array(signature)));
}

function parseLeaseBody(raw: unknown): LeaseIssueBody | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const project = requireString(value.project);
  const feature = requireString(value.feature);
  const licenseFingerprint = requireString(value.license_fingerprint);
  const deviceKeyId = requireString(value.device_key_id);
  if (project === null || feature === null || licenseFingerprint === null || deviceKeyId === null) return null;
  const body: LeaseIssueBody = {
    project,
    feature,
    license_fingerprint: licenseFingerprint,
    device_key_id: deviceKeyId,
  };
  if (typeof value.hw_id === "string" && value.hw_id.length > 0) body.hw_id = value.hw_id;
  if (typeof value.client_signature_source_strength === "string") {
    body.client_signature_source_strength = value.client_signature_source_strength;
  }
  if (typeof value.start_version === "string") body.start_version = value.start_version;
  if (typeof value.end_version === "string") body.end_version = value.end_version;
  if (typeof value.request_id === "string" && value.request_id.length > 0) body.request_id = value.request_id;
  if (typeof value.nonce === "string" && value.nonce.length > 0) body.nonce = value.nonce;
  const proofResult = parseRequestProofFields(value, deviceKeyId);
  if (proofResult.invalid) return null; // proof fields present but malformed -> reject
  if (proofResult.proof !== undefined) {
    if (body.nonce === undefined) return null; // a lease proof needs a nonce
    body.request_proof = proofResult.proof;
  }
  return body;
}

export function leaseWithinValidity(row: { valid_from: number | null; valid_until: number | null }, nowSeconds: number): boolean {
  const validFrom = boundedTime(row.valid_from);
  const validUntil = boundedTime(row.valid_until);
  if (validFrom !== null && nowSeconds < validFrom) return false;
  if (validUntil !== null && nowSeconds >= validUntil) return false;
  return true;
}

async function lookupLeaseEntitlement(env: Env, body: LeaseIssueBody): Promise<LeaseEntitlementRow | null> {
  // The frozen trial columns ride the SAME single-row read (no join to entitlement_policies — the
  // hot path must not join): the lease deadline + device lock are computed from this one row.
  return env.DB.prepare(
    "SELECT status, valid_from, valid_until, max_active_devices, lease_seconds, rebind_window_sec, " +
      "is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, " +
      "trial_require_device_proof, trial_started_at, trial_device_hash " +
      "FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  )
    .bind(body.project, body.feature, body.license_fingerprint)
    .first<LeaseEntitlementRow>();
}

// Atomic device-rebind cap. The INSERT lands only if the number of DISTINCT *other*
// devices issued within the rebind window is below max_active_devices, so a renew of an
// existing device always succeeds and a brand-new device is capped -- evaluated and written
// in ONE statement (no check-then-insert race). Returns the inserted row, or null when the
// cap would be exceeded. Mirrors the race-free consumeRequestProofNonce pattern.
async function atomicLeaseIssuance(
  env: Env,
  body: LeaseIssueBody,
  row: LeaseEntitlementRow,
  now: number,
  validFromEpoch: number,
  validToEpoch: number,
  leaseKeyId: string,
  isolation: IsolationBinding,
  trialStamp?: D1PreparedStatementLike,
): Promise<boolean> {
  const windowStart = now - (row.rebind_window_sec > 0 ? row.rebind_window_sec : 0);
  const maxDevices = row.max_active_devices > 0 ? row.max_active_devices : 1;
  // Off mode (legacy bearer, customerId null): the ORIGINAL non-owned cap guard. An owned guard
  // would bind `e.customer_id = null` and match nothing, breaking issuance — so off must NOT use
  // the owned SQL. The 15-param bind order is the original LEASE_ISSUANCE_ATOMIC_SQL contract.
  const capInsert =
    isolation.mode === "off"
      ? env.DB.prepare(LEASE_ISSUANCE_ATOMIC_SQL).bind(
          body.project,
          body.feature,
          body.license_fingerprint,
          body.device_key_id,
          leaseKeyId,
          now,
          validFromEpoch,
          validToEpoch,
          body.request_id ?? null,
          body.project,
          body.feature,
          body.license_fingerprint,
          windowStart,
          body.device_key_id,
          maxDevices,
        )
      : // soft / required: F2/F3 — the ownership EXISTS (customer_id + status='active' + validity) is
        // folded into the cap guard, so a revoke/expiry/wrong-owner between the pre-read and this write
        // cannot mint a lease. The signed lease derives from the guard-confirmed insert (RETURNING id),
        // not the advisory pre-read. The device-count subquery stays tuple-scoped.
        env.DB.prepare(leaseIssuanceSqlOwned(isolation.mode)).bind(
          body.project,
          body.feature,
          body.license_fingerprint,
          body.device_key_id,
          leaseKeyId,
          now,
          validFromEpoch,
          validToEpoch,
          body.request_id ?? null,
          body.project,
          body.feature,
          body.license_fingerprint,
          windowStart,
          body.device_key_id,
          maxDevices,
          // EXISTS ownership binds: project, feature, fingerprint, customer_id, now, now.
          body.project,
          body.feature,
          body.license_fingerprint,
          isolation.customerId,
          now,
          now,
        );

  // No trial activation stamp: the original single-statement path (unchanged behavior).
  if (trialStamp === undefined) {
    return (await capInsert.first<{ id: number }>()) !== null;
  }

  // Stage 4: a from_first_activation/from_first_use trial's FIRST activation. The cap INSERT and the
  // WRITE-ONCE trial-clock stamp commit in ONE transaction so "lease issued" and "trial_started_at
  // set" are atomic. The stamp's own EXISTS gate (over the just-inserted lease_issuance row) means a
  // CAPPED issuance — where the INSERT lands no row — leaves trial_started_at NULL (no false start).
  // We derive success solely from the cap insert's RETURNING id (results[0]).
  if (env.DB.batch === undefined) {
    // Degraded/mocked binding: fail closed rather than start the trial clock without an atomic lease.
    return (await capInsert.first<{ id: number }>()) !== null;
  }
  const results = await env.DB.batch([capInsert, trialStamp]);
  const capRows = results[0]?.results;
  return Array.isArray(capRows) && capRows.length > 0;
}

// F1: idempotency MUST be scoped by the authenticated customer_id so a replay of customer B's
// request_id under customer A's token MISSES the cache (different scope) and falls through to the
// ownership guard, which denies. In off/bearer mode the customerId is null -> the legacy "lease"
// scope is preserved (no behavior change before the cutover).
function leaseIdempotencyScope(isolation: IsolationBinding): string {
  return isolation.customerId === null ? "lease" : `lease:${isolation.customerId}`;
}

async function getLeaseIdempotent(
  env: Env,
  requestId: string | undefined,
  isolation: IsolationBinding,
): Promise<unknown | null> {
  if (requestId === undefined) return null;
  try {
    const raw = await readIdempotentResponse(env.DB, leaseIdempotencyScope(isolation), requestId);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null; // best-effort; a missing idempotency hit just re-issues
  }
}

async function putLeaseIdempotent(
  env: Env,
  requestId: string | undefined,
  response: unknown,
  now: number,
  isolation: IsolationBinding,
): Promise<void> {
  if (requestId === undefined) return;
  try {
    await writeIdempotentResponse(env.DB, leaseIdempotencyScope(isolation), requestId, JSON.stringify(response), now);
  } catch {
    // best-effort; idempotency is an optimization, not a correctness gate here
  }
}

export async function handleLeaseIssue(
  request: Request,
  env: Env,
  operation: "activate" | "renew",
  ctx?: ExecutionContextLike,
  isolationOverride?: IsolationBinding,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  if (!env.LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM || !env.LEASE_SIGNING_KEY_ID) {
    return json({ ok: false, code: "lease_signing_unavailable" }, 503);
  }

  const rawBody = await readJsonBody(request);
  if (!rawBody.ok) return json({ ok: false, code: rawBody.code }, rawBody.status);
  const body = parseLeaseBody(rawBody.value);
  if (body === null) return json({ ok: false, code: "invalid_request" }, 400);

  // Per-customer account-token gate (replaces the legacy LEASE_ISSUE_BEARER check). The
  // returned customerId is bound into the mutating cap guard (off => null => legacy SQL path).
  const isolation = await resolveIsolation(request, env, operation, body.project, body.feature, now, ctx, isolationOverride);
  if ("ok" in isolation) return json({ ok: false, code: isolation.code }, isolation.status);

  let row: LeaseEntitlementRow | null;
  try {
    row = await lookupLeaseEntitlement(env, body);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (row === null || row.status !== "active" || !leaseWithinValidity(row, now)) {
    return json({ ok: false, code: "no_active_entitlement" }, 403);
  }
  const validUntil = boundedTime(row.valid_until);
  if (validUntil !== null && validUntil <= now) {
    return json({ ok: false, code: "expired_subscription" }, 403);
  }

  // Idempotency AFTER the entitlement/status/expiry gate, so a captured request_id cannot re-serve
  // a lease for a now-revoked or -expired entitlement. (A cached hit is a benign return of the
  // device-bound lease already issued for this request_id; valid_to was clamped at issuance.)
  const cached = await getLeaseIdempotent(env, body.request_id, isolation);
  if (cached !== null) return json(cached);

  // Device-proof gate (relay-resistance / anti-cloning): a presented proof binds the lease to the
  // registered, non-exportable device key; required mode denies issuance without one.
  const leaseProof = await checkDeviceProof(
    env,
    { project: body.project, feature: body.feature, license_fingerprint: body.license_fingerprint, device_hash: "", nonce: body.nonce ?? "", client_hardening: 0 },
    body.request_proof,
    now,
    LEASE_PROOF_PURPOSE,
  );
  if (!leaseProof.ok) return json({ ok: false, code: leaseProof.code }, 403);

  // Stage 4: server-computed trial timing. The frozen trial columns were read off the SAME
  // entitlements row (no join). Device lock (one-per-device / require-proof) is evaluated BEFORE any
  // mutation and is fail-closed (403, no write). For from_first_activation/from_first_use the clock
  // starts on this activation (write-once stamp, below); from_issue needs no stamp.
  const trialLock = trialLockKey(body.device_key_id, leaseProof.proven);
  const trial = evaluateTrialActivation(row, trialLock, leaseProof.proven, now);
  if (trial.trial && trial.deny !== undefined) {
    return json({ ok: false, code: trial.deny }, 403);
  }

  // Clamp the lease expiry to the subscription end (the kill-switch). Mandatory signed
  // valid-from is backdated by SKEW_DAYS to absorb day-granularity skew.
  const leaseSeconds = row.lease_seconds > 0 ? row.lease_seconds : LEASE_DEFAULT_SECONDS;
  let validToEpoch = validUntil === null ? now + leaseSeconds : Math.min(now + leaseSeconds, validUntil);
  // Trial deadline clamp: never let a trial lease outlive trial_started_at + trial_duration_sec.
  // (Reuses the same min() discipline as the valid_until clamp above.)
  const trialActivationExpiry = trial.trial ? trial.trialExpiresAt : null;
  if (trialActivationExpiry !== null) validToEpoch = Math.min(validToEpoch, trialActivationExpiry);
  // The trial deadline SURFACED in the envelope: the entitlement-level trial expiry clamped to the
  // subscription end — independent of this lease's (possibly shorter) leaseSeconds budget. For an
  // activation-basis trial it is start+duration clamped to valid_until; for from_issue the trial
  // clock is valid_until itself (set at stamp time). null => omit the field.
  const trialDeadline = trial.trial
    ? trialActivationExpiry !== null
      ? clampToValidUntil(row, trialActivationExpiry)
      : validUntil
    : null;
  const skewDays = Number.parseInt(env.LEASE_SKEW_DAYS ?? "", 10);
  const effectiveSkewDays = Number.isInteger(skewDays) && skewDays >= 0 ? skewDays : LEASE_DEFAULT_SKEW_DAYS;
  const validFromEpoch = Math.max(0, now - effectiveSkewDays * 86400);

  // Write-once trial-activation stamp rides the SAME atomic batch as the cap insert (so the clock
  // only starts when a lease actually lands). Only built on the FIRST activation of an activation-
  // basis trial; idempotent re-activations (already started) and from_issue trials pass undefined.
  const trialStamp =
    trial.trial && trial.stamp ? buildTrialActivationStamp(env, body, trialLock, now) : undefined;

  let inserted: boolean;
  try {
    inserted = await atomicLeaseIssuance(env, body, row, now, validFromEpoch, validToEpoch, env.LEASE_SIGNING_KEY_ID, isolation, trialStamp);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (!inserted) return json({ ok: false, code: "device_limit_exceeded" }, 403);

  const fields = leaseCanonicalFields({
    project: body.project,
    feature: body.feature,
    keyId: env.LEASE_SIGNING_KEY_ID,
    validFrom: utcDateFromEpoch(validFromEpoch),
    validTo: utcDateFromEpoch(validToEpoch),
    clientSignature: body.hw_id,
    clientSignatureSourceStrength: body.hw_id
      ? body.client_signature_source_strength ?? "strong-disk-serial-or-uuid"
      : undefined,
    startVersion: body.start_version,
    endVersion: body.end_version,
  });

  let lic: string;
  try {
    lic = await signLeaseLicense(fields, env);
  } catch (error) {
    logEvent("error", "lease.signing_error", {
      request_id: requestId(request),
      error: error instanceof Error ? error.message : "unknown signing error",
    });
    return json({ ok: false, code: "lease_signing_error" }, 500);
  }

  // renew_by is a SOFT anomaly signal (preserves offline-tolerance): a client that has not
  // re-issued by then is surfaced server-side, but valid_to remains the hard offline limit.
  const renewBy = now + Math.floor(leaseSeconds / 2);
  const response: {
    ok: true;
    lic: string;
    server_time: number;
    renew_by: number;
    valid_to_epoch: number;
    trial?: true;
    trial_expires_at_epoch?: number;
  } = { ok: true, lic, server_time: now, renew_by: renewBy, valid_to_epoch: validToEpoch };
  // UNSIGNED trial telemetry in the envelope only. The signed v201/lccoa1 canonical payload is NOT
  // touched (a deferred P2 ABI change). trial_expires_at_epoch is the clamped trial deadline.
  if (trial.trial) {
    response.trial = true;
    if (trialDeadline !== null) response.trial_expires_at_epoch = trialDeadline;
  }
  await putLeaseIdempotent(env, body.request_id, response, now, isolation);
  return json(response);
}
