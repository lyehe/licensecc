import type { CreatedLicense, ProtectedCreateReason } from "../../../shared/api";
import { PROTECTED_CREATE_REASONS } from "../../../shared/api";
import { documentedMutationPolicy, type MutationFailurePolicy } from "../../shared/mutationGuards";

// One actionable sentence per rule a protected create can break (409 protected_creation_conflict
// `data.reason`). Wording follows doc/architecture/glossary.md: a disabled customer is "suspended".
const REASON_SENTENCES: Readonly<Record<ProtectedCreateReason, string>> = {
  customer_inactive: "The customer is suspended or no longer exists; reenable the customer or choose an active one.",
  license_missing: "The chosen license doesn't exist; choose one of the customer's licenses or create one for this project.",
  license_customer_mismatch: "The chosen license belongs to another customer or project; choose this customer's license for this project.",
  fingerprint_in_use: "This fingerprint or license is already used by another license (entitlement); generate a new fingerprint or choose another license.",
  plan_assignment_conflict: "This license is assigned to a plan under a different fingerprint; use that fingerprint or choose another license.",
  policy_mismatch: "The policy isn't an active policy for this project, or it changed while you were saving; choose an active policy for this project and try again.",
  invalid_trial: "This license's trial settings can't be used: a trial from issue needs an end date in the future, and other trials need a length.",
  devices_connected: "This license (entitlement) still has connected devices; disconnect them before moving it to another customer.",
  invalid_capacity: "The device limit must be 1 to 1,000,000 and can't drop below the devices already connected; raise the limit, choose another policy, or disconnect devices first.",
  unknown: "This protected license (entitlement) can't be created with these settings.",
};

/**
 * The operator's sentence for a refused protected create, or null for any other failure. The code
 * and request id stay under Technical details.
 */
export function protectedCreateFailureMessage(failure: { code: string; requestId: string; data?: unknown }): string | null {
  if (failure.code !== "protected_creation_conflict") return null;
  const data = failure.data !== null && typeof failure.data === "object" ? failure.data as { reason?: unknown } : {};
  const reason = PROTECTED_CREATE_REASONS.find((known) => known === data.reason) ?? "unknown";
  return REASON_SENTENCES[reason];
}

/** A new protected license fingerprint: 32 random bytes as 64 lowercase hexadecimal characters. */
export function generateLicenseFingerprint(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Worker's protected project rule; only such a project can hold a protected license. */
export function isProtectedProject(project: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,127}$/.test(project);
}

export function createLicensePath(customerId: string): string {
  return `/api/admin/customers/${encodeURIComponent(customerId)}/licenses`;
}

// Documented pre-mutation rejections of POST /api/admin/customers/{id}/licenses; the shared helper
// adds the auth and body-size rules, and a replay stays conclusive only on an exact success.
export const licenseCreateFailures: MutationFailurePolicy = documentedMutationPolicy(
  { status: 400, codes: ["invalid_request", "invalid_json", "invalid_idempotency_key"] },
  { status: 404, codes: ["not_found"] },
  { status: 409, codes: ["customer_inactive"] },
);

export function hasCreatedLicenseData(value: unknown, customerId: string, project: string): value is CreatedLicense {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.startsWith("lic_") && row.customer_id === customerId && row.project === project &&
    typeof row.label === "string" && typeof row.created_at === "number" && Number.isSafeInteger(row.created_at) && row.created_at >= 0;
}

/** The operator's sentence for a refused license create; the code and request id stay under Technical details. */
export function licenseCreateFailureMessage(failure: { code: string; requestId: string }): string {
  return failure.code === "customer_inactive"
    ? "The customer is suspended; reenable the customer before creating a license."
    : failure.code === "not_found" ? "This customer no longer exists; choose another customer." : "The license wasn't created.";
}
