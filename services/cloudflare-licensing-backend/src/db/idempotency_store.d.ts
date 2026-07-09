// Hand-written types for the mutation_idempotency store (idempotency_store.mjs).
// Co-located so the admin's tsc resolves them via the backend package's
// `exports` map `types` condition.

import type { D1DatabaseLike } from "../entitlements/entitlement_mutation";

/** Returns the cached response_json string for (scope, key), or null when there
 *  is no cached row or the key is null. */
export declare function readIdempotentResponse(
  db: D1DatabaseLike,
  scope: string,
  key: string | null,
): Promise<string | null>;

/** Inserts the cached response under (scope, key); a conflicting row wins (first
 *  writer). No-op when the key is null. */
export declare function writeIdempotentResponse(
  db: D1DatabaseLike,
  scope: string,
  key: string | null,
  responseJson: string,
  now: number,
): Promise<void>;
