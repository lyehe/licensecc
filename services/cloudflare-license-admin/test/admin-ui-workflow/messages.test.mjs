import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { loadWorkflowModule, loadWorkflowModules } from "./helpers.mjs";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const CODE = "([a-z][a-z0-9_]*)";

function sourceFiles(directory, extensions) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

const relativePath = (path) => relative(serviceRoot, path).split("\\").join("/");

// The actions each `${prefix}${action}d` success code is built from (the route's action union).
const TEMPLATE_ACTIONS = {
  entitlement_: ["disable", "reenable", "revoke"],
  device_: ["disable", "reenable", "revoke"],
  customer_: ["disable", "reenable"],
  policy_: ["disable", "reenable"],
  webhook_: ["disable", "reenable"],
  catalog_feature_: ["disable", "reenable"],
  catalog_plan_: ["disable", "reenable"],
  catalog_plan_feature_: ["disable", "reenable"],
};

/**
 * Every code the admin Worker can put in an envelope. Most are literals at `envelope(`/`respond(`;
 * the rest reach the envelope through a helper: a transition spec, a success-code template, a
 * relayed backend refusal table, a passthrough list or a shared constant.
 */
function collectWorkerCodes() {
  const codes = new Map();
  const add = (code, origin) => {
    if (!codes.has(code)) codes.set(code, new Set());
    codes.get(code).add(origin);
  };
  const files = sourceFiles(join(serviceRoot, "src/worker"), [".ts"]).filter((path) => !/[\\/]openapi[\\/]/.test(path));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const origin = relativePath(file);
    for (const match of source.matchAll(new RegExp(`\\b(?:envelope|respond)\\(\\s*[\\w.]+\\s*,\\s*"${CODE}"`, "g"))) add(match[1], origin);
    for (const match of source.matchAll(new RegExp(`\\b(?:envelope|respond)\\(\\s*[\\w.]+\\s*,\\s*[^,?]+\\?\\s*"${CODE}"\\s*:\\s*"${CODE}"`, "g"))) {
      add(match[1], origin);
      add(match[2], origin);
    }
    for (const match of source.matchAll(new RegExp(`\\bmutationResponse\\([^)]*?,\\s*"${CODE}"`, "g"))) add(match[1], origin);
    for (const match of source.matchAll(/\bmutationResponse\([^`]*?`([a-z_]+)\$\{action\}d`/g)) {
      const actions = TEMPLATE_ACTIONS[match[1]];
      assert.ok(actions !== undefined, `${origin}: name the actions behind the ${match[1]}\${action}d success code`);
      for (const action of actions) add(`${match[1]}${action}d`, origin);
    }
    for (const match of source.matchAll(new RegExp(`\\b(?:conflictCode|notFoundCode|mutationFailedCode):\\s*"${CODE}"`, "g"))) add(match[1], origin);
    for (const match of source.matchAll(new RegExp(`\\bcode:\\s*"${CODE}"`, "g"))) add(match[1], origin);
    // A relayed success code is compared before it is passed on (not a `typeof code === "string"` check).
    for (const match of source.matchAll(new RegExp(`(?<!typeof )\\bcode\\s*===\\s*"${CODE}"`, "g"))) add(match[1], origin);
    for (const match of source.matchAll(new RegExp(`if \\(message === "${CODE}"\\) \\{\\s*return envelope\\(\\s*\\w+\\s*,\\s*message\\b`, "g"))) add(match[1], origin);
    for (const match of source.matchAll(/\[((?:\s*"[a-z_]+",?)+)\s*\]\.includes\((?:message|error\.message)\)/g)) {
      for (const code of match[1].matchAll(/"([a-z_]+)"/g)) add(code[1], origin);
    }
    // A relayed refusal table maps each code to the only HTTP status it may carry; a map of
    // counts (such as orders by status) is data, not codes.
    for (const match of source.matchAll(/Record<string,\s*number>>?\s*=\s*\{([^}]*)\}/g)) {
      const entries = [...match[1].matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*(\d+)/g)];
      if (entries.length === 0 || !entries.every((entry) => /^[1-5]\d\d$/.test(entry[2]))) continue;
      for (const entry of entries) add(entry[1], origin);
    }
  }
  const shared = readFileSync(join(serviceRoot, "src/shared/api.ts"), "utf8");
  const batchTooLarge = shared.match(/export const ENTITLEMENT_BATCH_TOO_LARGE_CODE = "([a-z_]+)"/);
  assert.ok(batchTooLarge !== null, "the batch capacity code constant is still a literal");
  add(batchTooLarge[1], "src/shared/api.ts");
  return codes;
}

// Thrown during render when a provider is missing: a programming error, never operator feedback.
const PROVIDER_INVARIANTS = new Set([
  "admin_navigation_provider_required",
  "operator_controls_provider_required",
  "core_refresh_provider_required",
  "usage_timeseries_provider_required",
]);

/** Codes the console raises itself: validators, local checks and every literal handed to feedback. */
function collectClientCodes() {
  const codes = new Map();
  const add = (code, origin) => {
    if (!codes.has(code)) codes.set(code, new Set());
    codes.get(code).add(origin);
  };
  for (const file of sourceFiles(join(serviceRoot, "src/ui"), [".ts", ".tsx"])) {
    const source = readFileSync(file, "utf8");
    const origin = relativePath(file);
    for (const match of source.matchAll(new RegExp(`throw new Error\\("${CODE}"\\)`, "g"))) {
      if (!PROVIDER_INVARIANTS.has(match[1])) add(match[1], origin);
    }
    // Template validation codes: sample every placeholder, so each shape needs a family sentence.
    for (const match of source.matchAll(/throw new Error\(`([^`]*)`\)/g)) {
      const sample = match[1].replace(/\$\{(\w+)\}/g, (_, name) => (name === "min" ? "0" : name === "max" ? "1" : "field"));
      if (/^[a-z][a-z0-9_]*$/.test(sample)) add(sample, `${origin} (template ${match[1]})`);
    }
    for (const match of source.matchAll(new RegExp(`\\b(?:codeFeedback|failureFeedback|refusalOutcome|showCode)\\(\\s*"${CODE}"`, "g"))) add(match[1], origin);
    // A form's own feedback: `someFormFeedback.show("code", …)`.
    for (const match of source.matchAll(new RegExp(`\\.show\\(\\s*"${CODE}"`, "g"))) add(match[1], origin);
  }
  // Built from an expression rather than a literal at the feedback call.
  for (const code of ["action_failed", "status_refresh_failed", "invalid_api_response", "invalid_mutation_response", "invalid_target_identity", "duplicate_page_item", "repeated_cursor", "invalid_form", "csv_export_failed"]) {
    add(code, "listed explicitly");
  }
  return codes;
}

/**
 * Success codes of reads whose payload is consumed as data. No UI path hands such a success to
 * feedback: each one only ever reaches parseExactApiSuccess or a data guard, and a failure of the
 * same read arrives under its own failure code.
 */
const DATA_ONLY_CODES = new Map([
  ["entitlements_listed", "entitlement list rows (Entitlements, CustomerAccess)"],
  ["entitlement", "one entitlement re-read after a seat release"],
  ["policies_listed", "policy list rows and policy selectors"],
  ["policy", "policy detail read; the console lists policies instead"],
  ["webhooks_listed", "webhook endpoint rows"],
  ["webhook", "endpoint detail read; the console lists endpoints instead"],
  ["webhook_deliveries_listed", "delivery rows"],
  ["events_listed", "event rows"],
  ["customers_listed", "customer rows and the customer typeahead"],
  ["customer", "customer detail read"],
  ["customer_apps", "a customer's apps in the access view"],
  ["customer_resources", "one app's records in the access view"],
  ["customer_bindings", "connection rows"],
  ["binding_events", "one connection's history rows"],
  ["licenses_listed", "license rows and the license typeahead"],
  ["orders_listed", "order activity rows"],
  ["devices_listed", "activated device rows"],
  ["meter_status", "metering counters"],
  ["projects_listed", "the app inventory picker"],
  ["catalog_features_listed", "catalog feature rows"],
  ["catalog_feature", "feature detail read; the console lists features instead"],
  ["catalog_plans_listed", "catalog plan rows"],
  ["catalog_plan", "the routed plan's existence check"],
  ["catalog_plan_features_listed", "a plan's feature rows"],
  ["catalog_plan_exported", "the manifest a plan export downloads; the console names the file instead"],
  ["search_results", "global search results"],
  ["settings", "the environment badge"],
  ["summary", "Overview counters"],
  ["report", "Reports counters"],
  ["report_expiring", "expiring-access rows"],
  ["report_timeseries", "usage chart series"],
  ["audit_chain_ok", "audit-chain check result; the console never calls the check"],
  ["audit_chain_broken", "audit-chain check result; the console never calls the check"],
]);

test("every Worker code and every client-local code has operator copy", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  const worker = collectWorkerCodes();
  const client = collectClientCodes();
  assert.ok(worker.size >= 120, `the Worker scan found only ${worker.size} codes; a pattern stopped matching`);
  assert.ok(client.size >= 30, `the console scan found only ${client.size} codes; a pattern stopped matching`);
  const all = new Map([...worker, ...client]);
  const missing = [...all.keys()].filter((code) => !DATA_ONLY_CODES.has(code) && messages.describeCode(code) === null).sort();
  assert.deepEqual(missing, [], `give these codes copy in messages.ts:\n${missing.map((code) => `  ${code} (${[...all.get(code)].join(", ")})`).join("\n")}`);
  const deadExclusions = [...DATA_ONLY_CODES.keys()].filter((code) => !worker.has(code));
  assert.deepEqual(deadExclusions, [], "every data-only exclusion must name a code the Worker still emits");
  const dataOnlyFromClient = [...DATA_ONLY_CODES.keys()].filter((code) => client.has(code));
  assert.deepEqual(dataOnlyFromClient, [], "a data-only code is handed to feedback somewhere");
});

test("no console code is ever used as a message", () => {
  // A literal code handed to `message:` would render as text; every code goes through the catalog.
  const offenders = [];
  for (const file of sourceFiles(join(serviceRoot, "src/ui"), [".ts", ".tsx"])) {
    for (const match of readFileSync(file, "utf8").matchAll(/\bmessage:\s*"([a-z][a-z0-9_]*)"/g)) offenders.push(`${relativePath(file)}: ${match[1]}`);
  }
  assert.deepEqual(offenders, []);
});

test("operator copy never shows a snake_case code as its text", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  for (const [code, copy] of Object.entries(messages.RESULT_CODE_COPY)) {
    assert.doesNotMatch(copy.text, /\b[a-z0-9]+_[a-z0-9_]+\b/, `${code}: ${copy.text}`);
    assert.ok(!copy.text.includes(code), `${code} repeats its own code`);
    assert.ok(["success", "error", "info"].includes(copy.tone), `${code} has a tone`);
    assert.match(copy.text, /[.!?]$/, `${code} is a sentence`);
  }
});

test("an unknown code falls back to a reference, and prototype keys are unknown codes", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "definitely_not_a_code"]) {
    assert.equal(messages.describeCode(code), null, code);
    const feedback = messages.codeFeedback(code, "req-7");
    assert.deepEqual(feedback, { tone: "error", message: "Something went wrong. Reference req-7.", detail: { code, requestId: "req-7" } }, code);
    assert.equal(typeof feedback.message, "string");
  }
});

