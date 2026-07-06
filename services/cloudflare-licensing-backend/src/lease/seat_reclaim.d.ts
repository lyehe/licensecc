import type { D1DatabaseLike, EntitlementKey } from "../entitlements/entitlement_mutation";

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
