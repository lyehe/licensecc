import type { EntitlementRecord } from "../../../shared/api";

// The successful POST proves the write. Its GET confirms the same owned grant at least
// as recently as that write; another operator may already have changed its lifecycle.
export function confirmsSavedGrant(saved: EntitlementRecord, current: EntitlementRecord): boolean {
  return current.id === saved.id && current.project === saved.project && current.feature === saved.feature
    && current.license_fingerprint === saved.license_fingerprint && current.customer_id === saved.customer_id
    && current.license_id === saved.license_id && current.revocation_seq >= saved.revocation_seq
    && (current.status === saved.status || current.revocation_seq > saved.revocation_seq);
}

export function grantConfirmationMessage(saved: EntitlementRecord, current: EntitlementRecord): string | null {
  if (current.status === saved.status && current.revocation_seq === saved.revocation_seq) return null;
  const status = current.status === "disabled" ? "suspended" : current.status;
  return `Access was saved and has changed since. Current status: ${status}.`;
}
