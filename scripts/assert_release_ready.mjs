import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACCESS_DRILL_COMMAND_TEMPLATE,
  BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS,
  BOOLEAN_SUMMARY_KEYS,
  CUSTOMER_PORTAL_COMMAND_TEMPLATE,
  EXTERNAL_INPUT_KEYS,
  PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE,
  R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS,
  R2_RESTORE_COMMAND_OPTIONAL_STATUS_VALUES,
  R2_RESTORE_COMMAND_REQUIRED_TOKENS,
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_COMMANDS,
  REQUIRED_LOCAL_RESULTS,
  SKIPPED_EXTERNAL_COMMANDS,
  STAGING_CATALOG_COMMAND_TEMPLATE,
} from "./release_gate_contract.mjs";

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/assert_release_ready.mjs <release-gate-summary.json>

Fails unless the release-gate JSON proves a full strict production run:
full=true, quick=false, require_external=true, production_ready=true, no
blocking_reasons, no skipped gates, required deterministic local gates passed,
and all Cloudflare staging drills passed.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv.length !== 3 || argv[2] === "--help" || argv[2] === "-h") {
    usage(argv[2] === "--help" || argv[2] === "-h" ? 0 : 2);
  }
  return { jsonPath: argv[2] };
}

function loadSummary(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("release gate summary must be a JSON object");
  }
  return parsed;
}

function hasPassedResult(summary, label) {
  return Array.isArray(summary.results)
    && summary.results.some((result) => result !== null && typeof result === "object" && result.label === label && result.status === 0);
}

function validResultLabel(result) {
  return result !== null
    && typeof result === "object"
    && typeof result.label === "string"
    && result.label.trim() !== ""
    && result.label === result.label.trim();
}

function displayResultLabel(result, index) {
  return validResultLabel(result) ? result.label : `result[${index}]`;
}

function invalidResultLabels(results) {
  return results.flatMap((result, index) => validResultLabel(result) ? [] : [`result[${index}]`]);
}

function duplicateResultLabels(results) {
  const seen = new Set();
  const duplicates = new Set();
  for (const result of results) {
    if (!validResultLabel(result)) {
      continue;
    }
    if (seen.has(result.label)) {
      duplicates.add(result.label);
    }
    seen.add(result.label);
  }
  return [...duplicates].sort();
}

function invalidResultStatuses(results) {
  return results
    .flatMap((result, index) => result !== null
      && typeof result === "object"
      && (Number.isInteger(result.status) || result.status === "skipped")
      ? []
      : [displayResultLabel(result, index)]);
}

function failedResultLabels(results) {
  return results
    .flatMap((result, index) => result !== null && typeof result === "object" && Number.isInteger(result.status) && result.status !== 0
      ? [displayResultLabel(result, index)]
      : []);
}

function skippedResultLabels(results) {
  return results
    .flatMap((result, index) => result !== null && typeof result === "object" && result.status === "skipped"
      ? [displayResultLabel(result, index)]
      : []);
}

function validTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function resultMetadataFailures(results) {
  return results.flatMap((result, index) => {
    const label = displayResultLabel(result, index);
    if (result === null || typeof result !== "object") {
      return [
        `${label} result command must be a nonempty trimmed string`,
        `${label} result duration_ms must be a nonnegative integer`,
      ];
    }
    const failures = [];
    if (!validTrimmedString(result.command)) {
      failures.push(`${label} result command must be a nonempty trimmed string`);
    }
    if (!Number.isInteger(result.duration_ms) || result.duration_ms < 0) {
      failures.push(`${label} result duration_ms must be a nonnegative integer`);
    }
    if (result.status === "skipped" && !validTrimmedString(result.reason)) {
      failures.push(`${label} skipped result reason must be a nonempty trimmed string`);
    }
    return failures;
  });
}

function resultForLabel(results, label) {
  return Array.isArray(results)
    ? results.find((result) => result !== null && typeof result === "object" && result.label === label)
    : undefined;
}

