import type { EntitlementInput, EntitlementPatch, EntitlementRecord, EntitlementStatus } from "../shared/api";

export type EntitlementAction = "disable" | "reenable" | "revoke";

export interface EntitlementFilter {
  project: string;
  feature: string;
  status: string;
}

export interface EntitlementFormState {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash: string;
  assertion_ttl_seconds: number;
  valid_from: string;
  valid_until: string;
  notes: string;
  customer_id: string;
  license_id: string;
}

export interface EntitlementEditState {
  device_hash: string;
  assertion_ttl_seconds: number;
  valid_from: string;
  valid_until: string;
  notes: string;
  customer_id: string;
  license_id: string;
}

export const emptyEntitlementForm: EntitlementFormState = {
  project: "DEFAULT",
  feature: "DEFAULT",
  license_fingerprint: "",
  device_hash: "",
  assertion_ttl_seconds: 300,
  valid_from: "",
  valid_until: "",
  notes: "",
  customer_id: "",
  license_id: "",
};

export const emptyEntitlementEditForm: EntitlementEditState = {
  device_hash: "",
  assertion_ttl_seconds: 300,
  valid_from: "",
  valid_until: "",
  notes: "",
  customer_id: "",
  license_id: "",
};

export function shortHash(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export function entitlementsPath(filter: EntitlementFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.feature !== "") params.set("feature", filter.feature);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/entitlements${params.size === 0 ? "" : `?${params.toString()}`}`;
}

function parseBoundedInteger(value: number, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

function parseOptionalEpoch(value: string, label: string): number | null {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label}_must_be_a_non_negative_integer`);
  }
  return parsed;
}

function parseNotes(value: string): string {
  if (value.length > 1000 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("notes_must_be_at_most_1000_chars");
  }
  return value;
}

function parseNullableIdentifier(value: string, label: string): string | null {
  if (value === "") {
    return null;
  }
  if (value.length > 128 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label}_must_be_at_most_128_chars`);
  }
  return value;
}

export function normalizeEntitlementForm(form: EntitlementFormState): EntitlementInput {
  return {
    project: form.project,
    feature: form.feature,
    license_fingerprint: form.license_fingerprint,
    device_hash: form.device_hash,
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    valid_from: parseOptionalEpoch(form.valid_from, "valid_from"),
    valid_until: parseOptionalEpoch(form.valid_until, "valid_until"),
    notes: parseNotes(form.notes),
    customer_id: parseNullableIdentifier(form.customer_id, "customer_id"),
    license_id: parseNullableIdentifier(form.license_id, "license_id"),
  };
}

export function editFormFromEntitlement(item: EntitlementRecord): EntitlementEditState {
  return {
    device_hash: item.device_hash,
    assertion_ttl_seconds: item.assertion_ttl_seconds,
    valid_from: item.valid_from === null ? "" : String(item.valid_from),
    valid_until: item.valid_until === null ? "" : String(item.valid_until),
    notes: item.notes,
    customer_id: item.customer_id ?? "",
    license_id: item.license_id ?? "",
  };
}

export function normalizeEntitlementPatch(form: EntitlementEditState): EntitlementPatch {
  return {
    device_hash: form.device_hash,
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    valid_from: parseOptionalEpoch(form.valid_from, "valid_from"),
    valid_until: parseOptionalEpoch(form.valid_until, "valid_until"),
    notes: parseNotes(form.notes),
    customer_id: parseNullableIdentifier(form.customer_id, "customer_id"),
    license_id: parseNullableIdentifier(form.license_id, "license_id"),
  };
}

export function patchPath(item: Pick<EntitlementRecord, "id">): string {
  return `/api/admin/entitlements/${item.id}`;
}

export function transitionPath(item: Pick<EntitlementRecord, "id">, action: EntitlementAction): string {
  return `/api/admin/entitlements/${item.id}/${action}`;
}

export function canEditEntitlement(status: EntitlementStatus): boolean {
  return status !== "revoked";
}

export function canRunAction(status: EntitlementStatus, action: EntitlementAction): boolean {
  if (action === "disable") {
    return status === "active";
  }
  if (action === "reenable") {
    return status === "disabled";
  }
  return status !== "revoked";
}
