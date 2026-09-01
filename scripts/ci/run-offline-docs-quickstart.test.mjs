import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runner = readFileSync(new URL("./run-offline-docs-quickstart.ps1", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const scriptCatalog = JSON.parse(readFileSync(new URL("../script-catalog.json", import.meta.url), "utf8"));
const linuxWorkflow = readFileSync(new URL("../../.github/workflows/linux.yml", import.meta.url), "utf8");

test("offline docs quickstart is an isolated, source-pure gate", () => {
  assert.match(runner, /Set-StrictMode -Version Latest/u);
  assert.match(runner, /Run the offline docs quickstart from the Licensecc repository root/u);
  assert.match(runner, /Join-Path [^\n]+ "build"/u);
  assert.match(runner, /"docs-quickstart"/u);
  assert.match(runner, /run-\$runId/u);
  assert.match(runner, /\.licensecc-docs-quickstart-owner/u);
  assert.match(runner, /Test-PathStrictlyWithin/u);
  assert.match(runner, /Remove-Item -LiteralPath \$resolvedWorkspace -Recurse -Force/u);
  assert.match(runner, /actualMarker.*-cne.*MarkerContent/su);
});

test("offline docs quickstart fingerprints source state and uses an explicit production-shaped build", () => {
  assert.match(runner, /Get-SourceSnapshot -RepositoryRoot \$RepositoryRoot/u);
  assert.match(runner, /Compare-SourceSnapshots -Before \$sourceBefore -After \$sourceAfter/u);
  assert.match(runner, /-DLCC_PROJECT_NAME=\$projectName/u);
  assert.match(runner, /-DLCC_PROJECTS_BASE_DIR=\$projectsBase/u);
  assert.match(runner, /-DBUILD_TESTING=OFF/u);
  assert.match(runner, /"--target", "install"/u);
  assert.match(runner, /Get-SingleBuiltExecutable -BuildRoot \$nativeBuild -Name "lccgen"/u);
  assert.match(runner, /Expected exactly one valid built \$Description/u);
  assert.match(runner, /-ProbeArguments @\("license", "issue", "--help"\)/u);
  assert.doesNotMatch(runner, /-DLCC_PROJECTS_BASE_DIR=\$RepositoryRoot/u);
});

test("offline docs quickstart verifies the installed minimal consumer and keeps the gate separate", () => {
  assert.match(runner, /licensePath = \[System\.IO\.Path\]::GetFullPath/u);
  assert.match(runner, /Test-PathStrictlyWithin -Child \$licensePath -Parent \$workspace\.Path/u);
  assert.match(runner, /examples[\\/]minimal/u);
  assert.match(runner, /-Dlicensecc_DIR=\$packageDirectory/u);
  assert.match(runner, /-DLCC_PROJECT_NAME=\$projectName/u);
  assert.match(runner, /runOutput\.StartsWith\("license OK"/u);
  assert.equal(typeof packageJson.scripts["test:docs-quickstart"], "string");
  assert.match(packageJson.scripts["test:docs-quickstart"], /run-offline-docs-quickstart\.ps1/u);
  assert.match(packageJson.scripts["test:docs-quickstart"], /run-offline-docs-quickstart\.test\.mjs/u);
  const cataloged = scriptCatalog.categories.flatMap((category) => category.paths);
  assert.ok(cataloged.includes("scripts/ci/run-offline-docs-quickstart.ps1"));
  assert.ok(cataloged.includes("scripts/ci/run-offline-docs-quickstart.test.mjs"));
  assert.match(
    linuxWorkflow,
    /name:\s*Offline documentation quickstart\s+if:\s*matrix\.preset == 'ci-linux-debug'\s+run:\s*pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\/ci\/run-offline-docs-quickstart\.ps1/u,
  );
});
