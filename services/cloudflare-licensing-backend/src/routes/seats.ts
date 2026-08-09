import {
  SEAT_CHECKOUT_ATOMIC_SQL,
  seatCheckoutSqlOwned,
  seatHeartbeatSql,
  seatReleaseSqlOwned,
} from "../lease/issuance_sql.mjs";
import { json, requestId } from "@licensecc/cloudflare-runtime/http/kit";
import type { AssertionClaims, Env, ExecutionContextLike, IsolationBinding, RequestProof } from "../env.js";
import {
  SEAT_PROOF_PURPOSE,
  ALGORITHM,
  PURPOSE,
  VERSION,
  checkDeviceProof,
  clampToValidUntil,
  parseRequestProofFields,
  readJsonBody,
  requireString,
  resolveIsolation,
  safeDeviceKeyId,
  signAssertion,
} from "./verify.js";
import { parseDeviceProofMode } from "../security_modes.mjs";
import { leaseWithinValidity } from "./leases.js";
import { recordUsageEvent } from "./reports.js";
import { reclaimOvercapSeats, sweepLapsedSeats } from "../maintenance/index.js";

// ============================ Floating / concurrent licensing ============================
//
// A shared pool of N simultaneous seats per entitlement (design doc
// 2026-06-22-floating-concurrent-licensing.md). Online-required: the server is the live
// source of truth for who holds a seat. A held seat is a short-TTL lccoa1 assertion (the
// SAME token /v1/verify mints and the C++ online_verification already validates) that the
// client refreshes via heartbeat. Checkout is the race-free atomic cap counting LIVE seats;
// disconnected clients are reclaimed when their heartbeat deadline lapses. Borrowing is the
// bounded offline escape.

const SEAT_DEFAULT_GRACE_SEC = 900;

interface SeatEntitlementRow {
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  pool_size: number;
  heartbeat_grace_sec: number;
  max_borrow_sec: number;
  allow_overdraft: number;
  revocation_seq: number;
}

interface SeatRequestBody {
  project: string;
  feature: string;
  license_fingerprint: string;
  client_instance_id: string;
  nonce: string;
  seat_id?: string;
  borrow_seconds?: number;
  device_key_id?: string; // registered ECDSA device key (for the optional device proof)
  request_proof?: RequestProof;
}

function parseSeatBody(raw: unknown, needSeatId: boolean): SeatRequestBody | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const project = requireString(value.project);
  const feature = requireString(value.feature);
  const fingerprint = requireString(value.license_fingerprint);
  const clientInstance = requireString(value.client_instance_id);
  const nonce = requireString(value.nonce);
  if (project === null || feature === null || fingerprint === null || clientInstance === null || nonce === null) {
    return null;
  }
  const body: SeatRequestBody = {
    project,
    feature,
    license_fingerprint: fingerprint,
    client_instance_id: clientInstance,
    nonce,
  };
  const seatId = requireString(value.seat_id);
  if (needSeatId) {
    if (seatId === null) return null;
    body.seat_id = seatId;
  } else if (seatId !== null) {
    body.seat_id = seatId;
  }
  if (typeof value.borrow_seconds === "number" && Number.isInteger(value.borrow_seconds) && value.borrow_seconds > 0) {
    body.borrow_seconds = value.borrow_seconds;
  }
  const deviceKeyId = safeDeviceKeyId(value.device_key_id);
  if (deviceKeyId !== null) body.device_key_id = deviceKeyId;
  const proofResult = parseRequestProofFields(value, deviceKeyId);
  if (proofResult.invalid) return null; // proof fields present but malformed -> reject
  if (proofResult.proof !== undefined) body.request_proof = proofResult.proof;
  return body;
}

