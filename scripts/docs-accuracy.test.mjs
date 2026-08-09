import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function source(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

test("backend documentation tracks the accepted C++ online API", () => {
  const backendReadme = source("services/cloudflare-licensing-backend/README.md");
  const publicHeader = source("include/licensecc/licensecc.h");
  const dataTypes = source("include/licensecc/datatypes.h");
  const implementation = source("src/library/licensecc.cpp");

  assert.match(publicHeader, /LCC_EVENT_TYPE\s+acquire_license_ex\s*\(/);
  assert.match(publicHeader, /LCC_EVENT_TYPE\s+lcc_acquire_license_decision\s*\(/);
  assert.match(dataTypes, /typedef\s+LCC_ONLINE_CALLBACK_STATUS\s+\(\*LCC_ONLINE_CHECK\)\s*\(/);
  assert.match(implementation, /LCC_EVENT_TYPE\s+acquire_license_ex\s*\(/);
  assert.match(implementation, /LCC_EVENT_TYPE\s+lcc_acquire_license_decision\s*\(/);

  assert.doesNotMatch(backendReadme, /not yet .*C\+\+|C\+\+.*not yet/i);
  assert.match(backendReadme, /For production C\+\+ hosts, use `lcc_acquire_license_decision\(\)`/);
  assert.match(backendReadme, /persisted revocation sequence/i);
  assert.match(backendReadme, /Windows\/Ubuntu TPM-provider\/request-proof\s+integration remains\s+plan-only/is);
  assert.match(backendReadme, /does not\s+claim TPM support/i);
});

test("organization evidence tracks the current unpublished candidate", () => {
  const report = source("docs/implementation/a-level-organization-report.md");

  assert.match(report, /final reviewed generator candidate `dbe2601f9bc0f55a386a14140d4b722b53348df6` remains unpublished\/unpinned/i);
  assert.match(report, /unpublished\/unpinned/i);
  assert.match(report, /superproject gitlink `0227a3e`/i);
  assert.match(report, /protected (?:WIP|nested revision) `dbbaed0`/i);
  assert.match(report, /conditional on maintainer approval and publication\/pinning/i);
  assert.doesNotMatch(
    report,
    /(?:reviewed generator candidate|embedded final reviewed candidate)[^\n]*`(?:f969e5f40bae55d61a98c208d6198b75cfb86fb3|4a716a5(?:93748d205a67dabf789c6fb39da9a975e)?)`/i,
  );
});

test("admin browser instructions and the PR gate keep docs checks honest", () => {
  const adminReadme = source("services/cloudflare-license-admin/README.md");
  const packageJson = JSON.parse(source("package.json"));

  assert.match(adminReadme, /npm run setup:browsers/);
  assert.match(adminReadme, /root.*setup:browsers.*both retained Playwright Chromium revisions/is);
  assert.match(adminReadme, /`npm run test:e2e` itself does not install\s+browsers/i);
  assert.doesNotMatch(adminReadme, /test:e2e` installs the Playwright/i);
  assert.equal(packageJson.scripts["test:docs-accuracy"], "node --test scripts/docs-accuracy.test.mjs");
  assert.match(packageJson.scripts["check:pr"], /npm run test:docs-accuracy/);
});
