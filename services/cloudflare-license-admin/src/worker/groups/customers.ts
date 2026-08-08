import { operationDescriptor } from "../route-descriptor.js";

export const customerRoutes = [
  operationDescriptor("customers", "reader", "GET", "/api/admin/customers"),
  operationDescriptor("customers", "reader", "GET", "/api/admin/customers/{id}", ["id"]),
  operationDescriptor("customers", "admin", "POST", "/api/admin/customers/{id}/disable", ["id"]),
  operationDescriptor("customers", "admin", "POST", "/api/admin/customers/{id}/reenable", ["id"]),
  operationDescriptor("customers", "reader", "GET", "/api/admin/licenses"),
  operationDescriptor("customers", "reader", "GET", "/api/admin/orders"),
  operationDescriptor("customers", "reader", "GET", "/api/admin/search"),
] as const;
