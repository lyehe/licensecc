// Canonical definitions for these four entitlement data types now live in the
// shared mutation core's .d.ts so the admin Worker and the licensing backend
// share ONE shape. Re-exported here so existing `../shared/api` import sites are
// unchanged.
export type {
  EntitlementStatus,
  EntitlementRecord,
  EntitlementInput,
  EntitlementPatch,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

import type { EntitlementStatus, EntitlementInput, EntitlementEventType } from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

export interface EntitlementEvent {
  id: number;
  project: string;
  feature: string;
  license_fingerprint: string;
  event_type: EntitlementEventType | "upsert" | "revoked-override";
  status: EntitlementStatus;
  revocation_seq: number;
  actor: string;
  actor_type: string;
  source: string;
  request_id: string;
  reason: string;
  created_at: number;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
}

export interface EntitlementSyncInput extends EntitlementInput {
  reason?: string;
}
