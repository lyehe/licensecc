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

// ── License-policy templates (Stage 3) ───────────────────────────────────────
// Mirrors entitlement_policies (migration 0018) + the policy.mjs stamp shape. A
// policy is a frozen stamp-time template: stamping copies the defaults onto a new
// entitlement (which is thereafter its own source of truth). The canonical Policy /
// stamp types live in the backend package's policy.d.ts; these re-declare only the
// admin-facing CRUD request/response shapes.
export type PolicyType = "trial" | "node_locked" | "floating" | "subscription";
export type PolicyStatus = "active" | "disabled";
export type ExpiryStrategy = "fixed_window" | "non_expiring";
export type TrialExpirationBasis = "from_issue" | "from_first_activation" | "from_first_use";

export interface Policy {
  id: string;
  project: string;
  name: string;
  type: PolicyType;
  status: PolicyStatus;
  valid_from_offset_sec: number | null;
  duration_sec: number | null;
  assertion_ttl_seconds: number;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
  notes: string;
  created_at: number;
  updated_at: number;
}

// Create body. project/name/type are required; everything else takes the column default.
export interface PolicyInput {
  project: string;
  name: string;
  type: PolicyType;
  valid_from_offset_sec?: number | null;
  duration_sec?: number | null;
  assertion_ttl_seconds?: number;
  pool_size?: number;
  max_active_devices?: number;
  max_borrow_sec?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  notes?: string;
}

// Patch body. project/name/type/status are NOT patchable (name/type are frozen
// identity; status flips only through disable/reenable). All fields optional.
export interface PolicyPatch {
  valid_from_offset_sec?: number | null;
  duration_sec?: number | null;
  assertion_ttl_seconds?: number;
  pool_size?: number;
  max_active_devices?: number;
  max_borrow_sec?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  notes?: string;
}

// ── Workstream C: bulk transition + global search response shapes ─────────────
// The admin Worker's POST /api/admin/entitlements/batch returns one row per input id (input order);
// a bad row never aborts the others, so each carries its own ok/code.
export interface BatchRowResult {
  id: string;
  ok: boolean;
  code: string;
}

export interface BatchResultData {
  results: BatchRowResult[];
}

// GET /api/admin/search returns mixed-type rows; `type` + the type-specific identity fields drive
// the UI deep-link (see navigationForResult in operatorWorkflow.ts).
export type SearchResultType = "customer" | "license" | "entitlement" | "order";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  project?: string;
  feature?: string;
  license_fingerprint?: string;
  email?: string;
  status?: string;
  external_ref?: string | null;
  customer_id?: string | null;
}

export interface SearchData {
  results: SearchResult[];
}

// ── Webhook endpoint CRUD + delivery status (migration 0020) ──────────────────
// webhook_endpoints are operator-managed CONFIG rows (URL + a csv event_types filter).
// The signing secret is NEVER stored here — it lives only in the Worker-env
// WEBHOOK_SIGNING_SECRETS map (the repo forbids plaintext secrets in D1). The
// dispatcher (a strictly read-side cron-drained outbox in the licensing backend)
// enqueues + delivers; this admin surface only manages the endpoint rows and lets an
// operator inspect / redrive the webhook_deliveries outbox.
export type WebhookStatus = "active" | "disabled";

export interface WebhookEndpoint {
  id: string;
  url: string;
  event_types: string; // csv filter; "" = all event types
  status: WebhookStatus;
  description: string;
  created_at: number;
  updated_at: number;
}

// Create body. `url` is required and MUST be https (else 400 invalid_url). event_types
// (csv filter; "" = all) and description take the column default when omitted.
export interface WebhookEndpointInput {
  url: string;
  event_types?: string;
  description?: string;
}

// Patch body. Only url / event_types / description are mutable. status flips only via
// disable/reenable; id/created_at are immutable. All fields optional.
export interface WebhookEndpointPatch {
  url?: string;
  event_types?: string;
  description?: string;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";
export type WebhookEventSource = "entitlement" | "customer" | "order";

export interface WebhookDelivery {
  id: number;
  endpoint_id: string;
  event_source: WebhookEventSource;
  event_id: number;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_status: number;
  last_error: string;
  next_attempt_at: number;
  created_at: number;
  delivered_at: number | null;
}

// Optional frozen-trial + provenance columns surfaced on an entitlement record that
// was stamped from a policy. Read by dedicated SELECTs (not part of ENTITLEMENT_COLUMNS).
export interface EntitlementTrialFields {
  policy_id?: string | null;
  is_trial?: number;
  trial_expiration_basis?: TrialExpirationBasis | null;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  trial_started_at?: number | null;
  trial_device_hash?: string | null;
}
