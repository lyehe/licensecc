import type { AdminEntitlementPatch, EntitlementInput, EntitlementStatus } from "../../../shared/api";
import { MAX_DEVICE_LIMIT } from "../../../shared/api.js";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";

const HEX_64 = /^[0-9a-fA-F]{64}$/;
export const MAX_PROJECT_SIZE = 127;
export const MAX_FEATURE_SIZE = 15;
const MAX_NOTES_SIZE = 1000;
export const MAX_NAME_SIZE = 127;
// A generous-but-bounded ceiling for the policy duration/offset/borrow integers
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

// A protected grant carries no device hash (its device key proves the device) and no assertion TTL,
// and no request chooses its mode. A create, sync or PATCH body naming any of them is refused.
const REFUSED_ENTITLEMENT_FIELDS = ["enforcement_mode", "device_hash", "assertion_ttl_seconds"] as const;

function entitlementBody(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return REFUSED_ENTITLEMENT_FIELDS.some((field) => Object.hasOwn(value, field)) ? null : value as Record<string, unknown>;
}

export function validateEntitlementInput(value: unknown): EntitlementInput | null {
  const input = entitlementBody(value);
  if (input === null) {
    return null;
  }
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const feature = safeString(input.feature, MAX_FEATURE_SIZE);
  const licenseFingerprint = typeof input.license_fingerprint === "string" && HEX_64.test(input.license_fingerprint)
    ? input.license_fingerprint
    : null;
  const status = input.status === undefined ? "active" : input.status;
  const validFrom = input.valid_from === undefined ? null : nullableEpoch(input.valid_from);
  const validUntil = input.valid_until === undefined ? null : nullableEpoch(input.valid_until);
  const notes = input.notes === undefined ? "" : safeNotes(input.notes);
  const customerId = input.customer_id === undefined ? null : nullableSafeString(input.customer_id, 128);
  const licenseId = input.license_id === undefined ? null : nullableSafeString(input.license_id, 128);
  if (
    project === null || feature === null || licenseFingerprint === null ||
    !["active", "disabled", "revoked"].includes(String(status)) ||
    validFrom === undefined || validUntil === undefined ||
    (validFrom !== null && validUntil !== null && validFrom >= validUntil) || notes === null ||
    customerId === undefined || licenseId === undefined
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
  const input = entitlementBody(value);
  if (input === null) {
    return null;
  }
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
    const customerId = nullableSafeString(input.customer_id, 128);
    if (customerId === undefined) {
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
