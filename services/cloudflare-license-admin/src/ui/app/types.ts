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

export type CustomerSection = "overview" | "access" | "licenses" | "account" | "orders" | "history";
export type CatalogView = "plans" | "features" | "import";

/**
 * A customer's drill-down into one app's access grants. `manage` marks the Manage access entry: the
 * address carries only that marker, while the grant it opened stays in the in-memory history entry.
 */
export interface CustomerAccessRoute {
  app: string;
  manage: boolean;
}

export type AdminRoute =
  | { tab: "customers"; customerId: string | null; section: CustomerSection; filter: Record<string, string>; access?: CustomerAccessRoute }
  | { tab: "plans"; view: CatalogView; filter: Record<string, string>; plan?: string }
  | { tab: Exclude<AdminTab, "customers" | "plans">; filter: Record<string, string> };

/**
 * The grant "Manage access" opened. Its id encodes the license fingerprint, so it lives only in the
 * in-memory history entry and never reaches the URL or history.state.
 */
export interface ManagedGrant {
  readonly project: string;
  readonly feature: string;
  readonly id: string;
  readonly customer_id: string;
}

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