test("without a request id the fallback asks for a retry and never leaves a dangling reference", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  for (const requestId of [null, undefined, "", "   "]) {
    const feedback = messages.codeFeedback("definitely_not_a_code", requestId);
    assert.equal(feedback.message, "Something went wrong. Try again.", String(requestId));
    assert.doesNotMatch(feedback.message, /Reference/);
    assert.deepEqual(feedback.detail, { code: "definitely_not_a_code", requestId: null });
  }
  assert.equal(messages.unknownResultText("req-1"), "Something went wrong. Reference req-1.");
  assert.equal(messages.unknownResultText(null), "Something went wrong. Try again.");
});

test("known codes keep their tone, refusals are always errors, and the code travels as detail", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  assert.deepEqual(messages.codeFeedback("policy_created", "req-1"), { tone: "success", message: "Policy created.", detail: { code: "policy_created", requestId: "req-1" } });
  assert.deepEqual(messages.codeFeedback("stale_transition", "req-2"), {
    tone: "error",
    message: "This record changed after you loaded it. Refresh and try again.",
    detail: { code: "stale_transition", requestId: "req-2" },
  });
  // Emitted for a plan feature whose project differs from its plan's, and for a policy of another project.
  assert.match(messages.describeCode("invalid_plan_config").text, /project/);
  assert.match(messages.describeCode("invalid_plan_config").text, /polic/);
  // The same code is a success after a policy is disabled and a refusal when a catalog row names it.
  assert.equal(messages.codeFeedback("policy_disabled", "req-3").tone, "success");
  assert.equal(messages.failureFeedback("policy_disabled", "req-3").tone, "error");
  assert.equal(messages.failureFeedback("policy_disabled", "req-3").message, "The policy is disabled.");
  assert.deepEqual(messages.feedbackWith("Three devices are connected.", "capacity_in_use", "req-4"), {
    tone: "error",
    message: "Three devices are connected.",
    detail: { code: "capacity_in_use", requestId: "req-4" },
  });
  assert.deepEqual(messages.refusalOutcome("reason_required", "req-5"), {
    ok: false,
    message: "Enter a reason.",
    detail: { code: "reason_required", requestId: "req-5" },
    retryable: true,
  });
});

