import type { CatalogImportEffect, CatalogImportPreviewResponse } from "../../shared/api";
import { parseExactApiSuccess } from "./api";

type UnknownRecord = Record<string, unknown>;

export type MutationParseResult<T> =
  | { kind: "success"; code: string; requestId: string; data: T }
  | { kind: "failure"; code: string; requestId: string }
  | { kind: "invalid" };

/**
 * A mutation response can only be treated as definitely unapplied when its
 * route documents that exact status/code as a pre-mutation rejection.  The
 * same key replay is deliberately stricter: a later conflict says nothing
 * about whether an earlier ambiguous request committed.
 */
export type MutationPhase = "initial" | "replay";

export interface MutationFailureRule {
  readonly status: number;
  readonly codes: readonly string[];
}

export interface MutationFailurePolicy {
  readonly initial: readonly MutationFailureRule[];
  readonly replay: readonly MutationFailureRule[];
}

const mutationAuthFailures: readonly MutationFailureRule[] = [
  { status: 401, codes: ["missing_access_jwt", "admin_auth_not_configured"] },
  { status: 403, codes: ["invalid_access_jwt", "admin_role_denied", "admin_role_required"] },
];
const malformedBodyFailure: readonly MutationFailureRule[] = [{ status: 413, codes: ["body_too_large"] }];
const noDefinitiveFailure: MutationFailurePolicy = { initial: [], replay: [] };

function documentedMutationPolicy(...initial: readonly MutationFailureRule[]): MutationFailurePolicy {
  return {
    // These failures are only conclusive for the original request. A replay
    // happens after an unknown write may already have committed, so even a
    // later auth/body rejection cannot prove that original attempt was not
    // applied. Replays resolve only on an exact success response.
    initial: [...mutationAuthFailures, ...initial, ...malformedBodyFailure],
    replay: [],
  };
}

const invalidRequest = ["invalid_idempotency_key", "invalid_json", "invalid_request"] as const;
const reasonedRequest = [...invalidRequest, "reason_required"] as const;
// Device and force-release routes reject malformed identifiers/bodies, but
// their documented 400 envelopes intentionally do not include the generic
// `invalid_request` code used by other mutation families.
const deviceInvalidRequest = ["invalid_idempotency_key", "invalid_json"] as const;
const deviceReasonedRequest = [...deviceInvalidRequest, "reason_required"] as const;

