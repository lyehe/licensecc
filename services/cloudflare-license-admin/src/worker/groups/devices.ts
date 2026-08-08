import { operationDescriptor } from "../route-descriptor.js";

export const deviceRoutes = [
  operationDescriptor("devices", "admin", "POST", "/api/admin/entitlements/{id}/release-seats", ["id"]),
  operationDescriptor("devices", "reader", "GET", "/api/admin/entitlements/{id}/devices", ["id"]),
  operationDescriptor("devices", "reader", "GET", "/api/admin/entitlements/{id}/meter", ["id"]),
  operationDescriptor("devices", "admin", "POST", "/api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke", ["id", "deviceKeyId"]),
  operationDescriptor("devices", "admin", "POST", "/api/admin/entitlements/{id}/devices/{deviceKeyId}/disable", ["id", "deviceKeyId"]),
  operationDescriptor("devices", "admin", "POST", "/api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable", ["id", "deviceKeyId"]),
] as const;
