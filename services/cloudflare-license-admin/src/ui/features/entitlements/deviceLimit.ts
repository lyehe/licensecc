import type { EntitlementRecord } from "../../../shared/api";
import { DEVICE_LIMIT_RULE, isDeviceLimit } from "./workflow";

// Setting a license (entitlement)'s device limit is its own PATCH: the limit alone, with the
// state the operator saw, so a grant changed in the meantime is refused rather than overwritten.

/** The validation message for a device limit, or null when it can be sent. */
export function deviceLimitError(value: number): string | null {
  return isDeviceLimit(value) ? null : DEVICE_LIMIT_RULE;
}

export function deviceLimitRequestBody(item: Pick<EntitlementRecord, "customer_id" | "revocation_seq">, limit: number): string {
  return JSON.stringify({ max_active_devices: limit, expected_customer_id: item.customer_id, expected_revocation_seq: item.revocation_seq });
}

/**
 * The operator's sentence for a refused device limit (409 capacity_in_use), or null for any other
 * failure. A protected grant keeps room for its connected devices, so the sentence says how many
 * are connected and how many to disconnect before the requested limit fits.
 */
export function deviceLimitFailureMessage(failure: { code: string; requestId: string; data?: unknown }, requested: number): string | null {
  if (failure.code !== "capacity_in_use") return null;
  const data = failure.data !== null && typeof failure.data === "object" ? failure.data as { devices_in_use?: unknown } : {};
  const connected = data.devices_in_use;
  if (typeof connected !== "number" || !Number.isSafeInteger(connected) || connected < 0) {
    return `More devices are connected than this limit allows; disconnect one first. Reference ${failure.requestId}.`;
  }
  const excess = connected - requested;
  return `${connected} ${connected === 1 ? "device is" : "devices are"} connected; disconnect ${excess > 1 ? excess : "one"} first. Reference ${failure.requestId}.`;
}
