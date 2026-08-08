// Keep the historical test entrypoint stable while route groups own focused coverage.
import "./worker/core-regressions.test.mjs";
import "./worker/meta.test.mjs";
import "./worker/summary-reports.test.mjs";
import "./worker/customers.test.mjs";
import "./worker/catalog.test.mjs";
import "./worker/policies.test.mjs";
import "./worker/entitlements.test.mjs";
import "./worker/devices.test.mjs";
import "./worker/webhooks.test.mjs";
import "./worker/sync.test.mjs";
import "./worker/structure.test.mjs";
