import type { Env } from "../../env.js";

// Stored-state counts, deliberately not a claim that enabled grants are unexpired.
// One statement keeps these four related numbers internally consistent.
export async function accessCounts(env: Env): Promise<{ total: number; active: number; revoked: number; disabled: number }> {
  return await env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(status = 'active'), 0) AS active,
    COALESCE(SUM(status = 'revoked'), 0) AS revoked,
    COALESCE(SUM(status = 'disabled'), 0) AS disabled FROM entitlements`)
    .first<{ total: number; active: number; revoked: number; disabled: number }>()
    ?? { total: 0, active: 0, revoked: 0, disabled: 0 };
}
