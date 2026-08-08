import { operationDescriptor } from "../route-descriptor.js";

export const webhookRoutes = [
  operationDescriptor("webhooks", "reader", "GET", "/api/admin/webhooks"),
  operationDescriptor("webhooks", "admin", "POST", "/api/admin/webhooks"),
  operationDescriptor("webhooks", "reader", "GET", "/api/admin/webhooks/deliveries"),
  operationDescriptor("webhooks", "admin", "POST", "/api/admin/webhooks/deliveries/{id}/redrive", ["id"]),
  operationDescriptor("webhooks", "reader", "GET", "/api/admin/webhooks/{id}", ["id"]),
  operationDescriptor("webhooks", "admin", "PATCH", "/api/admin/webhooks/{id}", ["id"]),
  operationDescriptor("webhooks", "admin", "POST", "/api/admin/webhooks/{id}/disable", ["id"]),
  operationDescriptor("webhooks", "admin", "POST", "/api/admin/webhooks/{id}/reenable", ["id"]),
] as const;
