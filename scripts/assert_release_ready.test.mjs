import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  REQUIRED_LOCAL_COMMANDS,
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_RESULTS,
  analyzeSummary,
  duplicateResultLabels,
  externalCommandRedactionFailures,
  externalInputShapeFailures,
  failedResultLabels,
  invalidResultLabels,
  invalidResultStatuses,
  loadSummary,
  localCommandEvidenceFailures,
  parseArgs,
  resultMetadataFailures,
  skippedResultLabels,
  topLevelShapeFailures,
} from "./assert_release_ready.mjs";

function passedResult(label) {
  let command = REQUIRED_LOCAL_COMMANDS.get(label) ?? `run ${label}`;
  if (label === "Cloudflare Access admin staging drill") {
    command = "node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --url <redacted-admin-url>";
  }
  if (label === "Cloudflare R2 backup restore staging drill") {
    command = [
      "node services/cloudflare-d1-backup/scripts/restore-drill.mjs",
      "--bucket",
      "<redacted-r2-bucket>",
      "--object-key",
      "<redacted-r2-object-key>",
      "--scratch-database",
      "<redacted-scratch-d1>",
      "--confirm-scratch",
      "--remote",
    ].join(" ");
  }
  if (label === "Cloudflare backup deployment staging drill") {
    command = [
      "node services/cloudflare-d1-backup/scripts/validate-deploy.mjs",
      "--url",
      "<redacted-backup-url>",
      "--worker-name",
      "<redacted-backup-worker>",
      "--workflow-name",
      "<redacted-backup-workflow>",
      "--require-d1-rest-token",
      "--json",
    ].join(" ");
  }
  if (label === "Cloudflare public verifier abuse staging drill") {
    command = "node services/cloudflare-online-verifier/scripts/public-verifier-drill.mjs --url <redacted-verifier-url> --expect-rate-limit --json";
  }
  return {
    label,
    status: 0,
    command,
    duration_ms: 0,
  };
}

function productionSummary(overrides = {}) {
  return {
    ok: true,
    complete: true,
    production_ready: true,
    quick: false,
    full: true,
    external: true,
    require_external: true,
    skipped: 0,
    generated_at: "2026-06-05T00:00:00.000Z",
    platform: "win32",
    node_version: "v22.12.0",
    cwd: "C:\\Users\\HEQ\\Projects\\licensecc",
    blocking_reasons: [],
    external_inputs_present: {
      access_admin: true,
      access_non_admin_jwt: false,
      r2_restore: true,
      backup_deploy: true,
      public_verifier_abuse: true,
    },
    results: [
      ...REQUIRED_LOCAL_RESULTS.map(passedResult),
      ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
    ],
    ...overrides,
  };
}

test("release readiness parser accepts one summary path", () => {
  const options = parseArgs(["node", "assert_release_ready.mjs", "build/release-gates/production-latest.json"]);
  assert.equal(options.jsonPath, "build/release-gates/production-latest.json");
});

test("release readiness accepts a complete strict production summary", () => {
  const analysis = analyzeSummary(productionSummary());
  assert.equal(analysis.ready, true);
  assert.deepEqual(analysis.failures, []);
});

test("release readiness requires public verifier external input evidence", () => {
  const analysis = analyzeSummary(productionSummary({
    external_inputs_present: {
      access_admin: true,
      access_non_admin_jwt: false,
      r2_restore: true,
      backup_deploy: true,
      public_verifier_abuse: false,
    },
  }));

  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /external_inputs_present\.public_verifier_abuse must be true/);
  assert.doesNotMatch(analysis.failures.join("\n"), /Cloudflare public verifier abuse staging drill must be present with status 0/);
});

test("release readiness rejects skipped external validations", () => {
  const analysis = analyzeSummary(productionSummary({
    complete: false,
    production_ready: false,
    skipped: 1,
    blocking_reasons: [
      {
        type: "external_gate_skipped",
        label: "Cloudflare Access admin staging drill",
        reason: "credentials missing",
      },
    ],
  }));
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /summary\.complete must be true/);
  assert.match(analysis.failures.join("\n"), /summary\.production_ready must be true/);
  assert.match(analysis.failures.join("\n"), /summary\.blocking_reasons must be empty/);
});

