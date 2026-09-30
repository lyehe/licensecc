// Session-scoped customer data: the signed-in identity and the customer's own entitlements.

import { boundTrialDeadlineSql } from "@licensecc/cloudflare-runtime/device/bound_trial";
import type { Env, SessionRow } from "../env.js";
import { envelope, withPortalEntitlement, type OwnedEntitlement } from "../support.js";

// Resolve the signed-in customer's display email in ONE read, so the header/consent/empty-state UI
// can show "Signed in as {email}" / "Connecting to {email}". Precedence: customers.email if
// non-empty, else the customer's portal_passwords.email_lower (an admin-created password account has
// no customers.email), else the EARLIEST portal_identities.email (deterministic via
// ORDER BY created_at, provider), else null. Additive: customer_id is unchanged; email is a new sibling
// field the client may ignore.
async function apiMe(env: Env, session: { customer_id: string }, reqId: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(NULLIF(c.email,''), " +
      "(SELECT p.email_lower FROM portal_passwords p WHERE p.customer_id = c.id), " +
      "(SELECT i.email FROM portal_identities i WHERE i.customer_id = c.id ORDER BY i.created_at, i.provider LIMIT 1)) AS email " +
      "FROM customers c WHERE c.id = ?",
  ).bind(session.customer_id).first<{ email: string | null }>();
  return envelope(reqId, "me", { customer_id: session.customer_id, email: row === null ? null : row.email });
}

// When each row's trial ends, by the protected-device trial rule that enforces every row. The rule
// takes no prospective start here, so a trial clock the first activation has not started yet has no
// end (NULL). The end is clamped to valid_until as the consent page does, since a trial never
// outlives its license; SQLite's scalar min() is NULL when any argument is, so an unstarted trial
// stays NULL. trial_starts_on_activation marks a clock the first activation starts: only for a
// duration the rule accepts (it refuses one under 2 seconds). A trial with neither has no end of its
// own. Only these two derived values leave the Worker; the trial columns stay server-side.
const TRIAL_SQL =
  "CASE WHEN e.is_trial<>1 THEN NULL ELSE min(coalesce(e.valid_until,9007199254740991), " +
  `${boundTrialDeadlineSql("e", "NULL")}) ` +
  "END AS trial_ends_at, " +
  "(e.is_trial=1 AND e.trial_started_at IS NULL AND e.trial_expiration_basis IN ('from_first_activation','from_first_use') " +
  "AND e.trial_duration_sec>=2) AS trial_starts_on_activation";
type EntitlementListRow = Omit<OwnedEntitlement, "id" | "license_mode"> & {
  trial_ends_at: number | null;
  // SQLite truth value: 1, 0, or NULL (a NULL basis), mapped to a boolean below.
  trial_starts_on_activation: number | null;
};

async function apiEntitlements(env: Env, session: { customer_id: string }, reqId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT project, feature, license_fingerprint, status, valid_from, valid_until, max_active_devices, is_trial, policy_id, " +
      `${TRIAL_SQL} FROM entitlements e WHERE customer_id = ? ORDER BY project, feature, license_fingerprint`,
  ).bind(session.customer_id).all<EntitlementListRow>();
  return envelope(reqId, "entitlements", {
    items: rows.results.map((row) => withPortalEntitlement({ ...row, trial_starts_on_activation: row.trial_starts_on_activation === 1 })),
  });
}

export const SESSION_DISPATCH = {
  "GET /api/portal/me": (_request: Request, env: Env, session: SessionRow, reqId: string, _now: number) => apiMe(env, session, reqId),
  "GET /api/portal/entitlements": (_request: Request, env: Env, session: SessionRow, reqId: string, _now: number) => apiEntitlements(env, session, reqId),
};