/** Exact Worker/OpenAPI failure matrix for every keyed admin UI mutation. */
export const mutationFailurePolicies = {
  entitlementCreate: documentedMutationPolicy(
    { status: 400, codes: ["invalid_entitlement_id", ...invalidRequest, "policy_stamping_disabled"] },
    { status: 404, codes: ["not_found", "policy_not_found"] },
    { status: 409, codes: ["revoked_entitlement_is_terminal"] },
  ),
  entitlementPatch: documentedMutationPolicy(
    { status: 400, codes: ["invalid_entitlement_id", ...invalidRequest] },
    { status: 404, codes: ["not_found"] },
    { status: 409, codes: ["revoked_entitlement_is_terminal"] },
  ),
  entitlementTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: ["invalid_entitlement_id", ...reasonedRequest] },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["revoked_entitlement_is_terminal"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: ["invalid_entitlement_id", ...invalidRequest] },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["revoked_entitlement_is_terminal"] },
    ),
    revoke: documentedMutationPolicy(
      { status: 400, codes: ["invalid_entitlement_id", ...reasonedRequest] },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["revoked_entitlement_is_terminal"] },
    ),
  },
  entitlementBatch: {
    disable: documentedMutationPolicy(
      { status: 400, codes: ["invalid_idempotency_key", "invalid_json", "invalid_request", "entitlement_batch_too_large", "reason_required"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: ["invalid_idempotency_key", "invalid_json", "invalid_request", "entitlement_batch_too_large"] },
    ),
    revoke: documentedMutationPolicy(
      { status: 400, codes: ["invalid_idempotency_key", "invalid_json", "invalid_request", "entitlement_batch_too_large", "reason_required"] },
    ),
  },
  releaseSeats: documentedMutationPolicy(
    { status: 400, codes: ["invalid_entitlement_id", ...deviceReasonedRequest] },
  ),
  deviceTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: ["invalid_entitlement_id", "invalid_device_key_id", ...deviceReasonedRequest] },
      { status: 404, codes: ["not_found", "device_not_found"] },
      { status: 409, codes: ["device_is_terminal"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: ["invalid_entitlement_id", "invalid_device_key_id", ...deviceInvalidRequest] },
      { status: 404, codes: ["not_found", "device_not_found"] },
      { status: 409, codes: ["device_is_terminal"] },
    ),
    revoke: documentedMutationPolicy(
      { status: 400, codes: ["invalid_entitlement_id", "invalid_device_key_id", ...deviceReasonedRequest] },
      { status: 404, codes: ["not_found", "device_not_found"] },
      { status: 409, codes: ["device_is_terminal"] },
    ),
  },
  customerTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: reasonedRequest },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["customer_status_conflict"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: invalidRequest },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["customer_status_conflict"] },
    ),
  },
  policyCreate: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 409, codes: ["policy_name_conflict"] },
  ),
  policyPatch: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 404, codes: ["not_found"] },
  ),
  policyTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: reasonedRequest },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["policy_status_conflict"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: invalidRequest },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["policy_status_conflict"] },
    ),
  },
  webhookCreate: documentedMutationPolicy(
    { status: 400, codes: [...invalidRequest, "invalid_url"] },
  ),
  webhookPatch: documentedMutationPolicy(
    { status: 400, codes: [...invalidRequest, "invalid_url"] },
    { status: 404, codes: ["not_found"] },
  ),
  webhookTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: reasonedRequest },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["webhook_status_conflict"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: invalidRequest },
      { status: 404, codes: ["not_found"] },
      { status: 409, codes: ["webhook_status_conflict"] },
    ),
  },
  webhookRedrive: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 404, codes: ["not_found"] },
    { status: 409, codes: ["webhook_delivery_not_failed"] },
  ),
  catalogFeatureCreate: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 409, codes: ["catalog_feature_conflict"] },
  ),
  catalogFeaturePatch: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 404, codes: ["catalog_feature_not_found"] },
  ),
  catalogFeatureTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: reasonedRequest },
      { status: 404, codes: ["catalog_feature_not_found"] },
      { status: 409, codes: ["catalog_status_conflict"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: invalidRequest },
      { status: 404, codes: ["catalog_feature_not_found"] },
      { status: 409, codes: ["catalog_status_conflict"] },
    ),
  },
  catalogPlanCreate: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 409, codes: ["catalog_plan_conflict"] },
  ),
  catalogPlanPatch: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 404, codes: ["catalog_plan_not_found"] },
  ),
  catalogPlanTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: reasonedRequest },
      { status: 404, codes: ["catalog_plan_not_found"] },
      { status: 409, codes: ["catalog_status_conflict"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: invalidRequest },
      { status: 404, codes: ["catalog_plan_not_found"] },
      { status: 409, codes: ["catalog_status_conflict"] },
    ),
  },
  catalogImport: documentedMutationPolicy(
    { status: 400, codes: [...invalidRequest, "idempotency_key_required"] },
    { status: 404, codes: ["catalog_feature_not_found", "policy_not_found"] },
    {
      status: 409,
      codes: [
        "preview_required",
        "policy_disabled",
        "invalid_plan_config",
        "catalog_import_too_large",
        "catalog_import_snapshot_stale",
        "stale_catalog_import_preview",
        "expired_catalog_import_preview",
        "claimed_catalog_import_preview",
      ],
    },
  ),
  catalogPlanFeatureSave: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 404, codes: ["catalog_plan_not_found", "catalog_feature_not_found", "policy_not_found"] },
    { status: 409, codes: ["invalid_plan_config", "policy_disabled", "catalog_plan_feature_conflict"] },
  ),
  catalogPlanFeatureTransition: {
    disable: documentedMutationPolicy(
      { status: 400, codes: reasonedRequest },
      { status: 404, codes: ["catalog_plan_feature_not_found"] },
      { status: 409, codes: ["catalog_status_conflict"] },
    ),
    reenable: documentedMutationPolicy(
      { status: 400, codes: invalidRequest },
      { status: 404, codes: ["catalog_plan_feature_not_found"] },
      { status: 409, codes: ["catalog_status_conflict"] },
    ),
  },
  catalogProjectionApply: documentedMutationPolicy(
    { status: 400, codes: invalidRequest },
    { status: 409, codes: ["stale_projection_preview", "projection_preview_grant_expired", "license_fingerprint_conflict", "plan_projection_blocked"] },
  ),
  catalogProjectionPreview: documentedMutationPolicy(
    { status: 400, codes: ["invalid_json", "invalid_request", "unknown_addon"] },
    { status: 404, codes: ["plan_not_found", "policy_not_found"] },
    { status: 409, codes: ["plan_disabled", "policy_disabled", "invalid_plan_config", "license_fingerprint_conflict", "plan_projection_too_large"] },
  ),
} as const;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringField(value: UnknownRecord, field: string): boolean {
  return typeof value[field] === "string" && value[field] !== "";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function numberField(value: UnknownRecord, field: string): boolean {
  return typeof value[field] === "number" && Number.isSafeInteger(value[field]);
}

function nonNegativeIntegerField(value: UnknownRecord, field: string): boolean {
  return numberField(value, field) && (value[field] as number) >= 0;
}

function integerInRangeField(value: UnknownRecord, field: string, min: number, max: number): boolean {
  return numberField(value, field) && (value[field] as number) >= min && (value[field] as number) <= max;
}

function finiteNumberInRangeField(value: UnknownRecord, field: string, min: number, max: number): boolean {
  return typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= min && value[field] <= max;
}

function nullableIntegerField(value: UnknownRecord, field: string): boolean {
  return value[field] === null || numberField(value, field);
}

function nullableIntegerInRangeField(value: UnknownRecord, field: string, min: number, max: number): boolean {
  return value[field] === null || integerInRangeField(value, field, min, max);
}

function nullableStringField(value: UnknownRecord, field: string): boolean {
  return value[field] === null || typeof value[field] === "string";
}

function enumField<T extends string>(value: UnknownRecord, field: string, allowed: readonly T[]): boolean {
  return typeof value[field] === "string" && allowed.includes(value[field] as T);
}

function nullableEnumField<T extends string>(value: UnknownRecord, field: string, allowed: readonly T[]): boolean {
  return value[field] === null || enumField(value, field, allowed);
}

function binaryFlagField(value: UnknownRecord, field: string): boolean {
  return value[field] === 0 || value[field] === 1;
}

function statusField(value: UnknownRecord, expected: string): boolean {
  return value.status === expected;
}

function cursorField(value: UnknownRecord): boolean {
  return value.next_cursor === null || (typeof value.next_cursor === "string" && value.next_cursor !== "");
}

export function parseMutationResponse<T>(
  value: unknown,
  expectedCode: string,
  dataGuard: (value: unknown) => value is T,
  policy: MutationFailurePolicy = noDefinitiveFailure,
  phase: MutationPhase = "initial",
): MutationParseResult<T> {
  const envelope = record(value);
  const success = parseExactApiSuccess<T>(value, expectedCode, dataGuard);
  if (success !== null) {
    return { kind: "success", code: success.code, requestId: success.requestId, data: success.data };
  }

  // A response after a mutating request is only definitive when the Worker
  // explicitly rejected it before mutation.  In particular, a 5xx (even one
  // with a well-formed `{ ok: false }` envelope) may have happened after the
  // database commit and must retain the idempotency key for same-key replay.
  const documentedFailure = envelope?.__httpOk === false &&
    typeof envelope.__httpStatus === "number" &&
    policy[phase].some((rule) => rule.status === envelope.__httpStatus && rule.codes.includes(typeof envelope.code === "string" ? envelope.code : ""));
  if (envelope !== null && envelope.ok === false && documentedFailure && nonEmptyString(envelope.code) && nonEmptyString(envelope.request_id)) {
    return { kind: "failure", code: envelope.code, requestId: envelope.request_id };
  }
  return { kind: "invalid" };
}

const ENTITLEMENT_STATUSES = ["active", "disabled", "revoked"] as const;
const LICENSE_MODES = ["trial", "node_locked", "floating"] as const;
const DEVICE_STATUSES = ["active", "disabled", "revoked"] as const;
const CATALOG_STATUSES = ["active", "disabled"] as const;
const MAX_DURATION_SECONDS = 3_153_600_000;
const MAX_CAPACITY = 1_000_000;
const MAX_METER_QUOTA = 1_000_000_000;

export function hasEntitlementRecordData(value: unknown): boolean {
  const row = record(value);
  return row !== null &&
    stringField(row, "id") && stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") &&
    typeof row.device_hash === "string" && enumField(row, "status", ENTITLEMENT_STATUSES) && enumField(row, "license_mode", LICENSE_MODES) &&
    integerInRangeField(row, "assertion_ttl_seconds", 1, 3600) && nonNegativeIntegerField(row, "revocation_seq") &&
    nullableIntegerInRangeField(row, "valid_from", 0, Number.MAX_SAFE_INTEGER) && nullableIntegerInRangeField(row, "valid_until", 0, Number.MAX_SAFE_INTEGER) && typeof row.notes === "string" &&
    nullableStringField(row, "customer_id") && nullableStringField(row, "license_id") && nullableStringField(row, "policy_id") &&
    binaryFlagField(row, "is_trial") && nullableEnumField(row, "trial_expiration_basis", ["from_issue", "from_first_activation", "from_first_use"] as const) && integerInRangeField(row, "trial_duration_sec", 0, MAX_DURATION_SECONDS) &&
    binaryFlagField(row, "trial_one_per_device") && binaryFlagField(row, "trial_require_device_proof") && nullableIntegerInRangeField(row, "trial_started_at", 0, Number.MAX_SAFE_INTEGER) &&
    nullableStringField(row, "trial_device_hash") && integerInRangeField(row, "max_active_devices", 0, MAX_CAPACITY) && integerInRangeField(row, "lease_seconds", 0, MAX_DURATION_SECONDS) &&
    integerInRangeField(row, "rebind_window_sec", 0, MAX_DURATION_SECONDS) && integerInRangeField(row, "pool_size", 0, MAX_CAPACITY) && integerInRangeField(row, "heartbeat_grace_sec", 0, MAX_DURATION_SECONDS) &&
    integerInRangeField(row, "max_borrow_sec", 0, MAX_DURATION_SECONDS) && binaryFlagField(row, "allow_overdraft") && integerInRangeField(row, "meter_quota", 0, MAX_METER_QUOTA) &&
    integerInRangeField(row, "meter_period_sec", 0, MAX_DURATION_SECONDS) && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at");
}

export function hasEntitlementTransitionData(value: unknown, id: string, expectedStatus: string): boolean {
  const data = record(value);
  return hasEntitlementRecordData(data) && data !== null && data.id === id && statusField(data, expectedStatus);
}

export function hasCustomerTransitionData(value: unknown, id: string, expectedStatus: string): boolean {
  const data = record(value);
  // Customer transitions use `RETURNING` rather than the correlated list
  // projection.  The response therefore proves only the columns returned by
  // that mutation, not list-only entitlement counts.
  return data !== null && data.id === id && typeof data.name === "string" && typeof data.email === "string" && enumField(data, "status", ["active", "disabled"] as const) && statusField(data, expectedStatus) && typeof data.external_ref === "string" && nonNegativeIntegerField(data, "created_at") && nonNegativeIntegerField(data, "updated_at");
}

export function hasPolicyTransitionData(value: unknown, id: string, expectedStatus: string): boolean {
  const data = record(value);
  return data !== null && data.id === id && stringField(data, "project") && stringField(data, "name") && enumField(data, "type", ["trial", "node_locked", "floating", "subscription"] as const) && enumField(data, "status", CATALOG_STATUSES) && statusField(data, expectedStatus) && nullableIntegerInRangeField(data, "valid_from_offset_sec", -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS) && nullableIntegerInRangeField(data, "duration_sec", 0, MAX_DURATION_SECONDS) && integerInRangeField(data, "assertion_ttl_seconds", 1, 3600) && integerInRangeField(data, "pool_size", 0, MAX_CAPACITY) && integerInRangeField(data, "max_active_devices", 0, MAX_CAPACITY) && integerInRangeField(data, "max_borrow_sec", 0, MAX_DURATION_SECONDS) && integerInRangeField(data, "meter_quota", 0, MAX_METER_QUOTA) && integerInRangeField(data, "meter_period_sec", 0, MAX_DURATION_SECONDS) && enumField(data, "expiry_strategy", ["fixed_window", "non_expiring"] as const) && enumField(data, "trial_expiration_basis", ["from_issue", "from_first_activation", "from_first_use"] as const) && integerInRangeField(data, "trial_duration_sec", 0, MAX_DURATION_SECONDS) && binaryFlagField(data, "trial_one_per_device") && binaryFlagField(data, "trial_require_device_proof") && typeof data.notes === "string" && nonNegativeIntegerField(data, "created_at") && nonNegativeIntegerField(data, "updated_at");
}

export function hasWebhookTransitionData(value: unknown, id: string, expectedStatus: string): boolean {
  const data = record(value);
  return data !== null && data.id === id && stringField(data, "url") && typeof data.event_types === "string" && enumField(data, "status", CATALOG_STATUSES) && statusField(data, expectedStatus) && typeof data.description === "string" && nonNegativeIntegerField(data, "created_at") && nonNegativeIntegerField(data, "updated_at") && nullableStringField(data, "scope_project") && nullableStringField(data, "scope_customer_id");
}

export function hasCatalogFeatureTransitionData(value: unknown, id: string, expectedStatus: string): boolean {
  const data = record(value);
  return data !== null && data.id === id && stringField(data, "project") && stringField(data, "feature_key") && typeof data.name === "string" && enumField(data, "status", CATALOG_STATUSES) && statusField(data, expectedStatus) && typeof data.description === "string" && typeof data.category === "string" && nonNegativeIntegerField(data, "created_at") && nonNegativeIntegerField(data, "updated_at");
}

export function hasCatalogPlanTransitionData(value: unknown, id: string, expectedStatus: string): boolean {
  const data = record(value);
  return data !== null && data.id === id && stringField(data, "project") && stringField(data, "plan_key") && typeof data.name === "string" && enumField(data, "status", CATALOG_STATUSES) && statusField(data, expectedStatus) && integerInRangeField(data, "version", 1, MAX_CAPACITY) && typeof data.description === "string" && nonNegativeIntegerField(data, "created_at") && nonNegativeIntegerField(data, "updated_at");
}

export function hasCatalogPlanFeatureTransitionData(value: unknown, planId: string, featureKey: string, expectedStatus: string): boolean {
  const data = record(value);
  return data !== null && data.plan_id === planId && data.feature_key === featureKey && stringField(data, "project") && stringField(data, "plan_key") && stringField(data, "feature_name") && enumField(data, "feature_inclusion", ["included", "addon"] as const) && nullableStringField(data, "addon_key") && (data.feature_inclusion !== "addon" || stringField(data, "addon_key")) && nullableStringField(data, "policy_id") && enumField(data, "status", CATALOG_STATUSES) && statusField(data, expectedStatus) && integerInRangeField(data, "display_order", 0, MAX_CAPACITY) && nullableIntegerInRangeField(data, "assertion_ttl_seconds", 0, 3600) && nullableIntegerInRangeField(data, "pool_size", 0, MAX_CAPACITY) && nullableIntegerInRangeField(data, "max_active_devices", 0, MAX_CAPACITY) && nullableIntegerInRangeField(data, "max_borrow_sec", 0, MAX_DURATION_SECONDS) && nullableIntegerInRangeField(data, "meter_quota", 0, MAX_METER_QUOTA) && nullableIntegerInRangeField(data, "meter_period_sec", 0, MAX_DURATION_SECONDS) && nonNegativeIntegerField(data, "created_at") && nonNegativeIntegerField(data, "updated_at");
}

export function hasDeviceTransitionData(value: unknown, expected: { id: string; project: string; feature: string; license_fingerprint: string; status: string; revocation_seq: number }): boolean {
  const data = record(value);
  return hasEntitlementRecordData(data) && data !== null && data.id === expected.id && data.project === expected.project && data.feature === expected.feature && data.license_fingerprint === expected.license_fingerprint && statusField(data, expected.status) && (data.revocation_seq as number) > expected.revocation_seq;
}

export function hasReleaseSeatsData(value: unknown): value is { released: number; seat_ids: string[] } {
  const data = record(value);
  const released = data?.released;
  const seatIds = data?.seat_ids;
  const uniqueSeatIds = Array.isArray(seatIds) ? new Set(seatIds) : null;
  return data !== null && typeof released === "number" && Number.isSafeInteger(released) && released >= 0 && Array.isArray(seatIds) && uniqueSeatIds !== null && seatIds.length === released && uniqueSeatIds.size === released && seatIds.every((id) => typeof id === "string" && id !== "");
}

export function hasBatchResultsData(value: unknown, expectedIds: readonly string[], expectedCode: string): value is { results: Array<{ id: string; ok: boolean; code: string }> } {
  const data = record(value);
  if (data === null || !Array.isArray(data.results) || data.results.length !== expectedIds.length) {
    return false;
  }
  const ids = new Set(expectedIds);
  if (ids.size !== expectedIds.length) {
    return false;
  }
  const seen = new Set<string>();
  // The Worker returns an exact row for every requested id, in request order.
  // A row can be a documented terminal non-application while other rows in the
  // same batch succeeded; that is a known partial outcome, not an ambiguous
  // transport/mutation outcome.  Unknown codes or mixed-up identities remain
  // invalid because the UI cannot truthfully summarize them.
  const terminalFailureCodes = ["invalid_entitlement_id", "not_found", "revoked_entitlement_is_terminal", "mutation_failed"] as const;
  const valid = data.results.every((item, index) => {
    const row = record(item);
    if (row === null || typeof row.id !== "string" || row.id !== expectedIds[index] || !ids.has(row.id) || seen.has(row.id) || typeof row.ok !== "boolean" || typeof row.code !== "string" ||
      (row.ok === true && row.code !== expectedCode) || (row.ok === false && !terminalFailureCodes.includes(row.code as typeof terminalFailureCodes[number]))) {
      return false;
    }
    seen.add(row.id);
    return true;
  });
  return valid && seen.size === ids.size;
}

export function hasEntitlementListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => hasEntitlementRecordData(item));
}

