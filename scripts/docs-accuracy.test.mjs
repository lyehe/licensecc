import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function source(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  }).trim();
}

function sha256(relativePath) {
  return createHash("sha256").update(readFileSync(resolve(repositoryRoot, relativePath))).digest("hex");
}

function lineCount(relativePath) {
  const text = source(relativePath).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function trackedSourceStats(relativeRoot) {
  const files = git(["ls-files", "--", relativeRoot])
    .split(/\r?\n/u)
    .filter((path) => /\.(?:js|mjs|ts|tsx)$/u.test(path));
  return {
    files: files.length,
    lines: files.reduce((total, path) => total + lineCount(path), 0),
  };
}

function trackedChildDirectories(relativeRoot) {
  const prefix = `${relativeRoot}/`;
  return [...new Set(git(["ls-files", "--", relativeRoot])
    .split(/\r?\n/u)
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).split("/", 1)[0]))]
    .sort();
}

function sqlTableNames(relativePath) {
  const names = [...source(relativePath).matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/giu,
  )].map((match) => match[1] ?? match[2]);
  return [...new Set(names)].sort();
}

function playwrightInventory(relativeWorkspace) {
  const workspaceCli = resolve(repositoryRoot, relativeWorkspace, "node_modules", "@playwright", "test", "cli.js");
  const cli = existsSync(workspaceCli)
    ? workspaceCli
    : resolve(repositoryRoot, "node_modules", "@playwright", "test", "cli.js");
  const output = execFileSync(
    process.execPath,
    [cli, "test", "--config", "playwright.config.mjs", "--list"],
    { cwd: resolve(repositoryRoot, relativeWorkspace), encoding: "utf8" },
  );
  const match = /Total:\s+(\d+)\s+tests?/u.exec(output);
  assert.ok(match, `Playwright did not report a test inventory for ${relativeWorkspace}`);
  return Number(match[1]);
}

function nodeTestInventory(relativeDirectory) {
  return readdirSync(resolve(repositoryRoot, relativeDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .reduce((total, entry) => {
      const contents = source(`${relativeDirectory}/${entry.name}`);
      return total + [...contents.matchAll(/(?:^|\n)\s*test\s*\(/gu)].length;
    }, 0);
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
  assert.match(
    backendReadme,
    /C\+\+ client runtime\s+provides conditional Windows Platform KSP and Ubuntu TPM2\/OpenSSL provider\s+surfaces/is,
  );
  assert.doesNotMatch(backendReadme, /TPM-provider\/request-proof\s+integration remains\s+plan-only/is);
  assert.match(backendReadme, /does not\s+claim\s+TPM\s+support/i);
});

test("organization evidence tracks the repository-owned generator snapshot", () => {
  const report = source("docs/implementation/a-level-organization-report.md");

  let implementationTipAvailable = false;
  try {
    git(["cat-file", "-e", "4f33243b09f27db83e090b914f2fb0d776c34302^{commit}"]);
    implementationTipAvailable = true;
  } catch {
    // A depth-one checkout can still verify the reproducible tree facts below.
  }
  if (implementationTipAvailable) {
    assert.doesNotThrow(() => git([
      "merge-base",
      "--is-ancestor",
      "4f33243b09f27db83e090b914f2fb0d776c34302",
      "HEAD",
    ]));
  }

  assert.match(report, /final integrated implementation tip is\s+`4f33243b09f27db83e090b914f2fb0d776c34302`/i);
  const generatorRoot = "extern/license-generator";
  const provenance = source(`${generatorRoot}/PROVENANCE.md`);
  const trackedGeneratorFiles = git(["ls-files", "--stage", "--", generatorRoot])
    .split(/\r?\n/u)
    .filter(Boolean);

  assert.ok(trackedGeneratorFiles.length > 0, "generator source must be normal tracked files");
  assert.ok(
    trackedGeneratorFiles.every((entry) => entry.startsWith("100")),
    "generator source must not be a gitlink",
  );
  assert.equal(git(["ls-files", "--", ".gitmodules"]), "", "the repository must not retain submodule metadata");
  assert.match(provenance, /74996a7d345df7b9a7cb46a08d423cb738217ed1/);
  assert.match(provenance, /BSD 3-Clause/i);
  assert.match(report, /reviewed generator snapshot\s+`74996a7d345df7b9a7cb46a08d423cb738217ed1`\s+is now ordinary tracked source/is);
  assert.match(report, /no `\.gitmodules`\s+entry, generator gitlink, or build-time source fetch remains/is);

  const protectedPlans = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "docs/superpowers/plans",
  ]).split(/\r?\n/u).filter(Boolean);
  if (protectedPlans.length > 0) {
    assert.match(report, new RegExp(`the ${protectedPlans.length} untracked .*execution\\s+plans`, "is"));
  }

  assert.match(report, /until the three remaining evidence items above are\s+completed/is);
  assert.match(report, /timestamped command attestations/i);
  assert.match(report, /does not pretend to rerun or\s+continuously prove these historical command results/is);
  assert.doesNotMatch(
    report,
    /(?:reviewed generator snapshot|embedded reviewed generator source)[^\n]*`(?:f969e5f40bae55d61a98c208d6198b75cfb86fb3|dbe2601f9bc0f55a386a14140d4b722b53348df6|4a716a5(?:93748d205a67dabf789c6fb39da9a975e)?)`/i,
  );
});

