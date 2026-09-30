import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import config from "../playwright.config.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const expectedSpecs = [
  "portal-ui.consent.e2e.mjs", "portal-ui.devices-search.e2e.mjs",
  "portal-ui.e2e.mjs", "portal-ui.license-lifecycle.e2e.mjs", "portal-ui.network-failures.e2e.mjs",
  "portal-ui.nodes.e2e.mjs", "portal-ui.session-expired.e2e.mjs",
];

test("portal browser specs are discovered by pattern, not by imports", () => {
  const pattern = config.testMatch;
  assert.ok(pattern instanceof RegExp, "playwright.config.mjs testMatch must stay a single RegExp");
  const discovered = readdirSync(directory).filter((path) => pattern.test(path)).sort();
  assert.deepEqual(discovered, expectedSpecs);
  const entry = readFileSync(join(directory, "portal-ui.e2e.mjs"), "utf8");
  assert.doesNotMatch(entry, /^import\s+["']\.\/portal-ui\.[^"']+\.e2e\.mjs["'];/mu, "no spec may run only through a side-effect import");

  // Titles may be single- or double-quoted across these specs, so both are captured.
  const titles = [];
  for (const path of discovered) {
    const source = readFileSync(join(directory, path), "utf8");
    const localTitles = [...source.matchAll(/^test\((?:"([^"]+)"|'([^']+)')/gmu)].map((titleMatch) => titleMatch[1] ?? titleMatch[2]);
    assert.ok(localTitles.length > 0, `${path} must own browser scenarios`);
    titles.push(...localTitles);
  }
  // This counts only top-level test( titles; loop-built and describe-nested tests are not
  // anchored at column 0, so the Playwright run total (128) is higher than this count.
  assert.equal(titles.length, 110);
  assert.equal(new Set(titles).size, titles.length, "browser scenario titles must be unique");
});
