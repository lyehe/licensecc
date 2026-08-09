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

export interface NavigationIntent {
  id: number;
  tab: AdminTab;
  filter: Record<string, string>;
  selectCustomerId?: string;
}

export type NavigationTarget = Omit<NavigationIntent, "id">;