test("organization evidence derives canonical, schema, source, and E2E facts", () => {
  const report = source("docs/implementation/a-level-organization-report.md");
  const contractCases = [
    ["Backend", "backend", (value) => `${value.routeCount} / ${value.openApiOperationCount}`],
    ["Admin", "admin", (value) => `${value.routeCount} / ${value.openApiOperationCount}`],
    ["Portal", "portal", (value) => `${value.routeCount} routes / ${value.openApiOperationCount} operations`],
  ];

  for (const [label, name, inventory] of contractCases) {
    const relativePath = `test/contracts/${name}.json`;
    const contract = JSON.parse(source(relativePath));
    const row = `| ${label} | ${inventory(contract)} | \`${sha256(relativePath)}\` |`;
    assert.ok(report.includes(row), `report must derive the current ${name} contract row`);
  }
  assert.ok(
    report.includes(`\`${sha256("test/contracts/backup.json")}\``),
    "report must derive the current backup contract hash",
  );

  const d1Tables = sqlTableNames("services/cloudflare-licensing-backend/schema.sql");
  const pgTables = sqlTableNames("services/cloudflare-licensing-backend/supabase-postgres/schema.pg.sql");
  assert.deepEqual(pgTables, d1Tables, "D1 and PostgreSQL documented table inventories must match");
  assert.match(report, new RegExp(`green at ${d1Tables.length} tables`, "i"));

  const sourceCases = [
    ["Admin", "services/cloudflare-license-admin/src"],
    ["Licensing backend", "services/cloudflare-licensing-backend/src"],
    ["Customer portal", "services/cloudflare-customer-portal/src"],
    ["D1 backup", "services/cloudflare-d1-backup/src"],
  ];
  for (const [label, relativeRoot] of sourceCases) {
    const stats = trackedSourceStats(relativeRoot);
    const row = `| ${label} | ${stats.files} | ${stats.lines.toLocaleString("en-US")} |`;
    assert.ok(report.includes(row), `report must derive current source totals for ${label}`);
  }

  const compositionCases = [
    ["Backend Worker", "services/cloudflare-licensing-backend/src/index.ts", "services/cloudflare-licensing-backend/src/app.ts"],
    ["Admin Worker", "services/cloudflare-license-admin/src/worker/index.ts", "services/cloudflare-license-admin/src/worker/app.ts"],
    ["Admin UI", "services/cloudflare-license-admin/src/ui/main.tsx", "services/cloudflare-license-admin/src/ui/app/App.tsx"],
    ["Portal Worker", "services/cloudflare-customer-portal/src/worker/index.ts", "services/cloudflare-customer-portal/src/worker/app.ts"],
    ["Portal UI", "services/cloudflare-customer-portal/src/ui/main.tsx", "services/cloudflare-customer-portal/src/ui/app/App.tsx"],
  ];
  for (const [label, entry, app] of compositionCases) {
    const row = `| ${label} | ${lineCount(entry)} | ${lineCount(app)} |`;
    assert.ok(report.includes(row), `report must derive current composition-root counts for ${label}`);
  }

  const hotspotCases = [
    "src/library/licensecc.cpp",
    "services/cloudflare-license-admin/src/worker/openapi/components.ts",
    "services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs",
    "services/cloudflare-licensing-backend/src/routes/verify.ts",
    "services/cloudflare-license-admin/src/ui/features/catalog/Catalog.tsx",
    "services/cloudflare-customer-portal/src/ui/features/devices/DevicesFeature.tsx",
    "services/cloudflare-d1-backup/src/core.ts",
  ];
  for (const relativePath of hotspotCases) {
    const row = `| \`${relativePath}\` | ${lineCount(relativePath).toLocaleString("en-US")} |`;
    assert.ok(report.includes(row), `report must derive current hotspot count for ${relativePath}`);
  }

  const adminE2e = playwrightInventory("services/cloudflare-license-admin");
  const portalE2e = playwrightInventory("services/cloudflare-customer-portal");
  const backendE2e = nodeTestInventory("services/cloudflare-licensing-backend/test/e2e");
  assert.match(
    report,
    new RegExp(`current non-running inventory is backend ${backendE2e}, admin ${adminE2e}, portal ${portalE2e}`, "i"),
  );
});