export function hasDeviceListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") && stringField(row, "device_key_id") && enumField(row, "status", DEVICE_STATUSES) && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at") && nullableIntegerInRangeField(row, "last_seen_at", 0, Number.MAX_SAFE_INTEGER) && typeof row.notes === "string";
  });
}

export function hasMeterStatusData(value: unknown): boolean {
  const data = record(value);
  return data !== null &&
    integerInRangeField(data, "meter_quota", 0, MAX_METER_QUOTA) &&
    integerInRangeField(data, "meter_period_sec", 0, MAX_DURATION_SECONDS) &&
    nonNegativeIntegerField(data, "period_start") &&
    nonNegativeIntegerField(data, "period_end") &&
    (data.period_end as number) >= (data.period_start as number) &&
    nonNegativeIntegerField(data, "units_consumed") &&
    nonNegativeIntegerField(data, "server_time");
}

export function hasCustomerDetailData(value: unknown, id?: string): boolean {
  const data = record(value);
  const customer = record(data?.customer);
  const customerEntitlements = data !== null && Array.isArray(data.entitlements) && data.entitlements.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") && enumField(row, "status", ENTITLEMENT_STATUSES) && nullableIntegerInRangeField(row, "valid_from", 0, Number.MAX_SAFE_INTEGER) && nullableIntegerInRangeField(row, "valid_until", 0, Number.MAX_SAFE_INTEGER) && nonNegativeIntegerField(row, "revocation_seq") && nonNegativeIntegerField(row, "updated_at");
  });
  const accountTokens = data !== null && Array.isArray(data.account_tokens) && data.account_tokens.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && stringField(row, "token_prefix") && typeof row.name === "string" && enumField(row, "status", ["active", "disabled", "revoked"] as const) && typeof row.scopes_json === "string" && nullableIntegerInRangeField(row, "expires_at", 0, Number.MAX_SAFE_INTEGER) && nullableIntegerInRangeField(row, "last_used_at", 0, Number.MAX_SAFE_INTEGER) && nonNegativeIntegerField(row, "created_at");
  });
  const licenses = data !== null && Array.isArray(data.licenses) && data.licenses.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && stringField(row, "project") && typeof row.label === "string" && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at");
  });
  const orders = data !== null && Array.isArray(data.orders) && data.orders.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "subscription_id") && stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") && nonNegativeIntegerField(row, "last_seq") && nonNegativeIntegerField(row, "order_epoch") && nonNegativeIntegerField(row, "updated_at");
  });
  const events = data !== null && Array.isArray(data.events) && data.events.every((item) => {
    const row = record(item);
    return row !== null && nonNegativeIntegerField(row, "id") && stringField(row, "event_type") && typeof row.prev_status === "string" && typeof row.next_status === "string" && stringField(row, "actor") && stringField(row, "actor_type") && typeof row.reason === "string" && nonNegativeIntegerField(row, "created_at");
  });
  return data !== null && customer !== null && (id === undefined || customer.id === id) && stringField(customer, "id") && typeof customer.name === "string" && typeof customer.email === "string" && enumField(customer, "status", ["active", "disabled"] as const) && typeof customer.external_ref === "string" && typeof customer.metadata_json === "string" && nonNegativeIntegerField(customer, "created_at") && nonNegativeIntegerField(customer, "updated_at") && customerEntitlements && accountTokens && licenses && orders && events;
}

