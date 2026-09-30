// Canonical definitions for these four entitlement data types now live in the
// shared mutation core's .d.ts so the admin Worker and the licensing backend
// share ONE shape. Re-exported here so existing `../shared/api` import sites are
// unchanged.
import type { EntitlementStatus, EntitlementInput, EntitlementEventType, EntitlementPatch } from "@licensecc/licensing-domain/entitlements/contracts";
import type { WebhookTestStatusClass } from "@licensecc/cloudflare-runtime/webhooks/webhook_endpoint";

export type {
  EntitlementStatus,
  EntitlementRecord,
  EntitlementInput,
  EntitlementPatch,
} from "@licensecc/licensing-domain/entitlements/contracts";

export type {
  CatalogImportApplyInput,
  CatalogImportApplyResult,
  CatalogImportEffect,
  CatalogImportEffectCounter,
  CatalogImportEffects,
  CatalogImportManifest,
  CatalogImportPreviewResponse,
  CatalogImportStatus,
  NormalizedCatalogImportManifest,
} from "@licensecc/licensing-domain/catalog/import_preview";

export type {
  PlanProjectionApplyInput,
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionItem,
  PlanProjectionPreview,
  PlanProjectionPreviewResponse,
} from "@licensecc/licensing-domain/catalog/plan_projection";

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

/**
 * A sync body. Every synced grant is protected, so it names the customer who owns it and that
 * customer's license.
 */
export interface EntitlementSyncInput extends Omit<EntitlementInput, "customer_id" | "license_id"> {
  customer_id: string;
  license_id: string;
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
  /** Device limit override; null takes the limit from the policy (or 1 without one). */
  max_active_devices: number | null;
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
  max_active_devices?: number | null;
}

// ── License-policy templates (Stage 3) ───────────────────────────────────────
// Mirrors entitlement_policies + the policy.mjs stamp shape. A
// policy is a frozen stamp-time template: stamping copies the defaults onto a new
// entitlement (which is thereafter its own source of truth). The canonical Policy /
// stamp types live in the backend package's policy.d.ts; these re-declare only the
// admin-facing CRUD request/response shapes.
export type PolicyType = "trial" | "node_locked" | "subscription";
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
  max_active_devices: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
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
  max_active_devices?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  notes?: string;
}

// Patch body. project/name/type/status are NOT patchable (name/type are frozen
// identity; status flips only through disable/reenable). All fields optional.
export interface PolicyPatch {
  valid_from_offset_sec?: number | null;
  duration_sec?: number | null;
  max_active_devices?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  notes?: string;
}

// ── Workstream C: bulk transition + global search response shapes ─────────────
// The admin Worker's POST /api/admin/entitlements/batch returns one row per input id (input order);
// a bad row never aborts the others, so each carries its own ok/code.
//
// This is deliberately service-local rather than a licensing-domain limit: it
// bounds one admin Worker operation's D1 request budget and its 8 KiB JSON
// parser budget. Keep every caller on this exported contract; do not silently
// raise the cap in a UI-only path.
export const ENTITLEMENT_BATCH_MAX_IDS = 4;
export const ENTITLEMENT_BATCH_TOO_LARGE_CODE = "entitlement_batch_too_large";
export const ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE = "split the request into batches of at most 4 entitlement ids";

export interface EntitlementBatchTooLargeData {
  max_ids: typeof ENTITLEMENT_BATCH_MAX_IDS;
  guidance: typeof ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE;
}

export interface BatchRowResult {
  id: string;
  ok: boolean;
  code: string;
}

export interface BatchResultData {
  results: BatchRowResult[];
}

// ── Protected onboarding ─────────────────────────────────────────────────────
// Why a protected entitlement create was refused: 409 protected_creation_conflict carries
// `data.reason`. The Worker derives it from the same named checks its create batch enforces;
// the UI maps each reason to a sentence, and OpenAPI documents this exact list.
export const PROTECTED_CREATE_REASONS = [
  "customer_inactive",
  "license_missing",
  "license_customer_mismatch",
  "fingerprint_in_use",
  "plan_assignment_conflict",
  "policy_mismatch",
  "invalid_trial",
  "devices_connected",
  "invalid_capacity",
  "unknown",
] as const;
export type ProtectedCreateReason = typeof PROTECTED_CREATE_REASONS[number];

// ── Device limit ─────────────────────────────────────────────────────────────
// The most devices one license (entitlement) may have connected at once. An operator sets it from 1
// to MAX_DEVICE_LIMIT: on a create that selects no policy (a policy stamps its own), or alone in a
// PATCH. A protected grant refuses a limit below its connected devices (409 capacity_in_use).
export const MAX_DEVICE_LIMIT = 1_000_000;

/** Admin create body: the shared grant input plus its own device limit, accepted only without a policy. */
export type AdminEntitlementCreateInput = EntitlementInput & { max_active_devices?: number };

/** Admin PATCH body: the shared patch fields, or the device limit alone. */
export type AdminEntitlementPatch = EntitlementPatch & { max_active_devices?: number };

/** 409 capacity_in_use: how many devices hold a slot on the grant (active, or retiring until the hold ends). */
export interface CapacityInUseData {
  devices_in_use: number;
}

// POST /api/admin/customers/{id}/licenses returns the license record it created.
export interface CreatedLicense {
  id: string;
  customer_id: string;
  project: string;
  label: string;
  created_at: number;
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

// ── Webhook endpoint CRUD + delivery status ───────────────────────────────────
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

// POST /api/admin/webhooks/{id}/test data: the backend sends the signed test event and only the
// receiver's status class ever comes back.
export interface WebhookTestResult {
  status_class: WebhookTestStatusClass;
}

// ── Workstream F: reports ────────────────────────────────────────────────────
// Admin routes that read the SAME D1 the backend owns: a bucketed time-series of refused
// connections and fulfillment counts (for the inline-SVG charts), and an expiring-soon
// entitlement list.

// GET /api/admin/report/timeseries — one row per bucket over the [from,to] window. denials counts
// the protected device-limit refusals recorded in device_bound_denials.ts; fulfillment_events counts
// order_events.received_at.
export interface TimeseriesBucket {
  start: number;
  denials: number;
  fulfillment_events: number;
}

export interface TimeseriesData {
  from: number;
  to: number;
  bucket_seconds: number;
  buckets: TimeseriesBucket[];
}

// GET /api/admin/report/expiring — active entitlements expiring in (now, now+within]. For most
// grants that window is against the stamped valid_until; an activated activation-basis trial
// (trial_started_at set) reports trial_started_at + trial_duration_sec instead, since that is its
// real deadline even when valid_until was never stamped. days_left is the ceil of
// (valid_until - now) / 86400 so "0 days left" never appears for a future row. id is the entitlement's
// canonical id (project+feature+license_fingerprint), for deep-linking the exact record.
export interface ExpiringEntitlement {
  id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  customer_id: string | null;
  customer_name: string | null;
  valid_until: number;
  days_left: number;
}

export interface ExpiringData {
  items: ExpiringEntitlement[];
  next_cursor: string | null;
}
