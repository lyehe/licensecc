import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const expectedVersion = "4.120.0";
const workerPackages = [
  "services/cloudflare-licensing-backend",
  "services/cloudflare-license-admin",
  "services/cloudflare-customer-portal",
  "services/cloudflare-d1-backup",
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
}

test("all Worker workspaces use the locked Wrangler security pin", () => {
  const lockfile = readJson("package-lock.json");

  for (const packagePath of workerPackages) {
    const manifest = readJson(`${packagePath}/package.json`);
    const lockedPackage = lockfile.packages[packagePath];

    assert.equal(manifest.devDependencies?.wrangler, expectedVersion, `${packagePath}/package.json`);
    assert.ok(lockedPackage, `missing lock entry for ${packagePath}`);
    assert.equal(lockedPackage.devDependencies?.wrangler, expectedVersion, `${packagePath} lock entry`);
  }

  assert.equal(lockfile.packages["node_modules/wrangler"]?.version, expectedVersion);
  assert.match(lockfile.packages["node_modules/wrangler"]?.resolved ?? "", /wrangler-4\.120\.0\.tgz$/);
});