export function hasCustomerListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && typeof row.name === "string" && typeof row.email === "string" && enumField(row, "status", ["active", "disabled"] as const) && typeof row.external_ref === "string" && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at") && nonNegativeIntegerField(row, "entitlement_count") && nonNegativeIntegerField(row, "active_entitlement_count") && (row.active_entitlement_count as number) <= (row.entitlement_count as number);
  });
}

/** Reuse the strict list decoder for one record returned by a mutation. */
export function hasPolicyData(value: unknown): boolean {
  return hasPolicyListData({ items: [value], next_cursor: null });
}

export function hasPolicyListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && stringField(row, "project") && stringField(row, "name") && enumField(row, "type", ["trial", "node_locked", "floating", "subscription"] as const) && enumField(row, "status", CATALOG_STATUSES) && nullableIntegerInRangeField(row, "valid_from_offset_sec", -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS) && nullableIntegerInRangeField(row, "duration_sec", 0, MAX_DURATION_SECONDS) && integerInRangeField(row, "assertion_ttl_seconds", 1, 3600) && integerInRangeField(row, "pool_size", 0, MAX_CAPACITY) && integerInRangeField(row, "max_active_devices", 0, MAX_CAPACITY) && integerInRangeField(row, "max_borrow_sec", 0, MAX_DURATION_SECONDS) && integerInRangeField(row, "meter_quota", 0, MAX_METER_QUOTA) && integerInRangeField(row, "meter_period_sec", 0, MAX_DURATION_SECONDS) && enumField(row, "expiry_strategy", ["fixed_window", "non_expiring"] as const) && enumField(row, "trial_expiration_basis", ["from_issue", "from_first_activation", "from_first_use"] as const) && integerInRangeField(row, "trial_duration_sec", 0, MAX_DURATION_SECONDS) && binaryFlagField(row, "trial_one_per_device") && binaryFlagField(row, "trial_require_device_proof") && typeof row.notes === "string" && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at");
  });
}

