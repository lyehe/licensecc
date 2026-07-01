-- Per-tenant webhook endpoint scoping (audit R2.2). Global webhook_endpoints received EVERY tenant's
-- entitlement/customer/order events (full prev/next row snapshots), so one misconfigured endpoint
-- URL was a cross-customer data siphon. Add an optional scope: an endpoint scoped to a project (and/or
-- a customer) receives ONLY events that carry AND match that dimension; NULL (the back-compat default
-- for existing endpoints) = unscoped/global. Enforced in the enqueue pass (src/webhooks/webhook.mjs).
ALTER TABLE webhook_endpoints ADD COLUMN scope_project TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN scope_customer_id TEXT;