test("architecture documentation derives the SDK inventory and current measurements", () => {
  const systemMap = source("doc/architecture/system-map.md");
  const ownership = source("doc/architecture/ownership.md");
  const changeGuide = source("doc/architecture/change-guide.md");
  const docsIndex = source("doc/index.rst");
  const packageJson = JSON.parse(source("package.json"));

  assert.deepEqual(
    trackedChildDirectories("sdks"),
    ["dotnet", "java", "python"],
    "the reviewed SDK inventory must change deliberately",
  );
  assert.match(systemMap, /`sdks\/` \| Python, \.NET, and Java client surfaces/);
  assert.match(docsIndex, /Python, \.NET, and Java client SDKs/);
  for (const sdkPath of ["sdks/python/", "sdks/dotnet/", "sdks/java/"]) {
    assert.ok(ownership.includes(`\`${sdkPath}\``), `ownership must name ${sdkPath}`);
    assert.ok(changeGuide.includes(`\`${sdkPath}\``), `change guide must route ${sdkPath}`);
  }
  assert.match(packageJson.scripts["test:sdks"], /sdks\/python/);
  assert.match(packageJson.scripts["test:sdks"], /sdks\/dotnet/);
  assert.match(packageJson.scripts["test:sdks"], /test:java-sdk/);
  assert.match(source("scripts/test-java-sdk.mjs"), /join\(root,\s*"sdks",\s*"java"/);

  const sourceCases = [
    ["license-admin", "services/cloudflare-license-admin/src"],
    ["licensing-backend", "services/cloudflare-licensing-backend/src"],
    ["customer-portal", "services/cloudflare-customer-portal/src"],
    ["D1-backup", "services/cloudflare-d1-backup/src"],
  ];
  for (const [label, relativeRoot] of sourceCases) {
    const { lines } = trackedSourceStats(relativeRoot);
    assert.match(
      systemMap,
      new RegExp(`${lines.toLocaleString("en-US")}\\s+lines for\\s+${label}`, "u"),
      `system map must derive the current ${label} source total`,
    );
  }

  const compositionCases = [
    ["Backend", "services/cloudflare-licensing-backend/src/index.ts", "services/cloudflare-licensing-backend/src/app.ts"],
    ["Admin Worker", "services/cloudflare-license-admin/src/worker/index.ts", "services/cloudflare-license-admin/src/worker/app.ts"],
    ["Admin UI", "services/cloudflare-license-admin/src/ui/main.tsx", "services/cloudflare-license-admin/src/ui/app/App.tsx"],
    ["Portal Worker", "services/cloudflare-customer-portal/src/worker/index.ts", "services/cloudflare-customer-portal/src/worker/app.ts"],
    ["Portal UI", "services/cloudflare-customer-portal/src/ui/main.tsx", "services/cloudflare-customer-portal/src/ui/app/App.tsx"],
  ];
  for (const [label, entry, app] of compositionCases) {
    const row = `| ${label} \`${entry.slice(entry.indexOf("src/"))}\` / \`${app.slice(app.indexOf("src/"))}\` | ${lineCount(entry)} | ${lineCount(app)} |`;
    assert.ok(systemMap.includes(row), `system map must derive current composition counts for ${label}`);
  }

  const hotspotCases = [
    "src/library/licensecc.cpp",
    "services/cloudflare-license-admin/src/worker/openapi/components.ts",
    "services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs",
    "services/cloudflare-licensing-backend/src/routes/verify.ts",
    "services/cloudflare-license-admin/src/ui/features/catalog/Catalog.tsx",
    "services/cloudflare-customer-portal/src/ui/features/devices/DevicesFeature.tsx",
    "services/cloudflare-d1-backup/src/core.ts",
  ];
  for (const relativePath of hotspotCases) {
    const row = `| \`${relativePath}\` | ${lineCount(relativePath).toLocaleString("en-US")} |`;
    assert.ok(systemMap.includes(row), `system map must derive current hotspot count for ${relativePath}`);
  }
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

test("the API reference is generated from authoritative interfaces", () => {
  const docsIndex = source("doc/index.rst");
  const apiIndex = source("doc/api/index.rst");
  const services = source("doc/api/services.rst");
  const python = source("doc/api/python.rst");
  const deviceHeader = source("include/licensecc/device_identity.h");
  const docsScript = source("scripts/check-docs.ps1");
  const readTheDocs = source(".readthedocs.yaml");

  assert.match(docsIndex, /api\/index/);
  for (const page of ["public_api", "types", "device_identity", "services", "python", "sdks"]) {
    assert.match(apiIndex, new RegExp(`\\b${page}\\b`, "u"), `API index must include ${page}`);
  }

  for (const service of ["backend", "admin", "portal"]) {
    assert.match(
      services,
      new RegExp(`licensecc-openapi::\\s+${service}`, "u"),
      `service reference must derive ${service} operations from its canonical snapshot`,
    );
  }
  assert.doesNotMatch(services, /\/v1\/verify\s+POST/u, "Worker routes must not be copied into prose tables");

  assert.match(python, /autofunction:: verify_online_assertion/);
  assert.match(python, /autoclass:: HttpClient/);
  assert.match(docsScript, /--with\s+\$pythonSdk/u);
  assert.match(readTheDocs, /path:\s+sdks\/python/u);

  assert.match(deviceHeader, /\\defgroup deviceidentity/u);
  assert.match(deviceHeader, /lcc_device_identity_open/u);
  assert.match(deviceHeader, /lcc_device_identity_delete_key/u);
});

test("the repository workflow guide and Agent Skill remain discoverable", () => {
  const readme = source("README.md");
  const guide = source("doc/usage/repository-workflows.rst");
  const skill = source(".agents/skills/using-licensecc/SKILL.md");
  const skillUi = source(".agents/skills/using-licensecc/agents/openai.yaml");
  const packageJson = JSON.parse(source("package.json"));

  assert.match(readme, /doc\/usage\/repository-workflows\.rst/u);
  assert.match(readme, /`\.agents\/skills\/`/u);
  assert.match(guide, /\$using-licensecc/u);
  assert.match(guide, /npm run check:pr/u);
  assert.match(guide, /scripts\/check-build-purity\.ps1/u);

  const frontmatter = /^---\r?\nname:\s*([^\r\n]+)\r?\ndescription:\s*([^\r\n]+)\r?\n---/u.exec(skill);
  assert.ok(frontmatter, "the repository skill must have minimal YAML frontmatter");
  assert.equal(frontmatter[1], "using-licensecc");
  assert.ok(frontmatter[2].length > 0 && frontmatter[2].length <= 1024);
  assert.doesNotMatch(frontmatter[2], /<[^>]+>/u, "skill descriptions cannot contain XML tags");
  assert.doesNotMatch(skill, /\[TODO|\\\\/u, "the skill must be complete and use portable paths");
  assert.ok(skill.split(/\r?\n/u).length < 500, "the skill must remain context-efficient");
  assert.match(skillUi, /default_prompt:\s*"[^"]*\$using-licensecc/u);

  for (const command of ["check:pr", "test:sdks", "setup:browsers", "test:e2e", "check:dry-run", "check:docs"]) {
    assert.equal(typeof packageJson.scripts[command], "string", `skill command ${command} must remain defined`);
    assert.match(skill, new RegExp(`npm run ${command}`, "u"));
  }
});