async function lookupSeatEntitlement(env: Env, body: SeatRequestBody): Promise<SeatEntitlementRow | null> {
  return env.DB.prepare(
    "SELECT status, valid_from, valid_until, pool_size, heartbeat_grace_sec, max_borrow_sec, allow_overdraft, revocation_seq FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  )
    .bind(body.project, body.feature, body.license_fingerprint)
    .first<SeatEntitlementRow>();
}

async function signSeatToken(
  env: Env,
  body: SeatRequestBody,
  row: SeatEntitlementRow,
  now: number,
  deadline: number,
): Promise<string> {
  const claims: AssertionClaims = {
    purpose: PURPOSE,
    version: VERSION,
    alg: ALGORITHM,
    keyId: env.ONLINE_SIGNING_KEY_ID,
    project: body.project,
    feature: body.feature,
    licenseFingerprint: body.license_fingerprint,
    deviceHash: "",
    nonce: body.nonce,
    status: "ok",
    issuedAt: now,
    expiresAt: deadline,
    cacheUntil: deadline,
    revocationSeq: row.revocation_seq ?? 0,
  };
  return signAssertion(claims, env);
}

// Seat signing-availability check. Authn is now the per-customer accountAuth() gate (account-token
// isolation), called separately by each seat handler so the customerId can be bound into the
// mutating seat SQL. The legacy LEASE_ISSUE_BEARER bearer is handled inside accountAuth (off mode).
function seatSigningUnavailable(env: Env): Response | null {
  if (!env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM || !env.ONLINE_SIGNING_KEY_ID) {
    return json({ ok: false, code: "seat_signing_unavailable" }, 503);
  }
  return null;
}

export async function handleSeatCheckout(request: Request, env: Env, ctx?: ExecutionContextLike, isolationOverride?: IsolationBinding): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  if (!parseDeviceProofMode(env).valid) {
    return json({ ok: false, code: "config_error" }, 503);
  }
  const gate = seatSigningUnavailable(env);
  if (gate !== null) return gate;

  const rawBody = await readJsonBody(request);
  if (!rawBody.ok) return json({ ok: false, code: rawBody.code }, rawBody.status);
  const body = parseSeatBody(rawBody.value, /*needSeatId=*/ false);
  if (body === null) return json({ ok: false, code: "invalid_request" }, 400);

  const isolation = await resolveIsolation(request, env, "checkout", body.project, body.feature, now, ctx, isolationOverride);
  if ("ok" in isolation) return json({ ok: false, code: isolation.code }, isolation.status);

  let row: SeatEntitlementRow | null;
  try {
    row = await lookupSeatEntitlement(env, body);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (row === null || row.status !== "active" || !leaseWithinValidity(row, now)) {
    return json({ ok: false, code: "no_active_entitlement" }, 403);
  }
  if (row.pool_size <= 0) return json({ ok: false, code: "floating_disabled" }, 403);

  // Device-proof gate (relay-resistance): a presented proof binds the seat to a registered device
  // key; required mode denies a seat without one. The seat nonce doubles as the proof nonce.
  const seatProof = await checkDeviceProof(
    env,
    { project: body.project, feature: body.feature, license_fingerprint: body.license_fingerprint, device_hash: "", nonce: body.nonce, client_hardening: 0 },
    body.request_proof,
    now,
    SEAT_PROOF_PURPOSE,
  );
  if (!seatProof.ok) return json({ ok: false, code: seatProof.code }, seatProof.code === "config_error" ? 503 : 403);

  // Live by default; borrow only when the entitlement permits it, bounded by max_borrow_sec.
  let mode = "live";
  const grace = row.heartbeat_grace_sec > 0 ? row.heartbeat_grace_sec : SEAT_DEFAULT_GRACE_SEC;
  let deadline = now + grace;
  if (body.borrow_seconds !== undefined) {
    if (row.max_borrow_sec <= 0) return json({ ok: false, code: "borrowing_disabled" }, 403);
    mode = "borrowed";
    deadline = now + Math.min(body.borrow_seconds, row.max_borrow_sec);
  }
  // T7 revocation SLA — clamp the seat deadline (the signed token's offline expiry) to the
  // entitlement's valid_until. Otherwise a borrowed seat (no heartbeat to deny it) would hold a
  // signed offline token granting access up to max_borrow_sec PAST the entitlement expiry. After
  // the clamp, no seat token ever grants access beyond valid_until.
  deadline = clampToValidUntil(row, deadline);

  const ceiling = row.pool_size + (row.allow_overdraft > 0 ? row.allow_overdraft : 0);
  const seatId = crypto.randomUUID();
  let granted: boolean;
  try {
    // off => original pool guard (customerId null can't bind an owned EXISTS); soft/required =>
    // the owned guard folds the ownership EXISTS (customer_id + status='active' + validity) into
    // the SAME atomic pool-cap statement (the pool COUNT subquery stays tuple-scoped).
    const inserted =
      isolation.mode === "off"
        ? await env.DB.prepare(SEAT_CHECKOUT_ATOMIC_SQL)
            .bind(
              body.project,
              body.feature,
              body.license_fingerprint,
              seatId,
              body.client_instance_id,
              mode,
              now,
              deadline,
              body.project,
              body.feature,
              body.license_fingerprint,
              now,
              ceiling,
            )
            .first<{ seat_id: string }>()
        : await env.DB.prepare(seatCheckoutSqlOwned(isolation.mode))
            .bind(
              body.project,
              body.feature,
              body.license_fingerprint,
              seatId,
              body.client_instance_id,
              mode,
              now,
              deadline,
              body.project,
              body.feature,
              body.license_fingerprint,
              now,
              ceiling,
              // EXISTS ownership binds: project, feature, fingerprint, customer_id, now, now.
              body.project,
              body.feature,
              body.license_fingerprint,
              isolation.customerId,
              now,
              now,
            )
            .first<{ seat_id: string }>();
    granted = inserted !== null;
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (!granted) {
    await recordUsageEvent(env, {
      project: body.project,
      feature: body.feature,
      fingerprint: body.license_fingerprint,
      event_type: "denied",
      reason: "pool_exhausted",
      ts: now,
    });
    return json({ ok: false, code: "pool_exhausted" }, 409);
  }

  await recordUsageEvent(env, {
    project: body.project,
    feature: body.feature,
    fingerprint: body.license_fingerprint,
    event_type: "checkout",
    seat_id: seatId,
    // The PROVEN device key (present only with a verified proof), not the attacker-chosen
    // client_instance_id, so unique_devices counts cryptographically-verified devices.
    device_key_id: body.request_proof !== undefined ? body.device_key_id : undefined,
    ts: now,
  });

  // Lazy reclamation on the hot path; a Cron Trigger (scheduled, below) also sweeps so idle
  // entitlements with no further checkouts still get their seats reclaimed promptly. T7: also
  // reclaim seats above a downgraded pool ceiling so a capacity cut takes effect promptly.
  await sweepLapsedSeats(env, now);
  await reclaimOvercapSeats(env, now);

  let assertion: string;
  try {
    assertion = await signSeatToken(env, body, row, now, deadline);
  } catch {
    return json({ ok: false, code: "seat_signing_error" }, 500);
  }
  return json({
    ok: true,
    assertion,
    seat_id: seatId,
    mode,
    server_time: now,
    expires_at: deadline,
    heartbeat_in: Math.max(1, Math.floor(grace / 3)),
  });
}

export async function handleSeatHeartbeat(request: Request, env: Env, ctx?: ExecutionContextLike, isolationOverride?: IsolationBinding): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const gate = seatSigningUnavailable(env);
  if (gate !== null) return gate;

  const rawBody = await readJsonBody(request);
  if (!rawBody.ok) return json({ ok: false, code: rawBody.code }, rawBody.status);
  const body = parseSeatBody(rawBody.value, /*needSeatId=*/ true);
  if (body === null || body.seat_id === undefined) return json({ ok: false, code: "invalid_request" }, 400);

  const isolation = await resolveIsolation(request, env, "heartbeat", body.project, body.feature, now, ctx, isolationOverride);
  if ("ok" in isolation) return json({ ok: false, code: isolation.code }, isolation.status);

  let row: SeatEntitlementRow | null;
  try {
    row = await lookupSeatEntitlement(env, body);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (row === null || row.status !== "active" || !leaseWithinValidity(row, now)) {
    return json({ ok: false, code: "no_active_entitlement" }, 403);
  }

  const grace = row.heartbeat_grace_sec > 0 ? row.heartbeat_grace_sec : SEAT_DEFAULT_GRACE_SEC;
  // T7: clamp the refreshed deadline (and the signed token's expiry) to valid_until, so a heartbeat
  // taken just before expiry never grants offline access past the entitlement window.
  const deadline = clampToValidUntil(row, now + grace);
  // Refresh only a still-live, non-borrowed seat; a reclaimed/expired seat yields no row. T7: the
  // UPDATE now re-asserts status='active'+validity atomically (off omits the customer conjunct;
  // soft/required add it so A can never heartbeat B's seat), closing the revoke/expire TOCTOU the
  // pre-read alone left open. Bind order: deadline, project, feature, fingerprint, seat_id, now,
  // now, now [, customer_id for soft/required].
  let refreshed: boolean;
  try {
    const binds: unknown[] = [deadline, body.project, body.feature, body.license_fingerprint, body.seat_id, now, now, now];
    if (isolation.mode !== "off") {
      binds.push(isolation.customerId);
    }
    const updated = await env.DB.prepare(seatHeartbeatSql(isolation.mode)).bind(...binds).first<{ seat_id: string }>();
    refreshed = updated !== null;
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (!refreshed) return json({ ok: false, code: "seat_reclaimed" }, 410);

  let assertion: string;
  try {
    assertion = await signSeatToken(env, body, row, now, deadline);
  } catch {
    return json({ ok: false, code: "seat_signing_error" }, 500);
  }
  return json({
    ok: true,
    assertion,
    seat_id: body.seat_id,
    server_time: now,
    expires_at: deadline,
    heartbeat_in: Math.max(1, Math.floor(grace / 3)),
  });
}

export async function handleSeatRelease(request: Request, env: Env, ctx?: ExecutionContextLike, isolationOverride?: IsolationBinding): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const rawBody = await readJsonBody(request);
  if (!rawBody.ok) return json({ ok: false, code: rawBody.code }, rawBody.status);
  const body = parseSeatBody(rawBody.value, /*needSeatId=*/ true);
  if (body === null || body.seat_id === undefined) return json({ ok: false, code: "invalid_request" }, 400);

  const isolation = await resolveIsolation(request, env, "release", body.project, body.feature, now, ctx, isolationOverride);
  if ("ok" in isolation) return json({ ok: false, code: isolation.code }, isolation.status);

  let removed: boolean;
  try {
    // off => original DELETE; soft/required => the owned DELETE adds an ownership EXISTS so A can
    // never free B's seat (0 rows freed for a wrong/NULL owner; the {ok:true} stays idempotent).
    // Bind order: project, feature, fingerprint, seat_id, customer_id.
    const deleted =
      isolation.mode === "off"
        ? await env.DB.prepare(
            "DELETE FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id = ? RETURNING seat_id",
          )
            .bind(body.project, body.feature, body.license_fingerprint, body.seat_id)
            .first<{ seat_id: string }>()
        : await env.DB.prepare(seatReleaseSqlOwned(isolation.mode))
            .bind(body.project, body.feature, body.license_fingerprint, body.seat_id, isolation.customerId)
            .first<{ seat_id: string }>();
    removed = deleted !== null;
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  // Only record a release that actually freed a seat. A seat already reclaimed by the sweep (the
  // routine lapse-then-release-on-shutdown lifecycle) must NOT emit a second end event -- that
  // phantom -1 undercounts peak_concurrent. The HTTP response stays idempotent regardless.
  if (removed) {
    await recordUsageEvent(env, {
      project: body.project,
      feature: body.feature,
      fingerprint: body.license_fingerprint,
      event_type: "release",
      seat_id: body.seat_id,
      ts: now,
    });
  }
  return json({ ok: true, server_time: now });
}
