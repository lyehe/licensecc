import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import { decodeEntitlementId, findEntitlement, listEntitlementDevices, transitionEntitlementDevice } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Actor, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { forceReleaseLiveSeats } from "@licensecc/cloudflare-runtime/lease/seat_reclaim";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody, safeNotes } from "../../request.js";
import { clientIp } from "../../support.js";
export async function handleReleaseSeats(request: Request, env: Env, actor: Actor, encodedId: string, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  if (reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "seats_released", async () => {
    const now = Math.floor(Date.now() / 1000);
    let released: { released: number; seat_ids: string[] };
    try {
      released = await forceReleaseLiveSeats(env, key, now);
    } catch {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    return { data: released, idempotencyRecorded: false };
  });
}

// GET /api/admin/entitlements/:id/devices (reader+admin). Lists the entitlement's registered
// relay-resistance device keys (entitlement_devices). 404 if the entitlement itself is absent, so a
// bad id is never silently an empty list.
export async function handleDeviceList(env: Env, encodedId: string, requestIdValue: string): Promise<Response> {
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const ent = await findEntitlement(env, key);
  if (ent === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const devices = await listEntitlementDevices(env, key);
  return envelope(requestIdValue, "devices_listed", { items: devices });
}

// GET /api/admin/entitlements/:id/meter (reader+admin). Reports the entitlement's metering quota +
// the CURRENT rolling period's units_consumed WITHOUT incrementing it — the review's "a billing
// counter observable only by incrementing it" gap. Reads the meter columns off entitlements +
// usage_meters directly (a SEPARATE projection; ENTITLEMENT_COLUMNS and the shared findEntitlement
// core are deliberately untouched). period_start is derived exactly as the writer (metering.mjs) does.
export async function handleMeterStatus(env: Env, encodedId: string, requestIdValue: string): Promise<Response> {
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const ent = await env.DB.prepare(
    "SELECT meter_quota, meter_period_sec FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  )
    .bind(key.project, key.feature, key.license_fingerprint)
    .first<{ meter_quota: number; meter_period_sec: number }>();
  if (ent === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const now = Math.floor(Date.now() / 1000);
  const periodSec = Number(ent.meter_period_sec) > 0 ? Number(ent.meter_period_sec) : 2592000;
  const periodStart = Math.floor(now / periodSec) * periodSec;
  const meter = await env.DB.prepare(
    "SELECT units_consumed FROM usage_meters WHERE project = ? AND feature = ? AND license_fingerprint = ? AND period_start = ? LIMIT 1",
  )
    .bind(key.project, key.feature, key.license_fingerprint, periodStart)
    .first<{ units_consumed: number }>();
  return envelope(requestIdValue, "meter_status", {
    meter_quota: Number(ent.meter_quota),
    meter_period_sec: periodSec,
    period_start: periodStart,
    period_end: periodStart + periodSec,
    units_consumed: Number(meter?.units_consumed ?? 0),
    server_time: now,
  });
}

const DEVICE_KEY_ID_RE = /^sha256:[0-9a-f]{64}$/;

// POST /api/admin/entitlements/:id/devices/:deviceKeyId/(revoke|disable|reenable) (ADMIN-ONLY; reason
// REQUIRED for revoke/disable). The console equivalent of the CLI device-revoke/device-disable: it
// flips ONE device key's status and bumps the entitlement's revocation_seq so the online-verify path
// refuses that device on its next proof-carrying check (pre-TTL, non-coarse revoke — closes the R6.1
// loop). transitionEntitlementDevice commits the device UPDATE + seq bump + audit event atomically.
export async function handleDeviceTransition(
  request: Request,
  env: Env,
  actor: Actor,
  encodedId: string,
  encodedDeviceKeyId: string,
  action: "revoke" | "disable" | "reenable",
  requestIdValue: string,
): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const deviceKeyId = decodeURIComponent(encodedDeviceKeyId);
  if (!DEVICE_KEY_ID_RE.test(deviceKeyId)) {
    return envelope(requestIdValue, "invalid_device_key_id", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  if ((action === "revoke" || action === "disable") && reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const ctx: MutationContext = {
    actor,
    requestId: requestIdValue,
    ip: clientIp(request),
    idempotencyKey: idempotencyKey ?? null,
    source: "admin",
  };
  const targetStatus = action === "revoke" ? "revoked" : action === "disable" ? "disabled" : "active";
  return mutationResponse(request, env, ctx, `device_${action}d`, (idempotency) =>
    transitionEntitlementDevice(env, key, deviceKeyId, targetStatus, reason, ctx, idempotency));
}
