// Types for the shared entitlement-mutation core (entitlement_mutation.mjs).
// Co-located so the admin's tsc resolves them via the backend package's
// `exports` map `types` condition without needing `allowJs`.

export interface EntitlementKey {
  project: string;
  feature: string;
  license_fingerprint: string;
}

export function entitlementId(project: string, feature: string, licenseFingerprint: string): string;
export function decodeEntitlementId(id: string): EntitlementKey | null;
