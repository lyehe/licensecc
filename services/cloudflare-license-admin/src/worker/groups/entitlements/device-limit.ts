import type { CapacityInUseData, EntitlementRecord } from "../../../shared/api.js";
import type { Env } from "../../env.js";
import { envelope } from "../../responses.js";
import { setEntitlementCapacity, type EntitlementKey, type IdempotencyCommit, type MutationContext, type MutationResult } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { boundOccupiedSql } from "@licensecc/cloudflare-runtime/device/bound_capacity";

// A PATCH that sets the device limit goes through the runtime's capacity chokepoint, alone: it is
// its own audited write, so it cannot be made atomic with the entitlement body's PATCH. ADR 0006
// keeps a protected grant's limit at or above its connected devices; the schema trigger refuses a
// lower one with capacity_in_use, and the answer says how many devices hold a slot, counted with
// the same occupancy rule the trigger and the lease path use.
export async function patchDeviceLimit(env: Env, key: EntitlementKey, limit: number, ctx: MutationContext,
  idempotency: IdempotencyCommit | null): Promise<MutationResult<EntitlementRecord> | Response | null> {
  try {
    return await setEntitlementCapacity(env, key, { max_active_devices: limit }, ctx, idempotency);
  } catch (error) {
    if (!(error instanceof Error) || !/capacity_in_use/i.test(error.message)) throw error;
    // The refused batch rolled back, so this read-only count is advisory: devices may connect or
    // disconnect between the refusal and the answer. mutationResponse never caches this Response.
    const occupied = await env.DB.prepare(`SELECT count(*) AS devices_in_use FROM device_bound_bindings b
      WHERE b.project=? AND b.feature=? AND b.license_fingerprint=? AND ${boundOccupiedSql("b", "unixepoch()")}`)
      .bind(key.project, key.feature, key.license_fingerprint).first<CapacityInUseData>();
    const data: CapacityInUseData = { devices_in_use: Number(occupied?.devices_in_use ?? 0) };
    return envelope(ctx.requestId, "capacity_in_use", data, 409);
  }
}