function r2RestoreCommandTemplateFailures(command) {
  const tokens = command.split(" ");
  const failures = [];
  for (let index = 0; index < R2_RESTORE_COMMAND_REQUIRED_TOKENS.length; ++index) {
    if (tokens[index] !== R2_RESTORE_COMMAND_REQUIRED_TOKENS[index]) {
      failures.push("Cloudflare R2 backup restore staging drill command must match the redacted command template");
      return failures;
    }
  }
  const seenOptionalFlags = new Set();
  for (let index = R2_RESTORE_COMMAND_REQUIRED_TOKENS.length; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag === "--require-restored-status") {
      if (!R2_RESTORE_COMMAND_OPTIONAL_STATUS_VALUES.has(value)) {
        failures.push("Cloudflare R2 backup restore staging drill command must match the redacted command template");
        return failures;
      }
      continue;
    }
    const expectedValue = R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS.get(flag);
    if (expectedValue === undefined || value !== expectedValue || seenOptionalFlags.has(flag)) {
      failures.push("Cloudflare R2 backup restore staging drill command must match the redacted command template");
      return failures;
    }
    seenOptionalFlags.add(flag);
  }
  return failures;
}

function externalCommandRedactionFailures(results) {
  if (!Array.isArray(results)) {
    return [];
  }
  const failures = [];
  const access = resultForLabel(results, "Cloudflare Access admin staging drill");
  if (access !== undefined && typeof access.command === "string") {
    if (/https?:\/\//i.test(access.command)) {
      failures.push("Cloudflare Access admin staging drill command must not contain a literal URL");
    }
    if (access.status === "skipped") {
      if (access.command !== SKIPPED_EXTERNAL_COMMANDS.get("Cloudflare Access admin staging drill")) {
        failures.push("Cloudflare Access admin staging drill skipped command must not include staging details");
      }
    } else {
      if (access.command !== ACCESS_DRILL_COMMAND_TEMPLATE) {
        failures.push("Cloudflare Access admin staging drill command must match the redacted command template");
      }
      if (!access.command.includes("<redacted-admin-url>")) {
        failures.push("Cloudflare Access admin staging drill command must redact the admin URL");
      }
    }
  }
  const restore = resultForLabel(results, "Cloudflare R2 backup restore staging drill");
  if (restore !== undefined && typeof restore.command === "string") {
    if (restore.status === "skipped") {
      if (restore.command !== SKIPPED_EXTERNAL_COMMANDS.get("Cloudflare R2 backup restore staging drill")) {
        failures.push("Cloudflare R2 backup restore staging drill skipped command must not include staging details");
      }
    } else {
      failures.push(...r2RestoreCommandTemplateFailures(restore.command));
      const requiredPlaceholders = [
        "<redacted-r2-bucket>",
        "<redacted-r2-object-key>",
        "<redacted-scratch-d1>",
      ];
      for (const placeholder of requiredPlaceholders) {
        if (!restore.command.includes(placeholder)) {
          failures.push(`Cloudflare R2 backup restore staging drill command must include ${placeholder}`);
        }
      }
    }
  }
  const backupDeploy = resultForLabel(results, "Cloudflare backup deployment staging drill");
  if (backupDeploy !== undefined && typeof backupDeploy.command === "string") {
    if (backupDeploy.status === "skipped") {
      if (backupDeploy.command !== SKIPPED_EXTERNAL_COMMANDS.get("Cloudflare backup deployment staging drill")) {
        failures.push("Cloudflare backup deployment staging drill skipped command must not include staging details");
      }
    } else {
      const command = BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS.join(" ");
      if (backupDeploy.command !== command) {
        failures.push("Cloudflare backup deployment staging drill command must match the redacted command template");
      }
      for (const placeholder of ["<redacted-backup-url>", "<redacted-backup-worker>", "<redacted-backup-workflow>"]) {
        if (!backupDeploy.command.includes(placeholder)) {
          failures.push(`Cloudflare backup deployment staging drill command must include ${placeholder}`);
        }
      }
      if (/https?:\/\//i.test(backupDeploy.command)) {
        failures.push("Cloudflare backup deployment staging drill command must not contain a literal URL");
      }
    }
  }
  const publicVerifier = resultForLabel(results, "Cloudflare public verifier abuse staging drill");
  if (publicVerifier !== undefined && typeof publicVerifier.command === "string") {
    if (publicVerifier.status === "skipped") {
      if (publicVerifier.command !== SKIPPED_EXTERNAL_COMMANDS.get("Cloudflare public verifier abuse staging drill")) {
        failures.push("Cloudflare public verifier abuse staging drill skipped command must not include staging details");
      }
    } else {
      if (publicVerifier.command !== PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE) {
        failures.push("Cloudflare public verifier abuse staging drill command must match the redacted command template");
      }
      if (!publicVerifier.command.includes("<redacted-verifier-url>")) {
        failures.push("Cloudflare public verifier abuse staging drill command must include <redacted-verifier-url>");
      }
      if (/https?:\/\//i.test(publicVerifier.command)) {
        failures.push("Cloudflare public verifier abuse staging drill command must not contain a literal URL");
      }
    }
  }
  const catalog = resultForLabel(results, "Cloudflare catalog projection staging drill");
  if (catalog !== undefined && typeof catalog.command === "string") {
    if (catalog.status === "skipped") {
      if (catalog.command !== SKIPPED_EXTERNAL_COMMANDS.get("Cloudflare catalog projection staging drill")) {
        failures.push("Cloudflare catalog projection staging drill skipped command must not include staging details");
      }
    } else {
      if (catalog.command !== STAGING_CATALOG_COMMAND_TEMPLATE) {
        failures.push("Cloudflare catalog projection staging drill command must match the redacted command template");
      }
      if (/https?:\/\//i.test(catalog.command)) {
        failures.push("Cloudflare catalog projection staging drill command must not contain a literal URL");
      }
    }
  }
  const portal = resultForLabel(results, "Cloudflare customer portal staging drill");
  if (portal !== undefined && typeof portal.command === "string") {
    if (portal.status === "skipped") {
      if (portal.command !== SKIPPED_EXTERNAL_COMMANDS.get("Cloudflare customer portal staging drill")) {
        failures.push("Cloudflare customer portal staging drill skipped command must not include staging details");
      }
    } else {
      if (portal.command !== CUSTOMER_PORTAL_COMMAND_TEMPLATE) {
        failures.push("Cloudflare customer portal staging drill command must match the redacted command template");
      }
      if (/https?:\/\//i.test(portal.command)) {
        failures.push("Cloudflare customer portal staging drill command must not contain a literal URL");
      }
    }
  }
  return failures;
}

