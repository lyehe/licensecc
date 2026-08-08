import type { EntitlementKey } from "@licensecc/licensing-domain/entitlements/contracts";
import type { D1DatabaseLike } from "../d1/entitlement_mutation";

export interface ForceReleaseResult {
  released: number;
  seat_ids: string[];
}

export function forceReleaseLiveSeats(
  env: { DB: D1DatabaseLike },
  key: EntitlementKey,
  now: number,
  reason?: string,
): Promise<ForceReleaseResult>;