test("a failed response becomes feedback from its envelope, and a malformed one says so", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  assert.deepEqual(messages.apiFailureFeedback({ ok: false, code: "not_found", request_id: "req-8" }), {
    tone: "error",
    message: "That record was not found; it may have been removed. Refresh and try again.",
    detail: { code: "not_found", requestId: "req-8" },
  });
  for (const value of [undefined, null, "oops", [], {}, { ok: false, code: "", request_id: "x" }]) {
    const feedback = messages.apiFailureFeedback(value);
    assert.equal(feedback.tone, "error");
    assert.equal(feedback.message, "The server's response could not be read. Check your connection and try again.");
    assert.deepEqual(feedback.detail, { code: "invalid_api_response", requestId: null });
  }
  assert.deepEqual(messages.apiFailureFeedback({ ok: false, code: "toString", request_id: "req-9" }).message, "Something went wrong. Reference req-9.");
  assert.deepEqual(messages.apiFailureFeedback({ ok: false, code: "not_found" }).detail, { code: "not_found", requestId: null });
  // A success envelope that failed its guard is an unreadable response, never its own success code.
  const unreadSuccess = messages.apiFailureFeedback({ ok: true, code: "policy_created", request_id: "req-10" });
  assert.equal(unreadSuccess.tone, "error");
  assert.equal(unreadSuccess.message, "The server's response could not be read. Check your connection and try again.");
  assert.deepEqual(unreadSuccess.detail, { code: "invalid_api_response", requestId: "req-10" });
});

