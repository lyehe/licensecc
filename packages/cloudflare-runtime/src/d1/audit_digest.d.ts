// Type declarations for the D1 audit-digest adapter.

export interface AuditChainResult {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: "prev_digest_mismatch" | "event_count_mismatch" | "digest_mismatch";
}

export interface AuditDigestSegment {
  up_to_id: number;
  event_count: number;
  digest: string;
}

interface DbLike {
  DB: unknown;
}

export function appendAuditDigest(env: DbLike, now: number, source?: string): Promise<AuditDigestSegment | null>;
export function verifyAuditChain(env: DbLike, source?: string): Promise<AuditChainResult>;
