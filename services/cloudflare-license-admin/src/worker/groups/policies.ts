import { operationDescriptor } from "../route-descriptor.js";

export const policyRoutes = [
  operationDescriptor("policies", "reader", "GET", "/api/admin/policies"),
  operationDescriptor("policies", "admin", "POST", "/api/admin/policies"),
  operationDescriptor("policies", "reader", "GET", "/api/admin/policies/{id}", ["id"]),
  operationDescriptor("policies", "admin", "PATCH", "/api/admin/policies/{id}", ["id"]),
  operationDescriptor("policies", "admin", "POST", "/api/admin/policies/{id}/disable", ["id"]),
  operationDescriptor("policies", "admin", "POST", "/api/admin/policies/{id}/reenable", ["id"]),
] as const;