test("release readiness does not require run command templates for skipped external drills", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    {
      label: "Cloudflare Access admin staging drill",
      command: "not run: Cloudflare Access admin staging drill",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
    {
      label: "Cloudflare R2 backup restore staging drill",
      command: "not run: Cloudflare R2 backup restore staging drill",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
    {
      label: "Cloudflare backup deployment staging drill",
      command: "not run: Cloudflare backup deployment staging drill",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
    {
      label: "Cloudflare public verifier abuse staging drill",
      command: "not run: Cloudflare public verifier abuse staging drill",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
  ];
  const analysis = analyzeSummary(productionSummary({
    complete: false,
    production_ready: false,
    skipped: 4,
    external_inputs_present: {
      access_admin: false,
      access_non_admin_jwt: false,
      r2_restore: false,
      backup_deploy: false,
      public_verifier_abuse: false,
    },
    results,
  }));

  assert.deepEqual(externalCommandRedactionFailures(results), []);
  assert.equal(analysis.ready, false);
  assert.doesNotMatch(analysis.failures.join("\n"), /command must match the redacted command template/);
  assert.match(analysis.failures.join("\n"), /Cloudflare Access admin staging drill result must not be skipped/);
  assert.match(analysis.failures.join("\n"), /Cloudflare R2 backup restore staging drill result must not be skipped/);
  assert.match(analysis.failures.join("\n"), /Cloudflare backup deployment staging drill result must not be skipped/);
  assert.match(analysis.failures.join("\n"), /Cloudflare public verifier abuse staging drill result must not be skipped/);
  assert.doesNotMatch(analysis.failures.join("\n"), /Cloudflare Access admin staging drill must be present with status 0/);
  assert.doesNotMatch(analysis.failures.join("\n"), /Cloudflare R2 backup restore staging drill must be present with status 0/);
  assert.doesNotMatch(analysis.failures.join("\n"), /Cloudflare backup deployment staging drill must be present with status 0/);
  assert.doesNotMatch(analysis.failures.join("\n"), /Cloudflare public verifier abuse staging drill must be present with status 0/);
});

test("release readiness rejects skipped external drill commands with staging details", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    {
      label: "Cloudflare Access admin staging drill",
      command: "not run: https://admin.example",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
    {
      label: "Cloudflare R2 backup restore staging drill",
      command: "not run: --bucket licensecc-d1-backups --object-key backup.sql",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
    {
      label: "Cloudflare backup deployment staging drill",
      command: "not run: --worker-name licensecc-d1-backup",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
    {
      label: "Cloudflare public verifier abuse staging drill",
      command: "not run: https://verifier.example.workers.dev",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
  ];

  assert.deepEqual(externalCommandRedactionFailures(results), [
    "Cloudflare Access admin staging drill command must not contain a literal URL",
    "Cloudflare Access admin staging drill skipped command must not include staging details",
    "Cloudflare R2 backup restore staging drill skipped command must not include staging details",
    "Cloudflare backup deployment staging drill skipped command must not include staging details",
    "Cloudflare public verifier abuse staging drill skipped command must not include staging details",
  ]);
});

test("release readiness rejects local-only summaries", () => {
  const analysis = analyzeSummary(productionSummary({
    production_ready: false,
    external: false,
    require_external: false,
    external_inputs_present: {
      access_admin: false,
      access_non_admin_jwt: false,
      r2_restore: false,
      backup_deploy: false,
      public_verifier_abuse: false,
    },
    results: [{ label: "repository whitespace check", status: 0 }],
  }));
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /summary\.external must be true/);
  assert.match(analysis.failures.join("\n"), /summary\.require_external must be true/);
  assert.match(analysis.failures.join("\n"), /Cloudflare Access admin staging drill must be present with status 0/);
});

test("release readiness rejects malformed top-level summary shape", () => {
  const summary = productionSummary({
    ok: "true",
    complete: "true",
    production_ready: "true",
    quick: "false",
    full: "true",
    external: "true",
    require_external: "true",
    skipped: "0",
    generated_at: "not-a-date",
    platform: " win32 ",
    node_version: "22.12.0",
    cwd: "",
  });
  const analysis = analyzeSummary(summary);

  assert.deepEqual(topLevelShapeFailures(summary), [
    "summary.ok must be boolean",
    "summary.complete must be boolean",
    "summary.production_ready must be boolean",
    "summary.quick must be boolean",
    "summary.full must be boolean",
    "summary.external must be boolean",
    "summary.require_external must be boolean",
    "summary.skipped must be a nonnegative integer",
    "summary.generated_at must be an ISO timestamp",
    "summary.platform must be a nonempty trimmed string",
    "summary.node_version must be a Node.js version string",
    "summary.cwd must be a nonempty trimmed string",
  ]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /summary\.quick must be boolean/);
  assert.match(analysis.failures.join("\n"), /summary\.generated_at must be an ISO timestamp/);
});

test("release readiness rejects malformed external input evidence shape", () => {
  const analysis = analyzeSummary(productionSummary({
    external_inputs_present: {
      access_admin: "true",
      access_non_admin_jwt: "secret-token-value",
      r2_restore: true,
      access_jwt_value: "secret-token-value",
    },
  }));

  assert.deepEqual(externalInputShapeFailures({
    access_admin: "true",
    access_non_admin_jwt: "secret-token-value",
    r2_restore: true,
    access_jwt_value: "secret-token-value",
  }), [
    "external_inputs_present.access_admin must be boolean",
    "external_inputs_present.access_non_admin_jwt must be boolean",
    "external_inputs_present.backup_deploy must be boolean",
    "external_inputs_present.public_verifier_abuse must be boolean",
    "external_inputs_present.access_jwt_value is not an allowed key",
  ]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /external_inputs_present\.access_admin must be boolean/);
  assert.match(analysis.failures.join("\n"), /external_inputs_present\.access_non_admin_jwt must be boolean/);
  assert.match(analysis.failures.join("\n"), /external_inputs_present\.backup_deploy must be boolean/);
  assert.match(analysis.failures.join("\n"), /external_inputs_present\.public_verifier_abuse must be boolean/);
  assert.match(analysis.failures.join("\n"), /external_inputs_present\.access_jwt_value is not an allowed key/);
});

test("release readiness rejects missing external input evidence object", () => {
  const analysis = analyzeSummary(productionSummary({ external_inputs_present: null }));

  assert.deepEqual(externalInputShapeFailures(null), ["external_inputs_present must be an object"]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /external_inputs_present must be an object/);
});

test("release readiness rejects missing deterministic local gate evidence", () => {
  const analysis = analyzeSummary(productionSummary({
    results: [
      ...REQUIRED_LOCAL_RESULTS
        .filter((label) => label !== "admin UI build")
        .map(passedResult),
      ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
    ],
  }));
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /admin UI build must be present with status 0/);
});

test("release readiness rejects local command evidence that does not match the contract", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
  ];
  results[0] = {
    ...results[0],
    command: "node scripts/workspace_hygiene_check.mjs --fake-pass",
  };
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(localCommandEvidenceFailures(results), [
    "repository whitespace check command must match the release-gate contract",
  ]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /repository whitespace check command must match the release-gate contract/);
});

