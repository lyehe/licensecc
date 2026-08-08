import { operationDescriptor } from "../route-descriptor.js";

export const entitlementRoutes = [
  operationDescriptor("entitlements", "reader", "GET", "/api/admin/entitlements"),
  operationDescriptor("entitlements", "admin", "POST", "/api/admin/entitlements"),
  operationDescriptor("entitlements", "admin", "POST", "/api/admin/entitlements/batch"),
  operationDescriptor("entitlements", "reader", "GET", "/api/admin/entitlements/{id}", ["id"]),
  operationDescriptor("entitlements", "admin", "PATCH", "/api/admin/entitlements/{id}", ["id"]),
  operationDescriptor("entitlements", "admin", "POST", "/api/admin/entitlements/{id}/disable", ["id"]),
  operationDescriptor("entitlements", "admin", "POST", "/api/admin/entitlements/{id}/reenable", ["id"]),
  operationDescriptor("entitlements", "admin", "POST", "/api/admin/entitlements/{id}/revoke", ["id"]),
  operationDescriptor("entitlements", "reader", "GET", "/api/admin/events"),
] as const;
