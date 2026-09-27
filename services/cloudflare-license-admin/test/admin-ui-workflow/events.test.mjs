import assert from "node:assert/strict";
import test from "node:test";
import { entitlementId } from "@licensecc/licensing-domain/entitlements/contracts";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds filtered events API paths", async () => {
  const workflow = await loadWorkflowModule("features/events/workflow.ts");
  assert.equal(workflow.eventsPath(workflow.emptyEventFilter), "/api/admin/events");
  assert.equal(
    workflow.eventsPath({ ...workflow.emptyEventFilter, project: "DEFAULT", feature: "pro seats", event_type: "disable", actor: "ops@example.com" }),
    "/api/admin/events?project=DEFAULT&feature=pro+seats&event_type=disable&actor=ops%40example.com",
  );
  const id = entitlementId("DEFAULT", "pro", "a".repeat(64));
  assert.equal(workflow.eventsPath({ ...workflow.emptyEventFilter, entitlement_id: id }), `/api/admin/events?entitlement_id=${encodeURIComponent(id)}`);
  // A cursor is appended last and is passed through opaquely (never parsed by the UI).
  assert.equal(workflow.eventsPath(workflow.emptyEventFilter, "1700000000:42"), "/api/admin/events?cursor=1700000000%3A42");
});

test("admin UI workflow converts since/until date filters to a UTC-inclusive epoch range", async () => {
  const workflow = await loadWorkflowModule("features/events/workflow.ts");
  const path = workflow.eventsPath({ ...workflow.emptyEventFilter, since: "2024-03-09", until: "2024-03-09" });
  const params = new URLSearchParams(path.split("?")[1]);
  // since is UTC midnight; until is the SAME day's last second, so a same-day range is non-empty.
  assert.equal(params.get("since"), "1709942400");
  assert.equal(params.get("until"), "1710028799");
  // A malformed date-shaped value (never produced by a native <input type="date">) is dropped
  // rather than thrown, so a defensive caller cannot crash the filter bar.
  assert.equal(workflow.eventsPath({ ...workflow.emptyEventFilter, since: "not-a-date" }), "/api/admin/events");
});

test("admin UI workflow flags a single-entitlement events deep link and Show all drops it", async () => {
  const workflow = await loadWorkflowModule("features/events/workflow.ts");
  assert.equal(workflow.isSingleEntitlementEventsFilter(workflow.emptyEventFilter), false);
  assert.equal(workflow.isSingleEntitlementEventsFilter({ entitlement_id: "" }), false);
  assert.equal(workflow.isSingleEntitlementEventsFilter({ entitlement_id: "ent-1" }), true);
  assert.deepEqual(
    workflow.eventsFilterAfterShowAll({ ...workflow.emptyEventFilter, project: "DEFAULT", entitlement_id: "ent-1" }),
    { ...workflow.emptyEventFilter, project: "DEFAULT" },
  );
});
