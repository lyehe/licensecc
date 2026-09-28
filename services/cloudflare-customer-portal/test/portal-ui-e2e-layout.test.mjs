import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const expectedSpecs = [
  "portal-ui.consent.e2e.mjs", "portal-ui.devices-results.e2e.mjs", "portal-ui.devices-search.e2e.mjs",
  "portal-ui.e2e.mjs", "portal-ui.license-lifecycle.e2e.mjs", "portal-ui.network-failures.e2e.mjs",
  "portal-ui.nodes.e2e.mjs", "portal-ui.session-expired.e2e.mjs",
];

test("portal browser specs are discovered by pattern, not by imports", () => {
  const config = readFileSync(join(directory, "..", "playwright.config.mjs"), "utf8");
  const match = config.match(/testMatch:\s*(\/.+\/)[,\n]/u);
  assert.ok(match, "playwright.config.mjs must declare a testMatch pattern");
  const pattern = new Function(`return ${match[1]}`)();
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
  assert.equal(titles.length, 138);
  assert.equal(new Set(titles).size, titles.length, "browser scenario titles must be unique");
});
