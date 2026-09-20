// Input and observed-state guards for entitlement mutations. SQL/CAS and audit
// ownership remain in entitlement_mutation; no persistence is performed here.
export function assertExpectedEntitlement(row, ctx) {
  const expected = ctx.expectedEntitlement;
  if (expected !== undefined && (row.customer_id !== expected.customer_id || row.revocation_seq !== expected.revocation_seq)) {
    throw new Error("stale_transition");
  }
}

export const CAPACITY_COLUMNS = new Set([
  "max_active_devices",
  "lease_seconds",
  "rebind_window_sec",
  "pool_size",
  "heartbeat_grace_sec",
  "max_borrow_sec",
  "allow_overdraft",
  "meter_quota",
  "meter_period_sec",
]);

export function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
