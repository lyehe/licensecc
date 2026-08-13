import assert from "node:assert/strict";
import test from "node:test";

import { collectHotspots } from "./report-hotspots.mjs";

test("hotspot reporting is deterministic and production-source scoped", () => {
  const first = collectHotspots({ limit: 25 });
  const second = collectHotspots({ limit: 25 });
  assert.deepEqual(second, first);
  assert.equal(first.length, 25);
  for (let index = 0; index < first.length; index += 1) {
    assert.match(first[index].path, /^(?:src|packages\/[^/]+\/src|services\/[^/]+\/src)\//u);
    assert.ok(first[index].lines > 0);
    if (index > 0) {
      assert.ok(
        first[index - 1].lines > first[index].lines ||
        (first[index - 1].lines === first[index].lines && first[index - 1].path < first[index].path),
      );
    }
  }
});
