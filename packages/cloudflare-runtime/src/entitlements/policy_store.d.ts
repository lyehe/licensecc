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
