import type { ApiEnvelope, EntitlementRecord, EntitlementSyncInput } from "./api";

export interface SyncClientOptions {
  baseUrl: string;
  token: string;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sends one protected-grant projection. The body names the grant's customer_id and license_id; the
 * Worker refuses one without them, or with a device hash or an assertion TTL.
 */
export async function syncEntitlement(
  options: SyncClientOptions,
  input: EntitlementSyncInput,
): Promise<ApiEnvelope<EntitlementRecord>> {
  const fetcher = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "authorization": `Bearer ${options.token}`,
    "content-type": "application/json",
  };
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  const response = await fetcher(new URL("/api/sync/entitlements", options.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  return response.json() as Promise<ApiEnvelope<EntitlementRecord>>;
}
