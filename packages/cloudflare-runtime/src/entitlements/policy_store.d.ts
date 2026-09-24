import type { EntitlementKey } from "@licensecc/licensing-domain/entitlements/contracts";
import type { PolicyCapacity, PolicyTrialState } from "@licensecc/licensing-domain/entitlements/policy";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../d1/entitlement_mutation";

export function buildPolicyStampStatement(
  env: { DB: D1DatabaseLike },
  key: EntitlementKey,
  policyId: string,
  capacity: PolicyCapacity,
  trial: PolicyTrialState,
): D1PreparedStatementLike;

/** A create's own device limit, written only beside the create's claimed row (changes() = 1). */
export function buildDeviceLimitStatement(
  env: { DB: D1DatabaseLike },
  key: EntitlementKey,
  maxActiveDevices: number,
): D1PreparedStatementLike;
