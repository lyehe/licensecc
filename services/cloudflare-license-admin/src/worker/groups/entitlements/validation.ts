import type { AdminEntitlementPatch, EntitlementInput, EntitlementStatus } from "../../../shared/api";
import { MAX_DEVICE_LIMIT } from "../../../shared/api.js";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";

const HEX_64 = /^[0-9a-fA-F]{64}$/;
export const MAX_PROJECT_SIZE = 127;
export const MAX_FEATURE_SIZE = 15;
const MAX_NOTES_SIZE = 1000;
export const MAX_NAME_SIZE = 127;
// A generous-but-bounded ceiling for duration and offset integers
// (~100 years in seconds). Keeps validators from accepting absurd or overflow values.
export const MAX_DURATION_SECONDS = 3_153_600_000;
const INVALID = Symbol("invalid");
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

export function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function splitCsv(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== ""));
}

export function safeNotes(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_NOTES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

export function nullableSafeString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return safeString(value, maxLength);
}

export function boundedInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

/** A device limit an operator sets: a whole number of devices from 1 to MAX_DEVICE_LIMIT. */
export function deviceLimit(value: unknown): number | undefined {
  return boundedInt(value, 1, MAX_DEVICE_LIMIT);
}

export function nullableEpoch(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

// Each entitlement route accepts exactly the fields it reads. A body naming any other field (a mode,
// a column no request writes, or anything else) is refused whole, so a caller never believes a field
// it sent took effect.
const ENTITLEMENT_INPUT_FIELDS = ["project", "feature", "license_fingerprint", "status", "valid_from", "valid_until", "notes", "customer_id", "license_id"] as const;
/** A create: the grant's fields, and either a policy to stamp from or its own device limit. */
export const ENTITLEMENT_CREATE_FIELDS: ReadonlySet<string> = new Set([...ENTITLEMENT_INPUT_FIELDS, "policy_id", "max_active_devices"]);
/** A policy create: the policy, and the grant's fields except the status and device limit the policy stamps. */
export const ENTITLEMENT_POLICY_CREATE_FIELDS: ReadonlySet<string> = new Set(["project", "feature", "license_fingerprint", "valid_from", "valid_until", "notes", "customer_id", "license_id", "policy_id"]);
/** A sync: the grant's fields and the audit reason. */
export const ENTITLEMENT_SYNC_FIELDS: ReadonlySet<string> = new Set([...ENTITLEMENT_INPUT_FIELDS, "reason"]);
/** A PATCH: the patchable fields, the device limit, and the observed-state precondition. */
export const ENTITLEMENT_PATCH_FIELDS: ReadonlySet<string> = new Set(["valid_from", "valid_until", "notes", "customer_id", "license_id",
  "max_active_devices", "expected_customer_id", "expected_revocation_seq"]);

/** A JSON object naming only allowed fields. */
export function namesOnly(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.has(key));
}

/** The grant fields every create and sync body shares. The caller has already checked its body's field names. */
export function validateEntitlementInput(value: unknown): EntitlementInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const feature = safeString(input.feature, MAX_FEATURE_SIZE);
  const licenseFingerprint = typeof input.license_fingerprint === "string" && HEX_64.test(input.license_fingerprint)
    ? input.license_fingerprint
    : null;
  const status = input.status === undefined ? "active" : input.status;
  const validFrom = input.valid_from === undefined ? null : nullableEpoch(input.valid_from);
  const validUntil = input.valid_until === undefined ? null : nullableEpoch(input.valid_until);
  const notes = input.notes === undefined ? "" : safeNotes(input.notes);
  // Every grant has an owner (customer_id is NOT NULL): a body naming none, null or "" is refused here.
  const customerId = safeString(input.customer_id, 128);
  const licenseId = input.license_id === undefined ? null : nullableSafeString(input.license_id, 128);
  if (
    project === null || feature === null || licenseFingerprint === null ||
    !["active", "disabled", "revoked"].includes(String(status)) ||
    validFrom === undefined || validUntil === undefined ||
    (validFrom !== null && validUntil !== null && validFrom >= validUntil) || notes === null ||
    customerId === null || licenseId === undefined
  ) {
    return null;
  }
  return {
    project,
    feature,
    license_fingerprint: licenseFingerprint,
    status: status as EntitlementStatus,
    valid_from: validFrom,
    valid_until: validUntil,
    notes,
    customer_id: customerId,
    license_id: licenseId,
  };
}

export function validateEntitlementPatch(value: unknown): AdminEntitlementPatch | null {
  if (!namesOnly(value, ENTITLEMENT_PATCH_FIELDS)) {
    return null;
  }
  const input = value;
  const patch: AdminEntitlementPatch = {};
  if (input.max_active_devices !== undefined) {
    const limit = deviceLimit(input.max_active_devices);
    if (limit === undefined) {
      return null;
    }
    patch.max_active_devices = limit;
  }
  if (input.valid_from !== undefined) {
    const validFrom = nullableEpoch(input.valid_from);
    if (validFrom === undefined) {
      return null;
    }
    patch.valid_from = validFrom;
  }
  if (input.valid_until !== undefined) {
    const validUntil = nullableEpoch(input.valid_until);
    if (validUntil === undefined) {
      return null;
    }
    patch.valid_until = validUntil;
  }
  const notes = input.notes === undefined ? undefined : safeNotes(input.notes);
  if (notes === null) {
    return null;
  }
  if (notes !== undefined) {
    patch.notes = notes;
  }
  if (input.customer_id !== undefined) {
    // A PATCH can move a grant to another customer but never clear its owner.
    const customerId = safeString(input.customer_id, 128);
    if (customerId === null) {
      return null;
    }
    patch.customer_id = customerId;
  }
  if (input.license_id !== undefined) {
    const licenseId = nullableSafeString(input.license_id, 128);
    if (licenseId === undefined) {
      return null;
    }
    patch.license_id = licenseId;
  }
  return patch;
}
