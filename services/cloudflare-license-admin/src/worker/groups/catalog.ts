import { operationDescriptor } from "../route-descriptor.js";

export const catalogRoutes = [
  operationDescriptor("catalog", "reader", "GET", "/api/admin/catalog/features"),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/features"),
  operationDescriptor("catalog", "reader", "GET", "/api/admin/catalog/features/{id}", ["id"]),
  operationDescriptor("catalog", "admin", "PATCH", "/api/admin/catalog/features/{id}", ["id"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/features/{id}/disable", ["id"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/features/{id}/reenable", ["id"]),
  operationDescriptor("catalog", "reader", "GET", "/api/admin/catalog/plans"),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/plans"),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/import"),
  operationDescriptor("catalog", "reader", "GET", "/api/admin/catalog/plans/{id}", ["id"]),
  operationDescriptor("catalog", "admin", "PATCH", "/api/admin/catalog/plans/{id}", ["id"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/plans/{id}/disable", ["id"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/plans/{id}/reenable", ["id"]),
  operationDescriptor("catalog", "reader", "GET", "/api/admin/catalog/plans/{id}/export", ["id"]),
  operationDescriptor("catalog", "reader", "GET", "/api/admin/catalog/plans/{id}/features", ["id"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/plans/{id}/features", ["id"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/plans/{id}/features/{featureKey}/disable", ["id", "featureKey"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/catalog/plans/{id}/features/{featureKey}/reenable", ["id", "featureKey"]),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/license-plans/preview"),
  operationDescriptor("catalog", "admin", "POST", "/api/admin/license-plans/apply"),
] as const;
