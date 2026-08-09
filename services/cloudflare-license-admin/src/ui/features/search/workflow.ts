import type { NavigationTarget } from "../../app/types";

export type SearchResultType = "customer" | "license" | "entitlement" | "order";

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
    return { tab: "entitlements", filter: { project: result.project ?? "", feature: result.feature ?? "", status: "" } };
  }
  if (result.type === "license") {
    return { tab: "licenses", filter: { project: result.project ?? "", customer_id: "", q: result.id } };
  }
  return { tab: "fulfillment", filter: { status: "", subscription_id: result.id } };
}
