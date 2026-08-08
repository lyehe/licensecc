// Hand-written types for the D1 mutation_idempotency store.
import type { D1DatabaseLike } from "./entitlement_mutation";

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
