import assert from "node:assert/strict";
import { test } from "node:test";

import { wranglerArgs } from "../scripts/time-travel.mjs";

test("restore requires --i-understand-target to exactly match --database (R4.6)", () => {
  const base = { _: "restore", database: "prod-db", confirm: "1", timestamp: "1700000000" };
  // Missing the re-typed target -> refused (the destructive path is not weaker than the scratch drill).
  assert.throws(() => wranglerArgs({ ...base }), /i-understand-target/);
  // A mismatched target (fat-finger / wrong DB) -> refused.
  assert.throws(() => wranglerArgs({ ...base, "i-understand-target": "wrong-db" }), /i-understand-target/);
  // Exact re-type -> allowed.
  const args = wranglerArgs({ ...base, "i-understand-target": "prod-db" });
  assert.ok(args.includes("restore"));
  assert.ok(args.includes("prod-db"));
});

test("restore still requires --confirm and a timestamp/bookmark (R4.6 keeps the prior guards)", () => {
  assert.throws(() => wranglerArgs({ _: "restore", database: "d", "i-understand-target": "d" }), /--confirm/);
  assert.throws(
    () => wranglerArgs({ _: "restore", database: "d", confirm: "1", "i-understand-target": "d" }),
    /timestamp or --bookmark/,
  );
});

test("info does not require the destructive guard (R4.6)", () => {
  const args = wranglerArgs({ _: "info", database: "prod-db" });
  assert.ok(args.includes("info"));
  assert.ok(args.includes("prod-db"));
});
