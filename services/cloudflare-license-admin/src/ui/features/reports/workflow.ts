export function expiringPath(withinDays: number): string {
  const params = new URLSearchParams();
  params.set("within_days", String(withinDays));
  return `/api/admin/report/expiring?${params.toString()}`;
}