export function hasWebhookListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && stringField(row, "url") && typeof row.event_types === "string" && enumField(row, "status", CATALOG_STATUSES) && typeof row.description === "string" && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at") && nullableStringField(row, "scope_project") && nullableStringField(row, "scope_customer_id");
  });
}

/** Reuse the strict list decoder for one endpoint returned by a mutation. */
export function hasWebhookData(value: unknown): boolean {
  return hasWebhookListData({ items: [value], next_cursor: null });
}

export function hasWebhookDeliveryListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && nonNegativeIntegerField(row, "id") && stringField(row, "endpoint_id") && nonNegativeIntegerField(row, "event_id") &&
      enumField(row, "event_source", ["entitlement", "customer", "order"] as const) && stringField(row, "event_type") &&
      enumField(row, "status", ["pending", "delivered", "failed"] as const) && nonNegativeIntegerField(row, "attempts") &&
      integerInRangeField(row, "last_status", 0, 999) && typeof row.last_error === "string" &&
      nonNegativeIntegerField(row, "next_attempt_at") && nonNegativeIntegerField(row, "created_at") &&
      nullableIntegerInRangeField(row, "delivered_at", 0, Number.MAX_SAFE_INTEGER);
  });
}

export function hasWebhookDeliveryData(value: unknown): boolean {
  return hasWebhookDeliveryListData({ items: [value], next_cursor: null });
}

export function hasCatalogFeatureListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && stringField(row, "project") && stringField(row, "feature_key") && typeof row.name === "string" && enumField(row, "status", CATALOG_STATUSES) && typeof row.description === "string" && typeof row.category === "string" && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at");
  });
}

export function hasCatalogFeatureData(value: unknown): boolean {
  return hasCatalogFeatureListData({ items: [value], next_cursor: null });
}

export function hasCatalogPlanListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && stringField(row, "project") && stringField(row, "plan_key") && typeof row.name === "string" && enumField(row, "status", CATALOG_STATUSES) && integerInRangeField(row, "version", 1, MAX_CAPACITY) && typeof row.description === "string" && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at");
  });
}

export function hasCatalogPlanData(value: unknown): boolean {
  return hasCatalogPlanListData({ items: [value], next_cursor: null });
}

export function hasCatalogPlanFeatureListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "project") && stringField(row, "plan_id") && stringField(row, "plan_key") && stringField(row, "feature_key") && stringField(row, "feature_name") && enumField(row, "feature_inclusion", ["included", "addon"] as const) && nullableStringField(row, "addon_key") && (row.feature_inclusion !== "addon" || stringField(row, "addon_key")) && nullableStringField(row, "policy_id") && enumField(row, "status", CATALOG_STATUSES) && integerInRangeField(row, "display_order", 0, MAX_CAPACITY) && nullableIntegerInRangeField(row, "assertion_ttl_seconds", 0, 3600) && nullableIntegerInRangeField(row, "pool_size", 0, MAX_CAPACITY) && nullableIntegerInRangeField(row, "max_active_devices", 0, MAX_CAPACITY) && nullableIntegerInRangeField(row, "max_borrow_sec", 0, MAX_DURATION_SECONDS) && nullableIntegerInRangeField(row, "meter_quota", 0, MAX_METER_QUOTA) && nullableIntegerInRangeField(row, "meter_period_sec", 0, MAX_DURATION_SECONDS) && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at");
  });
}

