import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const expectedSpecs = [
  "admin-ui.catalog.e2e.mjs",
  "admin-ui.consequences.e2e.mjs",
  "admin-ui.lifecycle.e2e.mjs",
  "admin-ui.reads.e2e.mjs",
  "admin-ui.recovery.e2e.mjs",
];

test("admin browser coverage stays partitioned by operator concern", () => {
  const actualSpecs = readdirSync(directory)
    .filter((path) => /^admin-ui\.[^.]+\.e2e\.mjs$/u.test(path))
    .sort();
  assert.deepEqual(actualSpecs, expectedSpecs);

  const titles = [];
  for (const path of actualSpecs) {
    const source = readFileSync(join(directory, path), "utf8");
    const localTitles = [...source.matchAll(/^test\("([^"]+)"/gmu)].map((match) => match[1]);
    assert.ok(localTitles.length > 0, `${path} must own browser scenarios`);
    titles.push(...localTitles);
  }
  assert.equal(titles.length, 66);
  assert.equal(new Set(titles).size, titles.length, "browser scenario titles must be unique");

  const fixture = readFileSync(join(directory, "admin-ui.fixture.mjs"), "utf8");
  assert.match(fixture, /export function makeAdminApiFixture\(\)/u);
  assert.doesNotMatch(fixture, /^test\(/gmu);
});
