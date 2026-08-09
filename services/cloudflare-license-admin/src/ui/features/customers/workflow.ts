export interface CustomerListFilter {
  status: string;
  q: string;
}

export type CustomerAction = "disable" | "reenable";

export function customersPath(filter: CustomerListFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== "") params.set("status", filter.status);
  if (filter.q !== "") params.set("q", filter.q);
  return `/api/admin/customers${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function customerDetailPath(id: string): string {
  return `/api/admin/customers/${encodeURIComponent(id)}`;
}

export function customerTransitionPath(id: string, action: CustomerAction): string {
  return `/api/admin/customers/${encodeURIComponent(id)}/${action}`;
}

export function canRunCustomerAction(status: string, action: CustomerAction): boolean {
  return action === "disable" ? status === "active" : status === "disabled";
}

export function disableCustomerConfirm(customer: { id: string; name: string }): string {
  const who = customer.name !== "" ? `${customer.name} (${customer.id})` : customer.id;
  return `Disable customer ${who}. This immediately severs all of their license/token auth and customer-portal access until you re-enable them.`;
}
