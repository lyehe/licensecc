import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const REQUIRED_BOUNDARIES = [
  "*",
  "/include/licensecc/",
  "/src/library/",
  "/test/",
  "/cmake/",
  "/CMakeLists.txt",
  "/CMakePresets.json",
  "/extern/license-generator/",
  "/packages/licensing-domain/",
  "/packages/cloudflare-runtime/",
  "/services/cloudflare-licensing-backend/",
  "/services/cloudflare-license-admin/",
  "/services/cloudflare-customer-portal/",
  "/services/cloudflare-d1-backup/",
  "/sdks/",
  "/test/contracts/",
  "/.github/",
  "/scripts/",
  "/package.json",
  "/package-lock.json",
  "/README.md",
  "/CONTRIBUTING.md",
  "/doc/",
  "/docs/implementation/",
  "/docs/superpowers/plans/",
];

function parseCodeowners(source) {
  const entries = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/u);
    assert.ok(!entries.has(pattern), `.github/CODEOWNERS duplicates ${pattern} on line ${index + 1}`);
    entries.set(pattern, owners);
  }
  return entries;
}

test("CODEOWNERS covers every documented repository ownership boundary", () => {
  const entries = parseCodeowners(readFileSync(resolve(repositoryRoot, ".github/CODEOWNERS"), "utf8"));
  assert.deepEqual([...entries.keys()], REQUIRED_BOUNDARIES);
  for (const [pattern, owners] of entries) {
    assert.equal(owners.length, 1, `${pattern} must have one unambiguous review fallback`);
    assert.match(owners[0], /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u, `${pattern} has an invalid GitHub owner`);
    assert.doesNotMatch(owners[0], /(?:todo|placeholder|example|unknown)/iu);
  }
});

test("ownership documentation declares the executable CODEOWNERS relationship", () => {
  const ownership = readFileSync(resolve(repositoryRoot, "doc/architecture/ownership.md"), "utf8");
  assert.match(ownership, /\.github\/CODEOWNERS/u);
  assert.match(ownership, /confirmed\s+repository account/u);
  assert.match(ownership, /role-specific GitHub teams/u);
});
