export const SNAPSHOT_INVENTORY_ALGORITHM = "d1-export-sql-insert-count-v1";

// Durable data whose row counts bind a produced snapshot to the restore proof.
export const SNAPSHOT_COUNTED_TABLES = Object.freeze([
  "device_bound_devices",
  "device_bound_bindings",
  "device_bound_events",
  "device_bound_operations",
  "entitlements",
  "entitlement_events",
  "mutation_idempotency",
  "customers",
  "licenses",
  "orders",
  "order_events",
  "customer_events",
  "entitlement_policies",
  "policy_events",
  "webhook_endpoints",
  "audit_digests",
  "catalog_features",
  "catalog_plans",
  "catalog_plan_features",
  "license_plan_assignments",
  "catalog_events",
  "webhook_events",
  "license_plan_assignment_events",
]);