export function hasCatalogPlanFeatureData(value: unknown): boolean {
  return hasCatalogPlanFeatureListData({ items: [value] });
}

function hasCatalogImportEffect(value: unknown): value is CatalogImportEffect {
  const effect = record(value);
  if (effect === null || record(effect.target) === null || !["create", "update", "disable", "reenable", "unchanged"].includes(String(effect.effect)) ||
    (effect.before !== null && record(effect.before) === null) || record(effect.after) === null) {
    return false;
  }
  const target = record(effect.target);
  if (target === null || !stringField(target, "project")) return false;
  if (target.entity === "feature") return stringField(target, "feature_key");
  if (target.entity === "plan") return stringField(target, "plan_key") && stringField(target, "plan_id");
  return target.entity === "plan_feature" && stringField(target, "feature_key") && stringField(target, "plan_key") && stringField(target, "plan_id");
}

function hasCatalogImportCounter(value: unknown, effects: readonly CatalogImportEffect[]): boolean {
  const counter = record(value);
  if (counter === null || !["create", "update", "disable", "reenable", "unchanged"].every((kind) => nonNegativeIntegerField(counter, kind))) {
    return false;
  }
  return ["create", "update", "disable", "reenable", "unchanged"].every((kind) => counter[kind] === effects.filter((effect) => record(effect)?.effect === kind).length);
}

export function hasCatalogImportPreviewData(value: unknown): value is CatalogImportPreviewResponse {
  const data = record(value);
  if (data === null || typeof data.preview_id !== "string" || data.preview_id === "" || !/^civ_[A-Za-z0-9_-]{1,124}$/.test(data.preview_id) ||
    typeof data.manifest_digest !== "string" || data.manifest_digest === "" || !/^[0-9a-f]{64}$/.test(data.manifest_digest) || !hasCatalogImportManifestData(data.manifest) ||
    !nonNegativeIntegerField(data, "effective_at") || !nonNegativeIntegerField(data, "expires_at") || !nonNegativeIntegerField(data, "source_generation") ||
    (data.expires_at as number) < (data.effective_at as number)) {
    return false;
  }
  const effects = record(data.effects);
  if (effects === null || !Array.isArray(effects.features) || !Array.isArray(effects.plans) || !Array.isArray(effects.plan_features) ||
    !effects.features.every(hasCatalogImportEffect) || !effects.plans.every(hasCatalogImportEffect) || !effects.plan_features.every(hasCatalogImportEffect)) {
    return false;
  }
  const summary = record(effects.summary);
  return summary !== null &&
    hasCatalogImportCounter(summary.features, effects.features) &&
    hasCatalogImportCounter(summary.plans, effects.plans) &&
    hasCatalogImportCounter(summary.plan_features, effects.plan_features);
}

/** Apply returns the same server-bound preview shape that was shown in the dialog. */
export const hasCatalogImportApplyData = hasCatalogImportPreviewData;

/** Strict decoder for the catalog export route before it is downloaded. */
export function hasCatalogImportManifestData(value: unknown): boolean {
  const data = record(value);
  if (data === null || data.format_version !== 1 || !Array.isArray(data.features) || !Array.isArray(data.plans)) {
    return false;
  }
  const featureInput = (item: unknown): boolean => {
    const row = record(item);
    return row !== null && stringField(row, "project") && stringField(row, "feature_key") && typeof row.name === "string" &&
      typeof row.description === "string" && typeof row.category === "string" && enumField(row, "status", CATALOG_STATUSES);
  };
  const planFeatureInput = (item: unknown): boolean => {
    const row = record(item);
    if (row === null || !stringField(row, "project") || !stringField(row, "feature_key") ||
      !enumField(row, "feature_inclusion", ["included", "addon"] as const) || !nullableStringField(row, "addon_key") ||
      !nullableStringField(row, "policy_id") || !enumField(row, "status", CATALOG_STATUSES) ||
      !integerInRangeField(row, "display_order", 0, MAX_CAPACITY) ||
      !nullableIntegerInRangeField(row, "assertion_ttl_seconds", 0, 3600) || !nullableIntegerInRangeField(row, "pool_size", 0, MAX_CAPACITY) ||
      !nullableIntegerInRangeField(row, "max_active_devices", 0, MAX_CAPACITY) || !nullableIntegerInRangeField(row, "max_borrow_sec", 0, MAX_DURATION_SECONDS) ||
      !nullableIntegerInRangeField(row, "meter_quota", 0, MAX_METER_QUOTA) || !nullableIntegerInRangeField(row, "meter_period_sec", 0, MAX_DURATION_SECONDS)) {
      return false;
    }
    return row.feature_inclusion !== "addon" || stringField(row, "addon_key");
  };
  return data.features.every(featureInput) && data.plans.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "project") && stringField(row, "plan_key") && typeof row.name === "string" &&
      typeof row.description === "string" && enumField(row, "status", CATALOG_STATUSES) && integerInRangeField(row, "version", 1, MAX_CAPACITY) &&
      Array.isArray(row.features) && row.features.every(planFeatureInput);
  });
}

function hasPlanProjectionItemData(value: unknown): boolean {
  const item = record(value);
  if (item === null || !stringField(item, "project") || !stringField(item, "feature") || !stringField(item, "license_fingerprint") ||
    !nullableStringField(item, "policy_id") || !enumField(item, "source", ["included", "addon"] as const) || !nullableStringField(item, "addon_key") ||
    !enumField(item, "license_mode", LICENSE_MODES) || !enumField(item, "status", ENTITLEMENT_STATUSES) ||
    !nullableIntegerInRangeField(item, "valid_from", 0, Number.MAX_SAFE_INTEGER) || !nullableIntegerInRangeField(item, "valid_until", 0, Number.MAX_SAFE_INTEGER) ||
    !integerInRangeField(item, "assertion_ttl_seconds", 1, 3600) || !integerInRangeField(item, "pool_size", 0, MAX_CAPACITY) ||
    !integerInRangeField(item, "max_active_devices", 0, MAX_CAPACITY) || !integerInRangeField(item, "max_borrow_sec", 0, MAX_DURATION_SECONDS) ||
    !integerInRangeField(item, "meter_quota", 0, MAX_METER_QUOTA) || !integerInRangeField(item, "meter_period_sec", 0, MAX_DURATION_SECONDS)) {
    return false;
  }
  if (item.source === "addon" && !stringField(item, "addon_key")) return false;
  if (item.valid_from !== null && item.valid_until !== null && (item.valid_until as number) < (item.valid_from as number)) return false;
  if (Object.prototype.hasOwnProperty.call(item, "reason") && typeof item.reason !== "string") return false;
  return !Object.prototype.hasOwnProperty.call(item, "previous_status") || typeof item.previous_status === "string";
}