test("release readiness rejects duplicate result labels", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
    passedResult("admin UI build"),
  ];
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(duplicateResultLabels(results), ["admin UI build"]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /admin UI build result label must be unique/);
});

test("release readiness rejects invalid result labels", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
  ];
  results[0] = { ...results[0], label: "" };
  results[1] = { ...results[1], label: " padded label " };
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(invalidResultLabels(results), ["result[0]", "result[1]"]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /result\[0\] result label must be a nonempty trimmed string/);
  assert.match(analysis.failures.join("\n"), /result\[1\] result label must be a nonempty trimmed string/);
});

test("release readiness rejects invalid result statuses", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
  ];
  results[0] = { ...results[0], status: "passed" };
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(invalidResultStatuses(results), [REQUIRED_LOCAL_RESULTS[0]]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /repository whitespace check result status must be an integer exit code or skipped/);
});

test("release readiness rejects null result rows", () => {
  const analysis = analyzeSummary(productionSummary({ results: [null] }));

  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /result\[0\] result label must be a nonempty trimmed string/);
  assert.match(analysis.failures.join("\n"), /result\[0\] result status must be an integer exit code or skipped/);
});

test("release readiness rejects missing or malformed result metadata", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
  ];
  results[0] = { ...results[0], command: "" };
  results[1] = { ...results[1], command: " padded command " };
  results[2] = { ...results[2], duration_ms: -1 };
  results[3] = { ...results[3], duration_ms: "0" };
  results.push({ label: "skipped metadata gate", status: "skipped", command: "skip gate", duration_ms: 0 });
  const analysis = analyzeSummary(productionSummary({ results, skipped: 1 }));

  assert.deepEqual(resultMetadataFailures(results), [
    `${REQUIRED_LOCAL_RESULTS[0]} result command must be a nonempty trimmed string`,
    `${REQUIRED_LOCAL_RESULTS[1]} result command must be a nonempty trimmed string`,
    `${REQUIRED_LOCAL_RESULTS[2]} result duration_ms must be a nonnegative integer`,
    `${REQUIRED_LOCAL_RESULTS[3]} result duration_ms must be a nonnegative integer`,
    "skipped metadata gate skipped result reason must be a nonempty trimmed string",
  ]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /repository whitespace check result command must be a nonempty trimmed string/);
  assert.match(analysis.failures.join("\n"), /secret hygiene scan result duration_ms must be a nonnegative integer/);
  assert.match(analysis.failures.join("\n"), /skipped metadata gate skipped result reason must be a nonempty trimmed string/);
});

