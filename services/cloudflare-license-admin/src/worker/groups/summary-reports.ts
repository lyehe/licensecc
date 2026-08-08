import { operationDescriptor } from "../route-descriptor.js";

export const summaryReportsRoutes = [
  operationDescriptor("summary-reports", "reader", "GET", "/api/admin/summary"),
  operationDescriptor("summary-reports", "reader", "GET", "/api/admin/report"),
  operationDescriptor("summary-reports", "reader", "GET", "/api/admin/report/timeseries"),
  operationDescriptor("summary-reports", "reader", "GET", "/api/admin/report/expiring"),
  operationDescriptor("summary-reports", "reader", "GET", "/api/admin/audit/verify"),
  operationDescriptor("summary-reports", "reader", "GET", "/api/admin/settings"),
] as const;