test("the retained-notice sentences are full sentences from the catalog", async () => {
  const [actions, messages] = await loadWorkflowModules(["shared/operatorActions.ts", "shared/messages.ts"]);
  assert.equal(actions.CONFIRM_MUTATION_UNKNOWN_MESSAGE, "The outcome of this change is unknown. Don't repeat it; reconcile its status first.");
  assert.equal(actions.CONFIRM_REFRESH_FAILURE_MESSAGE, "The change was applied, but its status could not be refreshed.");
  assert.equal(actions.CONFIRM_MUTATION_UNKNOWN_MESSAGE, messages.OUTCOME_UNKNOWN_TEXT);
  assert.equal(actions.CONFIRM_REFRESH_FAILURE_MESSAGE, messages.STATUS_NOT_REFRESHED_TEXT);
  // A strict read's failure carries its code for handling, but its message never reads as one.
  const failure = new actions.ConfirmRefreshFailure("not_found", "req-11");
  assert.equal(failure.code, "not_found");
  assert.equal(failure.requestId, "req-11");
  assert.doesNotMatch(failure.message, /not_found|req-11|\(/);
});

test("a failed CSV export keeps its HTTP status under Technical details", async () => {
  const [pagination, text] = await loadWorkflowModules(["shared/pagination.ts", "shared/FeedbackText.tsx"]);
  const shown = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    await pagination.downloadCsv("/api/admin/entitlements", "entitlements.csv", (work) => work(), (feedback) => shown.push(feedback));
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.deepEqual(shown, [{ tone: "error", message: "The CSV export failed. Try again.", detail: { code: "csv_export_failed", requestId: null, httpStatus: 503 } }]);
  assert.equal(text.feedbackDetailText(shown[0].detail), "csv_export_failed · HTTP 503");
});

test("validation families share one sentence per rule and read their bounds", async () => {
  const messages = await loadWorkflowModule("shared/messages.ts");
  assert.equal(messages.describeCode("duration_sec_must_be_between_0_and_3153600000").text, "Enter a whole number from 0 to 3,153,600,000.");
  assert.equal(messages.describeCode("valid_from_offset_sec_must_be_between_-3153600000_and_3153600000").text, "Enter a whole number from -3,153,600,000 to 3,153,600,000.");
  assert.equal(messages.describeCode("support_until_must_be_a_valid_date").text, "Enter a valid date on or after January 1, 1970.");
  assert.equal(messages.describeCode("policy_id_must_be_at_most_128_chars").text, "Use at most 128 characters, on one line.");
  assert.equal(messages.describeCode("feature_key_required_or_too_long").text, "Required. Use one line within the length limit.");
  assert.equal(messages.describeCode("category_too_long_or_invalid").text, "Use one line within the length limit.");
  assert.equal(messages.describeCode("scope_project_must_be_a_single_value").text, "Enter one value of at most 128 characters, without commas or line breaks.");
  assert.equal(messages.describeCode("_must_be_between_0_and_1"), null, "a family needs a field name");
  assert.equal(messages.validationCode(new Error("notes_must_be_at_most_1000_chars")), "notes_must_be_at_most_1000_chars");
  assert.equal(messages.validationCode(new Error("Something human")), "invalid_form");
  assert.equal(messages.validationCode("thrown string"), "invalid_form");
});

test("FeedbackText shows the sentence and keeps the code and request id under Technical details", async () => {
  const [{ FeedbackText }, messages] = await loadWorkflowModules(["shared/FeedbackText.tsx", "shared/messages.ts"]);
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(FeedbackText, { feedback: messages.codeFeedback("webhook_created", "req-1") }));
  assert.match(markup, /^<span class="feedbackText">Webhook endpoint created\.<\/span><details class="feedbackDetails"><summary>Technical details<\/summary><code>webhook_created · req-1<\/code><\/details>$/);
  const local = ReactDOMServer.renderToStaticMarkup(React.createElement(FeedbackText, { feedback: messages.codeFeedback("repeated_cursor") }));
  assert.match(local, /<code>repeated_cursor<\/code>/, "a local code has no request id to show");
  const plain = ReactDOMServer.renderToStaticMarkup(React.createElement(FeedbackText, { feedback: { tone: "info", message: "Saved." } }));
  assert.equal(plain, "<span class=\"feedbackText\">Saved.</span>");
});