function hasPlanProjectionAssignment(value: unknown): boolean {
  const assignment = record(value);
  if (assignment === null || !stringField(assignment, "project") || !stringField(assignment, "license_id") || !stringField(assignment, "license_fingerprint") ||
    !nullableStringField(assignment, "customer_id") || !stringField(assignment, "plan_id") || !stringField(assignment, "plan_key") ||
    !nullableIntegerInRangeField(assignment, "support_until", 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(assignment.addons)) {
    return false;
  }
  const addons = assignment.addons;
  return addons.every((addon) => nonEmptyString(addon)) && new Set(addons).size === addons.length;
}

function hasPlanProjectionSummary(value: unknown, groups: { create: unknown[]; update: unknown[]; disable: unknown[]; blocked: unknown[]; unchanged: unknown[] }): boolean {
  const summary = record(value);
  return summary !== null &&
    nonNegativeIntegerField(summary, "create") && summary.create === groups.create.length &&
    nonNegativeIntegerField(summary, "update") && summary.update === groups.update.length &&
    nonNegativeIntegerField(summary, "disable") && summary.disable === groups.disable.length &&
    nonNegativeIntegerField(summary, "blocked") && summary.blocked === groups.blocked.length &&
    nonNegativeIntegerField(summary, "unchanged") && summary.unchanged === groups.unchanged.length;
}

export function hasPlanProjectionPreviewData(value: unknown): boolean {
  const data = record(value);
  if (data === null || record(data.plan) === null || !hasPlanProjectionAssignment(data.assignment) ||
    !Array.isArray(data.desired) || !Array.isArray(data.will_create) || !Array.isArray(data.will_update) || !Array.isArray(data.will_disable) || !Array.isArray(data.blocked) || !Array.isArray(data.unchanged) ||
    !data.desired.every(hasPlanProjectionItemData) || !data.will_create.every(hasPlanProjectionItemData) || !data.will_update.every(hasPlanProjectionItemData) || !data.will_disable.every(hasPlanProjectionItemData) || !data.blocked.every(hasPlanProjectionItemData) || !data.unchanged.every(hasPlanProjectionItemData) ||
    !nonEmptyString(data.preview_id) || !/^ppv_[A-Za-z0-9_-]{1,124}$/.test(data.preview_id) || !nonNegativeIntegerField(data, "effective_at") || !nonNegativeIntegerField(data, "expires_at") || !nonNegativeIntegerField(data, "source_generation")) {
    return false;
  }
  return (data.expires_at as number) >= (data.effective_at as number) && hasPlanProjectionSummary(data.summary, {
    create: data.will_create,
    update: data.will_update,
    disable: data.will_disable,
    blocked: data.blocked,
    unchanged: data.unchanged,
  });
}

export function hasPlanProjectionPreviewEvidence(value: unknown, expected: {
  project: string;
  license_id: string;
  license_fingerprint: string;
  customer_id?: string | null;
  plan_id?: string | null;
  plan_key?: string | null;
  support_until?: number | null;
  addons?: string[] | null;
}): boolean {
  if (!hasPlanProjectionPreviewData(value)) return false;
  const assignment = record(record(value)?.assignment);
  if (assignment === null || assignment.project !== expected.project || assignment.license_id !== expected.license_id || assignment.license_fingerprint !== expected.license_fingerprint || assignment.customer_id !== (expected.customer_id ?? null) || assignment.support_until !== (expected.support_until ?? null)) {
    return false;
  }
  // A selected row can leave an id in the form while an operator provides a
  // replacement plan key.  The server may resolve either declared selector;
  // require the returned assignment to prove one of them, never an unrelated
  // plan.
  const expectedPlanId = expected.plan_id ?? null;
  const expectedPlanKey = expected.plan_key ?? null;
  if (expectedPlanId !== null && expectedPlanKey !== null) {
    if (assignment.plan_id !== expectedPlanId && assignment.plan_key !== expectedPlanKey) return false;
  } else if (expectedPlanId !== null && assignment.plan_id !== expectedPlanId) {
    return false;
  } else if (expectedPlanKey !== null && assignment.plan_key !== expectedPlanKey) {
    return false;
  }
  const expectedAddons = expected.addons ?? [];
  return Array.isArray(assignment.addons) && assignment.addons.length === expectedAddons.length && assignment.addons.every((addon, index) => addon === expectedAddons[index]);
}

export function hasPlanProjectionApplyData(value: unknown): boolean {
  if (!hasPlanProjectionPreviewData(value)) return false;
  const applied = record(record(value)?.applied);
  return applied !== null && Array.isArray(applied.created) && applied.created.every(hasEntitlementRecordData) &&
    Array.isArray(applied.updated) && applied.updated.every(hasEntitlementRecordData) &&
    Array.isArray(applied.disabled) && applied.disabled.every(hasEntitlementRecordData) &&
    (applied.assignment === null || record(applied.assignment) !== null);
}

export function hasEventListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && nonNegativeIntegerField(row, "id") && enumField(row, "event_type", ["create", "update", "disable", "reenable", "revoke", "revoked-override", "upsert"] as const) && stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") && enumField(row, "status", ENTITLEMENT_STATUSES) && nonNegativeIntegerField(row, "revocation_seq") && stringField(row, "actor") && stringField(row, "actor_type") && stringField(row, "source") && stringField(row, "request_id") && typeof row.reason === "string" && typeof row.detail === "string" && nonNegativeIntegerField(row, "created_at");
  });
}

