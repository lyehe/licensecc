export type AdminTab =
  | "overview"
  | "entitlements"
  | "policies"
  | "plans"
  | "webhooks"
  | "events"
  | "customers"
  | "licenses"
  | "fulfillment"
  | "reports";

export type CustomerSection = "overview" | "access" | "licenses" | "tokens" | "orders" | "history";
export type CatalogView = "plans" | "features" | "import";

export type AdminRoute =
  | { tab: "customers"; customerId: string | null; section: CustomerSection; filter: Record<string, string> }
  | { tab: "plans"; view: CatalogView; filter: Record<string, string> }
  | { tab: Exclude<AdminTab, "customers" | "plans">; filter: Record<string, string> };

export interface NavigationIntent {
  id: number;
  tab: AdminTab;
  filter: Record<string, string>;
  selectCustomerId?: string;
  customerSection?: CustomerSection;
  catalogView?: CatalogView;
}

export type NavigationTarget = Omit<NavigationIntent, "id">;

/**
 * "Create policy…" from an entitlement draft: the draft stays parked in its (still mounted)
 * workspace while Policies opens its form for the draft's project. Session memory only; a draft
 * never enters the URL or history.
 */
export interface PolicyDraftRequest {
  readonly project: string;
}

/** The policy created for a parked draft, handed back when the operator returns to it. */
export interface DraftPolicy {
  readonly id: string;
  readonly project: string;
}
