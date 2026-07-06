// Canonical definitions for these four entitlement data types now live in the
// shared mutation core's .d.ts so the admin Worker and the licensing backend
// share ONE shape. Re-exported here so existing `../shared/api` import sites are
// unchanged.
export type {
  EntitlementStatus,
  EntitlementRecord,
  EntitlementInput,
  EntitlementPatch,
  DeviceStatus,
  EntitlementDeviceRecord,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

export type {
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionItem,
  PlanProjectionPreview,
} from "@licensecc/cloudflare-licensing-backend/catalog/plan_projection";

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

// ── Product catalog plans ────────────────────────────────────────────────────
// Catalog rows are configuration: feature definitions, commercial plans, and the
// feature/add-on rows that project a plan into concrete policy-stamped entitlements.
export type CatalogStatus = "active" | "disabled";
export type CatalogFeatureInclusion = "included" | "addon";

export interface CatalogFeature {
  id: string;
  project: string;
  feature_key: string;
  name: string;
  description: string;
  category: string;
  status: CatalogStatus;
  created_at: number;
  updated_at: number;
}

export interface CatalogFeatureInput {
  project: string;
  feature_key: string;
  name: string;
  description?: string;
  category?: string;
  status?: CatalogStatus;
}

export interface CatalogFeaturePatch {
  name?: string;
  description?: string;
  category?: string;
}

export interface CatalogPlan {
  id: string;
  project: string;
  plan_key: string;
  name: string;
  status: CatalogStatus;
  version: number;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface CatalogPlanInput {
  project: string;
  plan_key: string;
  name: string;
  description?: string;
  status?: CatalogStatus;
  version?: number;
}

export interface CatalogPlanPatch {
  name?: string;
  description?: string;
}

export interface CatalogPlanFeature {
  project: string;
  plan_id: string;
  plan_key: string;
  feature_key: string;
  feature_name: string;
  feature_inclusion: CatalogFeatureInclusion;
  addon_key: string | null;
  policy_id: string | null;
  status: CatalogStatus;
  display_order: number;
  assertion_ttl_seconds: number | null;
  pool_size: number | null;
  max_active_devices: number | null;
  max_borrow_sec: number | null;
  meter_quota: number | null;
  meter_period_sec: number | null;
  created_at: number;
  updated_at: number;
}

export interface CatalogPlanFeatureInput {
  project: string;
  feature_key: string;
  feature_inclusion?: CatalogFeatureInclusion;
  addon_key?: string | null;
  policy_id?: string | null;
  status?: CatalogStatus;
  display_order?: number;
  assertion_ttl_seconds?: number | null;
  pool_size?: number | null;
  max_active_devices?: number | null;
  max_borrow_sec?: number | null;
  meter_quota?: number | null;
  meter_period_sec?: number | null;
}

export interface CatalogPlanImport extends CatalogPlanInput {
  features?: CatalogPlanFeatureInput[];
}

export interface CatalogImportManifest {
  format_version?: 1;
  features: CatalogFeatureInput[];
  plans: CatalogPlanImport[];
}

export interface CatalogImportCounter {
  created: number;
  updated: number;
  unchanged: number;
}

export interface CatalogImportResult {
  features: CatalogImportCounter;
  plans: CatalogImportCounter;
  plan_features: CatalogImportCounter;
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
  meter_quota: number;
  meter_period_sec: number;
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
// Explicit node_locked policies require pool_size=0; explicit floating policies require pool_size>0.
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
  meter_quota?: number;
  meter_period_sec?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  notes?: string;
}

// Patch body. project/name/type/status are NOT patchable (name/type are frozen
// identity; status flips only through disable/reenable). All fields optional.
// A pool_size patch must preserve the existing policy type's node_locked/floating invariant.
export interface PolicyPatch {
  valid_from_offset_sec?: number | null;
  duration_sec?: number | null;
  assertion_ttl_seconds?: number;
  pool_size?: number;
  max_active_devices?: number;
  max_borrow_sec?: number;
  meter_quota?: number;
  meter_period_sec?: number;
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
  // Per-tenant scope (audit R2.2). null/"" = global (all events). When set, the endpoint receives
  // only events carrying + matching that dimension. Set one dimension, not both (events are single-
  // dimension): scope_project matches entitlement/order events; scope_customer_id matches customer events.
  scope_project: string | null;
  scope_customer_id: string | null;
}

// Create body. `url` is required and MUST be https (else 400 invalid_url). event_types
// (csv filter; "" = all) and description take the column default when omitted. scope_* omitted = global.
export interface WebhookEndpointInput {
  url: string;
  event_types?: string;
  description?: string;
  scope_project?: string;
  scope_customer_id?: string;
}

// Patch body. Only url / event_types / description / scope_* are mutable. status flips only via
// disable/reenable; id/created_at are immutable. All fields optional.
export interface WebhookEndpointPatch {
  url?: string;
  event_types?: string;
  description?: string;
  scope_project?: string;
  scope_customer_id?: string;
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

// ── Workstream F: usage-analytics reports + the stuck-seat force-release lever ─
// Three new admin routes that read the SAME D1 the backend owns: a bucketed usage
// time-series + fulfillment counts (for the inline-SVG charts), an expiring-soon
// entitlement list, and an admin-only "release the seats stuck on a dead machine"
// force-release that mirrors the backend's reclaim discipline.

// GET /api/admin/report/timeseries — one row per bucket over the [from,to] window. checkouts /
// releases / denials come from usage_events.ts; fulfillment_events from order_events.received_at.
// denial_rate = denials / (checkouts + denials), 0 when the bucket saw neither.
export interface TimeseriesBucket {
  start: number;
  checkouts: number;
  releases: number;
  denials: number;
  denial_rate: number;
  fulfillment_events: number;
}

export interface TimeseriesData {
  from: number;
  to: number;
  bucket_seconds: number;
  buckets: TimeseriesBucket[];
}

// GET /api/admin/report/expiring — active entitlements whose valid_until falls in (now, now+within].
// days_left is the ceil of (valid_until - now) / 86400 so "0 days left" never appears for a future row.
export interface ExpiringEntitlement {
  project: string;
  feature: string;
  license_fingerprint: string;
  customer_id: string | null;
  valid_until: number;
  days_left: number;
}

export interface ExpiringData {
  items: ExpiringEntitlement[];
  next_cursor: string | null;
}

// POST /api/admin/entitlements/:id/release-seats — admin-only. Reclaims the LIVE seat_checkouts for
// the entitlement tuple and records one 'reclaim' usage_events row per seat (reason='force_release').
// 0 released is a valid idempotent success.
export interface ReleaseSeatsData {
  released: number;
  seat_ids: string[];
}
