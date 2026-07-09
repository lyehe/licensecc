// ── Generic guarded status-transition helper ──────────────────────────────────
// Six admin resources (customer, policy, catalog feature/plan/plan-feature, webhook
// endpoint) all expose the SAME disable/reenable kill-switch: a REASON gate on
// disable, a status pre-read, a guarded `UPDATE ... WHERE id = ? AND status = ?
// RETURNING ...` that flips only from the expected prior status, a lost-the-race 409,
// and — where the resource has an event log — an audit row written ATOMICALLY with the
// flip (one D1 batch, so a replay never double-writes and a lost race never half-writes).
//
// Before this helper every handler re-implemented that ceremony (`expectedPrev = action
// === "disable" ? "active" : "disabled"`, the same "Lost the guarded race" comment ×4).
// `transitionWithGuard` is that ceremony once. Each family supplies a `TransitionSpec`
// and (optionally) an `auditStatement` builder — the resource-specific INSERT, batched
// with the guarded UPDATE — so each family keeps its EXACT audit convention.
//
// It returns the shape a `mutationResponse` body function expects (a `MutationResult` on
// success so the idempotency cache records it, or a `Response` for a 4xx it discovered),
// so callers wrap it directly: `return mutationResponse(request, env, ctx, code, () =>
// transitionWithGuard(env, spec, requestIdValue))`.

import { envelope } from "./responses.js";
import type { Env } from "./index.js";
import { batchReturnedRow } from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";
import type {
  D1PreparedStatementLike,
  MutationResult,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

export interface TransitionSpec {
  /** Table carrying the `status` column, e.g. "webhook_endpoints". */
  table: string;
  /** RETURNING / SELECT column list for the row surfaced as the mutation data. */
  columns: string;
  /** WHERE clause identifying the row, e.g. "id = ?" or "plan_id = ? AND feature_key = ?". */
  idClause: string;
  /** Bind values for `idClause` (used for both the pre-read and the guarded UPDATE). */
  idValues: unknown[];
  action: "disable" | "reenable";
  /** Prior status a disable flips FROM (and a reenable flips TO). Default "active". */
  activeStatus?: string;
  /** Status a disable flips TO (and a reenable flips FROM). Default "disabled". */
  disabledStatus?: string;
  /** Error code for a status conflict (pre-read mismatch OR lost guarded race). */
  conflictCode: string;
  /** Error code when the row does not exist. Default "not_found". */
  notFoundCode?: string;
  /** Error code when the DB write throws / batch is unavailable. Default "mutation_failed". */
  mutationFailedCode?: string;
  /** Operator-supplied reason (already parsed by the caller). */
  reason?: string | null;
  /** When true, a `disable` with a blank reason is rejected 400 reason_required. */
  requireReason: boolean;
  /**
   * Builds the audit INSERT to run ATOMICALLY (same batch) with the guarded UPDATE, or
   * null to skip auditing. `existing` is the pre-read row; `nextStatus`/`now` match the
   * values written by the UPDATE (so a WHERE EXISTS ... updated_at = ? guard can pin it).
   */
  auditStatement?: (
    existing: Record<string, unknown>,
    nextStatus: string,
    now: number,
  ) => D1PreparedStatementLike | null;
}

export async function transitionWithGuard(
  env: Env,
  spec: TransitionSpec,
  requestIdValue: string,
): Promise<MutationResult<Record<string, unknown>> | Response> {
  const activeStatus = spec.activeStatus ?? "active";
  const disabledStatus = spec.disabledStatus ?? "disabled";
  const notFoundCode = spec.notFoundCode ?? "not_found";
  const mutationFailedCode = spec.mutationFailedCode ?? "mutation_failed";
  const reason = spec.reason ?? "";

  if (spec.action === "disable" && spec.requireReason && reason.trim() === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }

  const expectedPrev = spec.action === "disable" ? activeStatus : disabledStatus;
  const next = spec.action === "disable" ? disabledStatus : activeStatus;

  let existing: Record<string, unknown> | null;
  try {
    existing = await env.DB.prepare(
      `SELECT ${spec.columns} FROM ${spec.table} WHERE ${spec.idClause} LIMIT 1`,
    )
      .bind(...spec.idValues)
      .first<Record<string, unknown>>();
  } catch {
    return envelope(requestIdValue, mutationFailedCode, undefined, 500);
  }
  if (existing === null) {
    return envelope(requestIdValue, notFoundCode, undefined, 404);
  }
  if (existing.status !== expectedPrev) {
    return envelope(requestIdValue, spec.conflictCode, { status: existing.status }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const update = env.DB.prepare(
    `UPDATE ${spec.table} SET status = ?, updated_at = ? WHERE ${spec.idClause} AND status = ? RETURNING ${spec.columns}`,
  ).bind(next, now, ...spec.idValues, expectedPrev);

  const audit = spec.auditStatement ? spec.auditStatement(existing, next, now) : null;

  let row: Record<string, unknown> | null;
  try {
    if (audit !== null) {
      if (typeof env.DB.batch !== "function") {
        return envelope(requestIdValue, mutationFailedCode, undefined, 500);
      }
      const results = await env.DB.batch([update, audit]);
      row = batchReturnedRow<Record<string, unknown>>(results[0]);
    } else {
      row = await update.first<Record<string, unknown>>();
    }
  } catch {
    return envelope(requestIdValue, mutationFailedCode, undefined, 500);
  }
  if (row === null) {
    // Lost the guarded race — status changed between the pre-read and the UPDATE.
    return envelope(requestIdValue, spec.conflictCode, undefined, 409);
  }
  return { data: row, idempotencyRecorded: false };
}