export function hasOverviewData(value: unknown): boolean {
  const data = record(value);
  const entitlements = record(data?.entitlements);
  return data !== null && entitlements !== null && nonNegativeIntegerField(entitlements, "total") && nonNegativeIntegerField(entitlements, "active") && nonNegativeIntegerField(entitlements, "disabled") && nonNegativeIntegerField(entitlements, "revoked") && (entitlements.active as number) + (entitlements.disabled as number) + (entitlements.revoked as number) === (entitlements.total as number);
}

export function hasLicenseListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "id") && nullableStringField(row, "customer_id") && stringField(row, "project") &&
      nullableStringField(row, "label") && nonNegativeIntegerField(row, "created_at") && nonNegativeIntegerField(row, "updated_at") &&
      (row.updated_at as number) >= (row.created_at as number);
  });
}

function hasFulfillmentSummary(value: unknown): boolean {
  const summary = record(value);
  if (summary === null || !nonNegativeIntegerField(summary, "accepted") || !nonNegativeIntegerField(summary, "processed") ||
    !nonNegativeIntegerField(summary, "superseded") || !nonNegativeIntegerField(summary, "rejected") || !nonNegativeIntegerField(summary, "stale_accepted")) {
    return false;
  }
  return (summary.stale_accepted as number) <= (summary.accepted as number);
}

export function hasOrdersListData(value: unknown): boolean {
  const data = record(value);
  if (data === null || !cursorField(data) || !hasFulfillmentSummary(data.summary) || !nonNegativeIntegerField(data, "stale_secs") || !Array.isArray(data.items)) {
    return false;
  }
  return data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "event_id") && stringField(row, "subscription_id") && stringField(row, "project") &&
      stringField(row, "feature") && nonNegativeIntegerField(row, "order_epoch") && nonNegativeIntegerField(row, "seq") &&
      stringField(row, "intent") && nullableStringField(row, "key_id") && enumField(row, "status", ["accepted", "processed", "superseded", "rejected"] as const) &&
      nonNegativeIntegerField(row, "received_at") && nullableIntegerInRangeField(row, "processed_at", 0, Number.MAX_SAFE_INTEGER) &&
      typeof row.stale === "boolean" && (row.processed_at === null || (row.processed_at as number) >= (row.received_at as number));
  });
}

export function hasReportData(value: unknown): boolean {
  const data = record(value);
  const entitlements = record(data?.entitlements);
  const customers = record(data?.customers);
  const tokens = record(data?.account_tokens);
  const licenses = record(data?.licenses);
  const fulfillment = record(data?.fulfillment);
  if (data === null || entitlements === null || customers === null || tokens === null || licenses === null || fulfillment === null || !nonNegativeIntegerField(data, "generated_at") || !nonNegativeIntegerField(data, "customer_suspensions_7d") ||
    !nonNegativeIntegerField(entitlements, "total") || !nonNegativeIntegerField(entitlements, "active") || !nonNegativeIntegerField(entitlements, "revoked") || !nonNegativeIntegerField(entitlements, "disabled") ||
    !nonNegativeIntegerField(customers, "total") || !nonNegativeIntegerField(customers, "active") || !nonNegativeIntegerField(customers, "disabled") ||
    !nonNegativeIntegerField(tokens, "active") || !nonNegativeIntegerField(licenses, "total") || !hasFulfillmentSummary(fulfillment) ||
    !nonNegativeIntegerField(fulfillment, "events_24h") || !nonNegativeIntegerField(fulfillment, "events_7d")) {
    return false;
  }
  return (entitlements.active as number) + (entitlements.revoked as number) + (entitlements.disabled as number) === (entitlements.total as number) &&
    (customers.active as number) + (customers.disabled as number) === (customers.total as number) &&
    (fulfillment.events_24h as number) <= (fulfillment.events_7d as number);
}

export function hasExpiringListData(value: unknown): boolean {
  const data = record(value);
  return data !== null && cursorField(data) && Array.isArray(data.items) && data.items.every((item) => {
    const row = record(item);
    return row !== null && stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") &&
      nullableStringField(row, "customer_id") && nonNegativeIntegerField(row, "valid_until") && integerInRangeField(row, "days_left", 1, 365_250);
  });
}

export function hasTimeseriesData(value: unknown): boolean {
  const data = record(value);
  if (data === null || !nonNegativeIntegerField(data, "from") || !nonNegativeIntegerField(data, "to") ||
    (data.to as number) <= (data.from as number) || !integerInRangeField(data, "bucket_seconds", 1, MAX_DURATION_SECONDS) || !Array.isArray(data.buckets)) {
    return false;
  }
  let previousStart = -1;
  return data.buckets.every((item) => {
    const bucket = record(item);
    if (bucket === null || !nonNegativeIntegerField(bucket, "start") || (bucket.start as number) < (data.from as number) || (bucket.start as number) >= (data.to as number) || (bucket.start as number) <= previousStart ||
      !nonNegativeIntegerField(bucket, "checkouts") || !nonNegativeIntegerField(bucket, "releases") || !nonNegativeIntegerField(bucket, "denials") || !finiteNumberInRangeField(bucket, "denial_rate", 0, 1) || !nonNegativeIntegerField(bucket, "fulfillment_events")) {
      return false;
    }
    previousStart = bucket.start as number;
    return true;
  });
}

export function hasSearchData(value: unknown): boolean {
  const data = record(value);
  if (data === null || !Array.isArray(data.results)) return false;
  return data.results.every((item) => {
    const row = record(item);
    if (row === null || !enumField(row, "type", ["customer", "license", "entitlement", "order"] as const) || !stringField(row, "id") || !stringField(row, "label")) return false;
    if (row.type === "customer") {
      return typeof row.email === "string" && enumField(row, "status", ["active", "disabled"] as const) && typeof row.external_ref === "string";
    }
    if (row.type === "license") {
      return stringField(row, "project") && nullableStringField(row, "customer_id");
    }
    if (row.type === "entitlement") {
      return stringField(row, "project") && stringField(row, "feature") && enumField(row, "status", ENTITLEMENT_STATUSES) && nullableStringField(row, "customer_id");
    }
    return stringField(row, "project") && stringField(row, "feature") && stringField(row, "license_fingerprint") && nullableStringField(row, "customer_id");
  });
}