test("release readiness rejects hidden failed result rows", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
    { ...passedResult("unexpected extra gate"), status: 1 },
  ];
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(failedResultLabels(results), ["unexpected extra gate"]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /unexpected extra gate result status must be 0 for production readiness/);
});

test("release readiness rejects hidden skipped result rows and skipped count mismatch", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    ...REQUIRED_EXTERNAL_RESULTS.map(passedResult),
    { label: "unexpected skipped gate", status: "skipped", command: "skip gate", duration_ms: 0, reason: "credentials missing" },
  ];
  const analysis = analyzeSummary(productionSummary({ results, skipped: 0 }));

  assert.deepEqual(skippedResultLabels(results), ["unexpected skipped gate"]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /unexpected skipped gate result must not be skipped for production readiness/);
  assert.match(analysis.failures.join("\n"), /summary\.skipped must match skipped result count/);
});

test("release readiness rejects unredacted external drill command evidence", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    {
      ...passedResult("Cloudflare Access admin staging drill"),
      command: "node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --url https://admin.example",
    },
    {
      ...passedResult("Cloudflare R2 backup restore staging drill"),
      command: "node services/cloudflare-d1-backup/scripts/restore-drill.mjs --bucket licensecc-d1-backups --object-key backup.sql --scratch-database scratch --confirm-scratch --remote",
    },
    {
      ...passedResult("Cloudflare backup deployment staging drill"),
      command: "node services/cloudflare-d1-backup/scripts/validate-deploy.mjs --url https://backup.example --worker-name licensecc-d1-backup --workflow-name licensecc-d1-backup --require-d1-rest-token --json",
    },
    {
      ...passedResult("Cloudflare public verifier abuse staging drill"),
      command: "node services/cloudflare-online-verifier/scripts/public-verifier-drill.mjs --url https://verifier.example.workers.dev --expect-rate-limit --json",
    },
  ];
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(externalCommandRedactionFailures(results), [
    "Cloudflare Access admin staging drill command must not contain a literal URL",
    "Cloudflare Access admin staging drill command must match the redacted command template",
    "Cloudflare Access admin staging drill command must redact the admin URL",
    "Cloudflare R2 backup restore staging drill command must match the redacted command template",
    "Cloudflare R2 backup restore staging drill command must include <redacted-r2-bucket>",
    "Cloudflare R2 backup restore staging drill command must include <redacted-r2-object-key>",
    "Cloudflare R2 backup restore staging drill command must include <redacted-scratch-d1>",
    "Cloudflare backup deployment staging drill command must match the redacted command template",
    "Cloudflare backup deployment staging drill command must include <redacted-backup-url>",
    "Cloudflare backup deployment staging drill command must include <redacted-backup-worker>",
    "Cloudflare backup deployment staging drill command must include <redacted-backup-workflow>",
    "Cloudflare backup deployment staging drill command must not contain a literal URL",
    "Cloudflare public verifier abuse staging drill command must match the redacted command template",
    "Cloudflare public verifier abuse staging drill command must include <redacted-verifier-url>",
    "Cloudflare public verifier abuse staging drill command must not contain a literal URL",
  ]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /Cloudflare Access admin staging drill command must redact the admin URL/);
  assert.match(analysis.failures.join("\n"), /Cloudflare R2 backup restore staging drill command must include <redacted-r2-bucket>/);
});

