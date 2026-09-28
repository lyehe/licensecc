import type { NavigationTarget } from "../../app/types";

export type SearchResultType = "customer" | "license" | "entitlement" | "order";

// The server caps each result type at this many rows per search. The UI cannot see whether a type
// was truncated directly, so it infers "at the limit" from a type's result count reaching this
// number -- kept here, not imported from the Worker, since UI code never imports Worker files.
export const SEARCH_RESULTS_PER_TYPE_LIMIT = 10;

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  project?: string;
  feature?: string;
  license_fingerprint?: string;
  email?: string;
  status?: string;
  external_ref?: string | null;
  customer_id?: string | null;
}

export function searchPath(q: string): string {
  const params = new URLSearchParams();
  params.set("q", q);
  return `/api/admin/search?${params.toString()}`;
}

export function navigationForResult(result: SearchResult): NavigationTarget {
  if (result.type === "customer") {
    return { tab: "customers", filter: { status: "", q: result.id }, selectCustomerId: result.id };
  }
  if (result.type === "entitlement") {
    // Deep-link by the exact entitlement id, never by project/feature: those can match many rows,
    // while the id (project+feature+fingerprint) guarantees exactly one.
    const filter: Record<string, string> = { id: result.id, project: "", feature: "", status: "" };
    if (result.customer_id) filter.customer_id = result.customer_id;
    return { tab: "entitlements", filter };
  }
  if (result.type === "license") {
    // A license has no detail view of its own; deep-link into the entitlements it backs.
    const filter: Record<string, string> = { license_id: result.id, project: "", feature: "", status: "" };
    if (result.customer_id) filter.customer_id = result.customer_id;
    return { tab: "entitlements", filter };
  }
  return { tab: "fulfillment", filter: { status: "", subscription_id: result.id } };
}
