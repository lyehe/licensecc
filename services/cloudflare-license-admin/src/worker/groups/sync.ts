import { operationDescriptor } from "../route-descriptor.js";

export const syncRoutes = [
  operationDescriptor("sync", "sync", "POST", "/api/sync/entitlements"),
] as const;