test("release readiness accepts optional redacted restore command placeholders", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    passedResult("Cloudflare Access admin staging drill"),
    passedResult("Cloudflare backup deployment staging drill"),
    passedResult("Cloudflare public verifier abuse staging drill"),
    {
      ...passedResult("Cloudflare R2 backup restore staging drill"),
      command: [
        "node services/cloudflare-d1-backup/scripts/restore-drill.mjs",
        "--bucket <redacted-r2-bucket>",
        "--object-key <redacted-r2-object-key>",
        "--scratch-database <redacted-scratch-d1>",
        "--confirm-scratch",
        "--remote",
        "--source-database <redacted-source-d1>",
        "--scratch-config <redacted-scratch-config>",
        "--source-config <redacted-source-config>",
        "--r2-config <redacted-r2-config>",
        "--require-restored-status active",
        "--require-restored-status revoked",
      ].join(" "),
    },
  ];

  assert.deepEqual(externalCommandRedactionFailures(results), []);
  assert.equal(analyzeSummary(productionSummary({ results })).ready, true);
});

test("release readiness rejects redacted restore commands with extra literal arguments", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    passedResult("Cloudflare Access admin staging drill"),
    passedResult("Cloudflare backup deployment staging drill"),
    {
      ...passedResult("Cloudflare R2 backup restore staging drill"),
      command: `${passedResult("Cloudflare R2 backup restore staging drill").command} --object-key backup.sql`,
    },
  ];
  const analysis = analyzeSummary(productionSummary({ results }));

  assert.deepEqual(externalCommandRedactionFailures(results), [
    "Cloudflare R2 backup restore staging drill command must match the redacted command template",
  ]);
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /Cloudflare R2 backup restore staging drill command must match the redacted command template/);
});

test("release readiness rejects unknown restored status command values", () => {
  const results = [
    ...REQUIRED_LOCAL_RESULTS.map(passedResult),
    passedResult("Cloudflare Access admin staging drill"),
    passedResult("Cloudflare backup deployment staging drill"),
    {
      ...passedResult("Cloudflare R2 backup restore staging drill"),
      command: `${passedResult("Cloudflare R2 backup restore staging drill").command} --require-restored-status expired`,
    },
  ];

  assert.deepEqual(externalCommandRedactionFailures(results), [
    "Cloudflare R2 backup restore staging drill command must match the redacted command template",
  ]);
});

test("release readiness rejects quick summaries", () => {
  const analysis = analyzeSummary(productionSummary({ quick: true, full: false }));
  assert.equal(analysis.ready, false);
  assert.match(analysis.failures.join("\n"), /summary\.full must be true/);
  assert.match(analysis.failures.join("\n"), /summary\.quick must not be true/);
});

test("release readiness loads summary JSON from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "licensecc-release-ready-"));
  const file = join(dir, "summary.json");
  try {
    writeFileSync(file, `${JSON.stringify(productionSummary())}\n`, "utf8");
    const summary = loadSummary(file);
    assert.equal(summary.production_ready, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
