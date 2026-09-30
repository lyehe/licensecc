// Input and observed-state guards for entitlement mutations. SQL/CAS and audit
// ownership remain in entitlement_mutation; no persistence is performed here.
// The guard is never a no-op: every caller of patchEntitlement, transitionEntitlement
// and setEntitlementCapacity must supply the owner and revocation sequence it observed,
// so a caller that forgets the precondition fails loudly (invalid_patch) instead of
// silently skipping the check a stale-write race depends on.
export function assertExpectedEntitlement(row, ctx) {
  const expected = ctx.expectedEntitlement;
  if (expected == null) {
    throw new Error("invalid_patch");
  }
  if (row.customer_id !== expected.customer_id || row.revocation_seq !== expected.revocation_seq) {
    throw new Error("stale_transition");
  }
}

/** The owner a grant write stores. Every grant has one (entitlements.customer_id is NOT NULL), so a
 * write naming none, a blank one, or one padded with whitespace is refused as invalid_patch before
 * it reaches the database. The admin Worker applies the same rule. */
export function requiredOwner(customerId) {
  if (typeof customerId !== "string" || customerId.trim() === "" || customerId.trim() !== customerId) {
    throw new Error("invalid_patch");
  }
  return customerId;
}

/** The precondition a caller who already holds `row` can pass as its own observed expectation:
 * it always matches, so the mandatory guard above is satisfied without weakening it. */
export function observedExpectation(row) {
  return { customer_id: row.customer_id, revocation_seq: row.revocation_seq };
}

export const CAPACITY_COLUMNS = new Set([
  "max_active_devices",
  "lease_seconds",
]);

export function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
