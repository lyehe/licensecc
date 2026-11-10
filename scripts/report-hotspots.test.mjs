import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkHotspotBaseline, collectHotspots, collectProductionHotspots, evaluateHotspotBaseline } from "./report-hotspots.mjs";

function fixtureRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "licensecc-hotspots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
  return root;
}

function sourceFile(root, path, lines) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, "const value = 1;\n".repeat(lines));
  return absolute;
}

test("hotspot reporting follows an unstaged source move rather than reading its deleted cached path", t => {
  const root = fixtureRepository(t);
  const original = sourceFile(root, "packages/example/src/old.ts", 4);
  execFileSync("git", ["-C", root, "add", "packages/example/src/old.ts"]);
  unlinkSync(original);
  sourceFile(root, "services/example/src/local.ts", 4);

  assert.deepEqual(collectProductionHotspots({ root }), [{ path: "services/example/src/local.ts", lines: 4 }]);
});

test("new untracked production hotspots fail the ratchet while ignored source and build output stay excluded", t => {
  const root = fixtureRepository(t);
  writeFileSync(join(root, ".gitignore"), "build/\nservices/example/src/generated.ts\n");
  sourceFile(root, "src/library/existing.cpp", 1);
  sourceFile(root, "services/example/src/new.ts", 5);
  sourceFile(root, "services/example/src/generated.ts", 20);
  sourceFile(root, "build/output.cpp", 20);
  const hotspots = collectProductionHotspots({ root });

  assert.deepEqual(hotspots, [
    { path: "services/example/src/new.ts", lines: 5 },
    { path: "src/library/existing.cpp", lines: 1 },
  ]);
  assert.deepEqual(evaluateHotspotBaseline({
    schema_version: 1,
    threshold_lines: 5,
    files: { "src/library/existing.cpp": 1 },
  }, hotspots).map(({ code, path }) => ({ code, path })), [
    { code: "HOTSPOT_UNRATCHETED", path: "services/example/src/new.ts" },
  ]);
});

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
