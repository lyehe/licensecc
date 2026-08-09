export interface LicenseListFilter {
  project: string;
  customer_id: string;
  q: string;
}

export function licensesPath(filter: LicenseListFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.customer_id !== "") params.set("customer_id", filter.customer_id);
  if (filter.q !== "") params.set("q", filter.q);
  return `/api/admin/licenses${params.size === 0 ? "" : `?${params.toString()}`}`;
}