function localCommandEvidenceFailures(results) {
  if (!Array.isArray(results)) {
    return [];
  }
  const failures = [];
  for (const [label, expectedCommand] of REQUIRED_LOCAL_COMMANDS.entries()) {
    const result = resultForLabel(results, label);
    if (result === undefined || typeof result.command !== "string") {
      continue;
    }
    if (result.command !== expectedCommand) {
      failures.push(`${label} command must match the release-gate contract`);
    }
  }
  return failures;
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && value !== ""
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function topLevelShapeFailures(summary) {
  const failures = [];
  for (const key of BOOLEAN_SUMMARY_KEYS) {
    if (typeof summary[key] !== "boolean") {
      failures.push(`summary.${key} must be boolean`);
    }
  }
  if (!Number.isInteger(summary.skipped) || summary.skipped < 0) {
    failures.push("summary.skipped must be a nonnegative integer");
  }
  if (!isIsoTimestamp(summary.generated_at)) {
    failures.push("summary.generated_at must be an ISO timestamp");
  }
  if (typeof summary.platform !== "string" || summary.platform.trim() === "" || summary.platform !== summary.platform.trim()) {
    failures.push("summary.platform must be a nonempty trimmed string");
  }
  if (typeof summary.node_version !== "string" || !/^v\d+\.\d+\.\d+/.test(summary.node_version)) {
    failures.push("summary.node_version must be a Node.js version string");
  }
  if (typeof summary.cwd !== "string" || summary.cwd.trim() === "" || summary.cwd !== summary.cwd.trim()) {
    failures.push("summary.cwd must be a nonempty trimmed string");
  }
  return failures;
}

function externalInputShapeFailures(externalInputs) {
  if (externalInputs === null || typeof externalInputs !== "object" || Array.isArray(externalInputs)) {
    return ["external_inputs_present must be an object"];
  }
  const failures = [];
  for (const key of EXTERNAL_INPUT_KEYS) {
    if (typeof externalInputs[key] !== "boolean") {
      failures.push(`external_inputs_present.${key} must be boolean`);
    }
  }
  for (const key of Object.keys(externalInputs)) {
    if (!EXTERNAL_INPUT_KEYS.includes(key)) {
      failures.push(`external_inputs_present.${key} is not an allowed key`);
    }
  }
  return failures;
}

function analyzeSummary(summary) {
  const failures = [];
  failures.push(...topLevelShapeFailures(summary));
  if (summary.ok !== true) {
    failures.push("summary.ok must be true");
  }
  if (summary.complete !== true) {
    failures.push("summary.complete must be true");
  }
  if (summary.production_ready !== true) {
    failures.push("summary.production_ready must be true");
  }
  if (summary.full !== true) {
    failures.push("summary.full must be true");
  }
  if (summary.quick === true) {
    failures.push("summary.quick must not be true");
  }
  if (summary.external !== true) {
    failures.push("summary.external must be true");
  }
  if (summary.require_external !== true) {
    failures.push("summary.require_external must be true");
  }
  if (summary.skipped !== 0) {
    failures.push("summary.skipped must be 0");
  }
  if (!Array.isArray(summary.blocking_reasons)) {
    failures.push("summary.blocking_reasons must be an array");
  } else if (summary.blocking_reasons.length !== 0) {
    failures.push("summary.blocking_reasons must be empty");
  }
  failures.push(...externalInputShapeFailures(summary.external_inputs_present));
  if (summary.external_inputs_present?.access_admin !== true) {
    failures.push("external_inputs_present.access_admin must be true");
  }
  if (summary.external_inputs_present?.r2_restore !== true) {
    failures.push("external_inputs_present.r2_restore must be true");
  }
  if (summary.external_inputs_present?.backup_deploy !== true) {
    failures.push("external_inputs_present.backup_deploy must be true");
  }
  if (summary.external_inputs_present?.public_verifier_abuse !== true) {
    failures.push("external_inputs_present.public_verifier_abuse must be true");
  }
  if (summary.external_inputs_present?.staging_catalog !== true) {
    failures.push("external_inputs_present.staging_catalog must be true");
  }
  if (summary.external_inputs_present?.customer_portal !== true) {
    failures.push("external_inputs_present.customer_portal must be true");
  }
  if (!Array.isArray(summary.results)) {
    failures.push("summary.results must be an array");
  } else {
    for (const label of invalidResultLabels(summary.results)) {
      failures.push(`${label} result label must be a nonempty trimmed string`);
    }
    for (const label of duplicateResultLabels(summary.results)) {
      failures.push(`${label} result label must be unique`);
    }
    for (const label of invalidResultStatuses(summary.results)) {
      failures.push(`${label} result status must be an integer exit code or skipped`);
    }
    failures.push(...resultMetadataFailures(summary.results));
    failures.push(...localCommandEvidenceFailures(summary.results));
    failures.push(...externalCommandRedactionFailures(summary.results));
    const failedLabels = failedResultLabels(summary.results);
    for (const label of failedLabels) {
      failures.push(`${label} result status must be 0 for production readiness`);
    }
    const skippedLabels = skippedResultLabels(summary.results);
    for (const label of skippedLabels) {
      failures.push(`${label} result must not be skipped for production readiness`);
    }
    if (typeof summary.skipped === "number" && summary.skipped !== skippedLabels.length) {
      failures.push("summary.skipped must match skipped result count");
    }
  }
  for (const label of REQUIRED_LOCAL_RESULTS) {
    if (resultForLabel(summary.results, label) === undefined) {
      failures.push(`${label} must be present with status 0`);
    }
  }
  for (const label of REQUIRED_EXTERNAL_RESULTS) {
    if (resultForLabel(summary.results, label) === undefined) {
      failures.push(`${label} must be present with status 0`);
    }
  }
  return {
    ready: failures.length === 0,
    failures,
  };
}

function main() {
  const options = parseArgs(process.argv);
  const summary = loadSummary(options.jsonPath);
  const analysis = analyzeSummary(summary);
  if (analysis.ready) {
    console.log("release evidence is production ready");
    return;
  }
  console.error("release evidence is not production ready:");
  for (const failure of analysis.failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

export {
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_COMMANDS,
  REQUIRED_LOCAL_RESULTS,
  BOOLEAN_SUMMARY_KEYS,
  EXTERNAL_INPUT_KEYS,
  ACCESS_DRILL_COMMAND_TEMPLATE,
  BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS,
  CUSTOMER_PORTAL_COMMAND_TEMPLATE,
  PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE,
  R2_RESTORE_COMMAND_REQUIRED_TOKENS,
  R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS,
  SKIPPED_EXTERNAL_COMMANDS,
  STAGING_CATALOG_COMMAND_TEMPLATE,
  analyzeSummary,
  duplicateResultLabels,
  externalInputShapeFailures,
  externalCommandRedactionFailures,
  failedResultLabels,
  hasPassedResult,
  invalidResultLabels,
  invalidResultStatuses,
  loadSummary,
  localCommandEvidenceFailures,
  parseArgs,
  resultMetadataFailures,
  skippedResultLabels,
  topLevelShapeFailures,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
