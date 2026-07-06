import assert from "node:assert/strict";
import { test } from "node:test";
import { startScheduledBackupWorkflow } from "../dist/scheduled.js";

class MockWorkflow {
  constructor() {
    this.created = [];
  }

  async create(options = {}) {
    this.created.push(options);
    return {
      id: options.id ?? "scheduled-test-id",
      status: async () => ({ state: "queued" }),
    };
  }
}

test("scheduled helper creates a scheduled workflow instance", async () => {
  const workflow = new MockWorkflow();

  await startScheduledBackupWorkflow({
    cron: "0 3 * * *",
    scheduledTime: Date.parse("2026-06-06T03:00:00.000Z"),
  }, {
    D1_BACKUP_WORKFLOW: workflow,
  });

  assert.equal(workflow.created.length, 1);
  assert.match(workflow.created[0].id, /^scheduled-20260606T03000000-[0-9a-f-]{8}$/);
  assert.deepEqual(workflow.created[0].params, {
    trigger: "scheduled",
    reason: "cron:0 3 * * *",
  });
});
