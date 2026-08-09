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
  assert.match(backendReadme, /Windows\/Ubuntu TPM-provider\/request-proof\s+integration remains\s+plan-only/is);
  assert.match(backendReadme, /does not\s+claim TPM support/i);
});

test("organization evidence tracks the current unpublished candidate", () => {
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
  assert.match(
    report,
    /final reviewed generator candidate\s+`74996a7d345df7b9a7cb46a08d423cb738217ed1`\s+remains\s+unpublished\/unpinned/is,
  );
  assert.match(report, /unpublished\/unpinned/i);
  const gitlink = git(["ls-tree", "HEAD", "extern/license-generator"]).split(/\s+/u)[2];
  assert.match(report, new RegExp(`superproject gitlink \`${gitlink.slice(0, 7)}\``, "i"));

  const nestedPath = resolve(repositoryRoot, "extern", "license-generator");
  let nestedRoot = "";
  try {
    nestedRoot = git(["-C", nestedPath, "rev-parse", "--show-toplevel"]);
  } catch {
    // An uninitialized submodule has no local WIP state to verify.
  }
  if (nestedRoot.toLowerCase() === nestedPath.toLowerCase()) {
    const nestedHead = git(["-C", nestedPath, "rev-parse", "HEAD"]);
    if (nestedHead !== gitlink) {
      assert.match(report, new RegExp(`protected (?:WIP|nested revision) \`${nestedHead.slice(0, 7)}\``, "i"));
      const fixtures = git([
        "-C",
        nestedPath,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "*.lic",
      ]).split(/\r?\n/u).filter(Boolean);
      assert.match(report, new RegExp(`${fixtures.length} existing untracked \`\\.lic\``, "i"));
    }
  }

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

  assert.match(report, /conditional on maintainer approval and\s+publication\/pinning/is);
  assert.match(report, /timestamped command attestations/i);
  assert.match(report, /does not pretend to rerun or\s+continuously prove these historical command results/is);
  assert.doesNotMatch(
    report,
    /(?:reviewed generator candidate|embedded final reviewed candidate)[^\n]*`(?:f969e5f40bae55d61a98c208d6198b75cfb86fb3|dbe2601f9bc0f55a386a14140d4b722b53348df6|4a716a5(?:93748d205a67dabf789c6fb39da9a975e)?)`/i,
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
    "services/cloudflare-customer-portal/src/ui/main.tsx",
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
