import type {
  EntitlementInput,
  EntitlementPatch,
  EntitlementRecord,
  EntitlementStatus,
} from "../../../shared/api";
import { dateInputToEpoch, epochToDateInput } from "../../shared/dates";
import { shortHash } from "../../shared/format";

export type EntitlementAction = "disable" | "reenable" | "revoke";

export interface EntitlementFilter {
  project: string;
  feature: string;
  status: string;
}

export interface EntitlementFormState {
  policy_id: string;
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
  policy_id: "",
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

export function entitlementsPath(filter: EntitlementFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.feature !== "") params.set("feature", filter.feature);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/entitlements${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function normalizeEntitlementForm(form: EntitlementFormState): EntitlementInput {
  return {
    project: form.project,
    feature: form.feature,
    license_fingerprint: form.license_fingerprint,
    device_hash: form.device_hash,
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    valid_from: dateInputToEpoch(form.valid_from, "valid_from"),
    valid_until: dateInputToEpoch(form.valid_until, "valid_until"),
    notes: parseNotes(form.notes),
    customer_id: parseNullableIdentifier(form.customer_id, "customer_id"),
    license_id: parseNullableIdentifier(form.license_id, "license_id"),
  };
}

export function normalizeCreateFromPolicy(form: EntitlementFormState): EntitlementInput & { policy_id: string } {
  const body: EntitlementInput & { policy_id: string } = {
    policy_id: form.policy_id,
    project: form.project,
    feature: form.feature,
    license_fingerprint: form.license_fingerprint,
  };
  if (form.device_hash !== "") body.device_hash = form.device_hash;
  if (form.assertion_ttl_seconds !== emptyEntitlementForm.assertion_ttl_seconds) {
    body.assertion_ttl_seconds = parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600);
  }
  if (form.valid_from !== "") body.valid_from = dateInputToEpoch(form.valid_from, "valid_from");
  if (form.valid_until !== "") body.valid_until = dateInputToEpoch(form.valid_until, "valid_until");
  if (form.notes !== "") body.notes = parseNotes(form.notes);
  if (form.customer_id !== "") body.customer_id = parseNullableIdentifier(form.customer_id, "customer_id");
  if (form.license_id !== "") body.license_id = parseNullableIdentifier(form.license_id, "license_id");
  return body;
}

export function editFormFromEntitlement(item: EntitlementRecord): EntitlementEditState {
  return {
    device_hash: item.device_hash,
    assertion_ttl_seconds: item.assertion_ttl_seconds,
    valid_from: epochToDateInput(item.valid_from),
    valid_until: epochToDateInput(item.valid_until),
    notes: item.notes,
    customer_id: item.customer_id ?? "",
    license_id: item.license_id ?? "",
  };
}

export function normalizeEntitlementPatch(form: EntitlementEditState): EntitlementPatch {
  return {
    device_hash: form.device_hash,
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    valid_from: dateInputToEpoch(form.valid_from, "valid_from"),
    valid_until: dateInputToEpoch(form.valid_until, "valid_until"),
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

export function entitlementDevicesPath(entitlementId: string): string {
  return `/api/admin/entitlements/${encodeURIComponent(entitlementId)}/devices`;
}

export function entitlementMeterPath(entitlementId: string): string {
  return `/api/admin/entitlements/${encodeURIComponent(entitlementId)}/meter`;
}

export type DeviceAction = "revoke" | "disable" | "reenable";

export function deviceTransitionPath(entitlementId: string, deviceKeyId: string, action: DeviceAction): string {
  return `/api/admin/entitlements/${encodeURIComponent(entitlementId)}/devices/${encodeURIComponent(deviceKeyId)}/${action}`;
}

export function canRunDeviceAction(status: string, action: DeviceAction): boolean {
  if (status === "revoked") {
    return false;
  }
  if (action === "disable") {
    return status === "active";
  }
  if (action === "reenable") {
    return status === "disabled";
  }
  return true;
}

export function shortDeviceKeyId(deviceKeyId: string): string {
  if (deviceKeyId.startsWith("sha256:") && deviceKeyId.length >= 15) {
    return `sha256:${deviceKeyId.slice(7, 15)}…`;
  }
  return deviceKeyId.length > 12 ? `${deviceKeyId.slice(0, 12)}…` : deviceKeyId;
}

export function revokeDeviceConfirm(device: { device_key_id: string }): string {
  return `Revoke device key ${shortDeviceKeyId(device.device_key_id)}. This is TERMINAL: the device is refused on its next online check (before token TTL) and cannot be re-enabled.`;
}

export function disableDeviceConfirm(device: { device_key_id: string }): string {
  return `Disable device key ${shortDeviceKeyId(device.device_key_id)}. It is refused on its next online check; you can re-enable it later.`;
}

export function revokeEntitlementConfirm(item: { project: string; feature: string; license_fingerprint: string }): string {
  return `Revoke the entitlement for ${item.project} / ${item.feature} (fingerprint ${shortHash(item.license_fingerprint)}). This is TERMINAL and cannot be undone.`;
}

export function disableEntitlementConfirm(item: { project: string; feature: string; license_fingerprint: string }): string {
  return `Disable the entitlement for ${item.project} / ${item.feature} (fingerprint ${shortHash(item.license_fingerprint)}). Verification and downloads stop until it is re-enabled.`;
}

export function batchPath(): string {
  return "/api/admin/entitlements/batch";
}

export interface BatchRowResult {
  id: string;
  ok: boolean;
  code: string;
}

export function batchBody(action: EntitlementAction, ids: ReadonlyArray<string>, reason: string): {
  action: EntitlementAction;
  reason: string;
  ids: string[];
} {
  return { action, reason, ids: [...ids] };
}

export function summarizeBatchResults(results: ReadonlyArray<BatchRowResult>): string {
  const okCount = results.filter((row) => row.ok).length;
  const failures = new Map<string, number>();
  for (const row of results) {
    if (!row.ok) {
      const slug = batchFailureSlug(row.code);
      failures.set(slug, (failures.get(slug) ?? 0) + 1);
    }
  }
  const parts: string[] = [`${okCount} ok`];
  for (const [slug, count] of failures) {
    parts.push(`${count} ${slug}`);
  }
  return parts.join(", ");
}

export function releaseSeatsPath(id: string): string {
  return `/api/admin/entitlements/${id}/release-seats`;
}

export function releaseSeatsConfirm(item: { project: string; feature: string; license_fingerprint: string }): string {
  return `Force-release ALL live seats for ${item.project} / ${item.feature} (fingerprint ${shortHash(item.license_fingerprint)}). This frees a seat stuck on a dead/unreachable machine; live clients simply re-acquire on their next checkout.`;
}

function parseBoundedInteger(value: number, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
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

function batchFailureSlug(code: string): string {
  if (code === "revoked_entitlement_is_terminal") return "revoked-terminal";
  if (code === "invalid_entitlement_id") return "invalid-id";
  if (code === "not_found") return "not-found";
  if (code === "mutation_failed") return "failed";
  return code;
}
