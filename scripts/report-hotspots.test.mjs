import assert from "node:assert/strict";
import test from "node:test";

import { checkHotspotBaseline, collectHotspots, evaluateHotspotBaseline } from "./report-hotspots.mjs";

test("hotspot reporting is deterministic and production-source scoped", () => {
  const first = collectHotspots({ limit: 25 });
  const second = collectHotspots({ limit: 25 });
  assert.deepEqual(second, first);
  assert.equal(first.length, 25);
  for (let index = 0; index < first.length; index += 1) {
    assert.match(first[index].path, /^(?:src|packages\/[^/]+\/src|services\/[^/]+\/src)\//u);
    assert.doesNotMatch(first[index].path, /^src\/library\/ini\//u);
    assert.ok(first[index].lines > 0);
    if (index > 0) {
      assert.ok(
        first[index - 1].lines > first[index].lines ||
        (first[index - 1].lines === first[index].lines && first[index - 1].path < first[index].path),
      );
    }
  }
});

test("hotspot baseline allows shrinkage but rejects growth and new oversized files", () => {
  const baseline = {
    schema_version: 1,
    threshold_lines: 500,
    files: {
      "src/library/a.cpp": 700,
      "services/example/src/b.ts": 600,
    },
  };
  assert.deepEqual(evaluateHotspotBaseline(baseline, [
    { path: "src/library/a.cpp", lines: 650 },
    { path: "services/example/src/b.ts", lines: 600 },
    { path: "packages/example/src/small.ts", lines: 499 },
  ]), []);

  const errors = evaluateHotspotBaseline(baseline, [
    { path: "src/library/a.cpp", lines: 701 },
    { path: "services/example/src/b.ts", lines: 600 },
    { path: "packages/example/src/new.ts", lines: 500 },
  ]);
  assert.deepEqual(errors.map(({ code }) => code), ["HOTSPOT_GROWTH", "HOTSPOT_UNRATCHETED"]);
});

test("hotspot baseline rejects missing targets and malformed authority", () => {
  const errors = evaluateHotspotBaseline({
    schema_version: 2,
    threshold_lines: 0,
    files: {
      "src/library/missing.cpp": 500,
      "src/library/ini/vendor.cpp": -1,
    },
  }, []);
  assert.deepEqual(errors.map(({ code }) => code), [
    "HOTSPOT_BASELINE_MISSING_FILE",
    "HOTSPOT_BASELINE_PATH",
    "HOTSPOT_BASELINE_SCHEMA",
    "HOTSPOT_BASELINE_THRESHOLD",
  ]);
});

test("checked-in first-party hotspot ratchets match the current tree", () => {
  assert.deepEqual(checkHotspotBaseline().errors, []);
});
