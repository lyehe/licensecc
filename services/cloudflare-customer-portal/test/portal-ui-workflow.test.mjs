import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "@typescript/typescript6";

// Transpile the PURE portalWorkflow.ts (no React/DOM/node deps) and import it as an ES module — the
// same seam the admin uses. If portalWorkflow ever pulls in a non-pure import, this fails to import.
async function loadWorkflowModule() {
  const source = readFileSync(new URL("../src/ui/portalWorkflow.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "licensecc-portal-ui-"));
  const file = join(dir, "portalWorkflow.mjs");
  writeFileSync(file, transpiled, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("portal UI workflow builds same-origin auth paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.authRequestPath(), "/portal/v1/auth/request");
  assert.equal(workflow.authVerifyPath(), "/portal/v1/auth/verify");
  assert.equal(workflow.logoutPath(), "/portal/v1/auth/logout");
});

test("portal UI workflow builds session-scoped read paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.mePath(), "/api/portal/me");
  assert.equal(workflow.entitlementsPath(), "/api/portal/entitlements");
});

test("portal UI workflow exposes the OTP 10-minute expiry copy", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.OTP_EXPIRY_COPY, /10 minutes/);
});

// One sentence for every auth 429 that now carries the server's retry-after header, and the
// same "later" fallback wherever that header is absent (a redirect-driven rate_limited, or a
// password screen's own 429 that was left out of the header rollout).
test("portal UI workflow builds the single rate-limit sentence from retryAfter, with a later fallback", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.rateLimitMessage(undefined), "Too many attempts. Try again later.");
  assert.equal(workflow.rateLimitMessage(null), "Too many attempts. Try again later.");
  assert.equal(workflow.rateLimitMessage(0), "Too many attempts. Try again later.");
  assert.equal(workflow.rateLimitMessage(-5), "Too many attempts. Try again later.");
  assert.equal(workflow.rateLimitMessage(Number.NaN), "Too many attempts. Try again later.");
  // n = max(1, ceil(seconds/60)).
  assert.equal(workflow.rateLimitMessage(1), "Too many attempts. Try again in 1 minutes.");
  assert.equal(workflow.rateLimitMessage(60), "Too many attempts. Try again in 1 minutes.");
  assert.equal(workflow.rateLimitMessage(61), "Too many attempts. Try again in 2 minutes.");
  assert.equal(workflow.rateLimitMessage(900), "Too many attempts. Try again in 15 minutes.");
});

test("portal UI workflow exposes empty-state copy for the entitlements table", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.NO_ENTITLEMENTS_EMPTY_COPY, /No licenses yet/);
  assert.match(workflow.NO_ENTITLEMENTS_EMPTY_COPY, /after purchase/);
});

test("portal UI workflow maps raw result codes to human-readable copy", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(
    workflow.describeResultCode("invalid_otp"),
    "That code is wrong or expired — request a new one.",
  );
  assert.equal(
    workflow.describeResultCode("rate_limited"),
    "Too many attempts — wait a moment and try again.",
  );
  // An unmapped code returns null so the caller (StatusLine) can fall back to the generic reference
  // message instead of the raw code.
  assert.equal(workflow.describeResultCode("some_unknown_code"), null);
  assert.equal(workflow.describeResultCode(""), null);
  // Prototype-safe lookup: a code equal to an Object.prototype member name must resolve to
  // null too, via Object.hasOwn -- NOT `RESULT_CODE_COPY[code] ?? null`, which would instead return
  // that inherited function/value and crash React ("Objects are not valid as a React child") or
  // silently render a function. The same fix was applied to the identical bug in
  // ProviderSignIn's ERRORS and passwordMessage()'s MESSAGES with the same Object.hasOwn guard.
  assert.equal(workflow.describeResultCode("constructor"), null);
  assert.equal(workflow.describeResultCode("__proto__"), null);
  assert.equal(workflow.describeResultCode("toString"), null);
});

test("portal UI workflow gives StatusLine a reference fallback for any unmapped code", async () => {
  const workflow = await loadWorkflowModule();
  // No request id: never dangle the word "Reference" with nothing after it.
  assert.equal(workflow.describeUnknownResult(""), "Something went wrong. Try again.");
  // A request id: always carry it, so support can trace the exact failed request.
  assert.equal(workflow.describeUnknownResult("req-123"), "Something went wrong. Reference req-123.");
});

test("portal UI workflow gives every StatusLine-reachable result code human copy", async () => {
  const workflow = await loadWorkflowModule();

  // ---- 1) envelope(reqId, "...") literals from the four route files this test scans --------------
  const routeFiles = [
    "../src/worker/routes/auth.ts",
    "../src/worker/routes/self-service.ts",
    "../src/worker/support.ts",
    "../src/worker/app.ts",
  ];
  const envelopeLiteralRe = /envelope\(\s*reqId\s*,\s*"([^"]+)"/g;
  const routeCodes = new Set();
  for (const relative of routeFiles) {
    const text = readFileSync(new URL(relative, import.meta.url), "utf8");
    for (const match of text.matchAll(envelopeLiteralRe)) routeCodes.add(match[1]);
  }
  // Sanity check on the scan itself: a silently-broken regex (e.g. after a call-shape change) would
  // otherwise make this whole test vacuously pass with zero collected codes. The count is exact, so a
  // route code added to or removed from these files is a deliberate change here too.
  assert.equal(
    routeCodes.size,
    19,
    `expected exactly 19 distinct envelope() codes across the four route files, found ${routeCodes.size}`,
  );

  // ---- 2) local UI-only codes: string literals + identifier constants passed to localMessage() ----
  // Walk EVERY .ts/.tsx file under src/ui recursively rather than scanning a fixed file list -- a
  // fixed list silently misses a later new file that calls localMessage(...) (an earlier version of
  // this scan used a fixed list of 5 files, which would not have noticed a 6th).
  const uiRoot = new URL("../src/ui/", import.meta.url);
  function listUiSourceFiles(dirUrl) {
    const files = [];
    for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        files.push(...listUiSourceFiles(new URL(`${entry.name}/`, dirUrl)));
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(new URL(entry.name, dirUrl));
      }
    }
    return files;
  }
  const uiFiles = listUiSourceFiles(uiRoot);
  // Sanity check on the walk itself, mirroring the route-code guard above: a silently-broken walk
  // (e.g. a wrong root) would otherwise make this whole test vacuously pass with zero collected files.
  assert.ok(uiFiles.length >= 15, `expected at least 15 .ts/.tsx files under src/ui, found ${uiFiles.length}`);

  const localMessageLiteralRe = /localMessage\(\s*"([^"]+)"/g;
  const localMessageIdentifierRe = /localMessage\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,/g;
  const localCodes = new Set();
  const identifierUsages = new Set();
  for (const fileUrl of uiFiles) {
    const text = readFileSync(fileUrl, "utf8");
    for (const match of text.matchAll(localMessageLiteralRe)) localCodes.add(match[1]);
    for (const match of text.matchAll(localMessageIdentifierRe)) identifierUsages.add(match[1]);
  }
  // Identifier calls (localMessage(CONST, ...)) resolve through portalWorkflow.ts's own exports,
  // reachable here as workflow.<NAME> since it is the exact module already loaded above.
  for (const identifier of identifierUsages) {
    const resolved = typeof workflow[identifier] === "string" ? workflow[identifier] : undefined;
    assert.ok(
      resolved !== undefined,
      `localMessage(${identifier}, ...) uses a constant this coverage test cannot resolve -- export it from portalWorkflow.ts`,
    );
    localCodes.add(resolved);
  }

  // ---- 3) codes StatusLine never renders, or renders no better than its own generic fallback ------
  // DATA_ONLY_CODES are a GET envelope's 200 `data` payload, consumed as fields/rows elsewhere, never
  // handed to setMessage -- confirmed by grepping resultMessage( call sites (usePortalData.ts,
  // AuthFeature.tsx): neither passes a "me"/"entitlements" result to it.
  const DATA_ONLY_CODES = new Set([
    "me", // GET /api/portal/me: PortalMe read off result.data in AuthFeature's loadMe(), never given to setMessage
    "entitlements", // GET /api/portal/entitlements: { items } consumed as table rows in usePortalData.ts, never given to setMessage
    "bootstrap_otp", // POST /portal/v1/admin/bootstrap-otp: operator break-glass payload; the customer SPA has no caller for this route at all, so it never reaches setMessage
  ]);
  // portal_error (app.ts's catch-all for any unhandled exception) IS handed to StatusLine, unlike the
  // codes above, but is deliberately left unmapped: describeUnknownResult()'s generic reference
  // sentence names the request id for support, which a static string here cannot do.
  const GENERIC_FALLBACK_CODES = new Set(["portal_error"]);

  const allCodes = new Set([...routeCodes, ...localCodes]);
  const uncovered = [...allCodes].filter(
    (code) => !DATA_ONLY_CODES.has(code) && !GENERIC_FALLBACK_CODES.has(code) && workflow.describeResultCode(code) === null,
  );
  assert.deepEqual(uncovered, [], `every StatusLine-reachable code needs RESULT_CODE_COPY copy or an explicit exclusion; missing: ${uncovered.join(", ")}`);

  // Every excluded code must actually be one of the collected codes, or the exclusion is dead (and
  // may be hiding a code that should really be covered).
  const deadExclusions = [...DATA_ONLY_CODES, ...GENERIC_FALLBACK_CODES].filter((code) => !allCodes.has(code));
  assert.deepEqual(deadExclusions, [], `excluded codes never collected -- remove them: ${deadExclusions.join(", ")}`);

  // The verbatim success copy pinned by the brief.
  assert.equal(workflow.describeResultCode("otp_requested"), "Check your email for a sign-in code.");
  assert.equal(workflow.describeResultCode("logged_out"), "You're signed out.");

  // No copy anywhere in the map leaks a raw snake_case code as its own text.
  for (const code of allCodes) {
    if (DATA_ONLY_CODES.has(code) || GENERIC_FALLBACK_CODES.has(code)) continue;
    const copy = workflow.describeResultCode(code);
    assert.ok(copy === null || !copy.includes(code), `copy for "${code}" must not embed the raw code: ${copy}`);
  }
});

// A dropped connection (api()'s own fetch rejection, or the download's raw fetch) and a failed
// sign-out both need copy the customer actually sees, verbatim.
test("portal UI workflow maps network-failure and failed-logout copy verbatim", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(
    workflow.describeResultCode("network_unavailable"),
    "Couldn't reach the portal. Check your connection and try again.",
  );
  assert.equal(
    workflow.describeResultCode("logout_failed"),
    "Sign-out didn't complete. You're still signed in — try again.",
  );
});

// api()'s global onUnauthorized hook (App.tsx) shows this local code once a mid-session 401 is
// confirmed (retrySession() finds the session really is gone), regardless of which api() caller's
// response actually carried the server's own `unauthorized` code.
test("portal UI workflow maps the session-ended copy verbatim", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(
    workflow.describeResultCode("session_ended"),
    "Your session ended. Sign in again.",
  );
});

test("portal UI workflow shortens fingerprints like admin", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.shortHash("short"), "short");
  assert.equal(workflow.shortHash("a".repeat(16)), "a".repeat(16));
  assert.equal(workflow.shortHash("a".repeat(64)), "aaaaaaaa...aaaaaaaa");
});

test("portal UI workflow copy discloses account-safe auth", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.LOGIN_CODE_SENT_COPY, /If this email is registered/);
  assert.doesNotMatch(workflow.LOGIN_CODE_SENT_COPY, /We sent.*to/);
});

test("portal UI workflow formats epoch windows and timestamps", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.formatEpoch(1_710_000_000), "2024-03-09");
  // A missing start or end says so in words, through its own helper, never a bare "any".
  assert.equal(workflow.formatStartDate(null), "No start date");
  assert.equal(workflow.formatStartDate(undefined), "No start date");
  assert.equal(workflow.formatStartDate(1_710_000_000), "2024-03-09");
  assert.equal(workflow.formatEndDate(null), "No end date");
  assert.equal(workflow.formatEndDate(undefined), "No end date");
  assert.equal(workflow.formatEndDate(1_710_000_000), "2024-03-09");
  // 0 is the epoch itself -- a real date, exactly as the license status and the server read it.
  assert.equal(workflow.formatEndDate(0), "1970-01-01");
  // A value no calendar date can show -- a "never" sentinel, a negative or a non-number -- is not
  // a date, and must not throw mid-render (toISOString() does, past a JS Date's range).
  assert.equal(workflow.formatEndDate(Number.MAX_SAFE_INTEGER), "No end date");
  assert.equal(workflow.formatEndDate(253_402_300_800), "No end date");
  assert.equal(workflow.formatEndDate(253_402_300_799), "9999-12-31");
  assert.equal(workflow.formatStartDate(-5), "No start date");
  assert.equal(workflow.formatStartDate(Number.NaN), "No start date");
  assert.equal(workflow.formatWindow(null, null), "No start date to No end date");
  assert.equal(workflow.formatWindow(1_710_000_000, null), "2024-03-09 to No end date");
  assert.equal(workflow.formatWindow(null, 1_710_000_000), "No start date to 2024-03-09");
  assert.equal(workflow.formatTimestamp(0), "-");
  assert.equal(workflow.formatTimestamp(null), "-");
  assert.equal(typeof workflow.formatTimestamp(1_710_000_000), "string");
  assert.notEqual(workflow.formatTimestamp(1_710_000_000), "-");
});

test("portal UI workflow normalizes + validates email", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.normalizeEmail("  USER@Example.COM  "), "user@example.com");
  assert.equal(workflow.normalizeEmail(123), "");
  assert.equal(workflow.isLikelyEmail("user@example.com"), true);
  assert.equal(workflow.isLikelyEmail("  User@Example.com "), true);
  assert.equal(workflow.isLikelyEmail("not-an-email"), false);
  assert.equal(workflow.isLikelyEmail("a@b"), false);
  assert.equal(workflow.isLikelyEmail("a b@example.com"), false);
  assert.equal(workflow.isLikelyEmail(""), false);
});

test("portal UI workflow accepts only 8-digit OTP codes", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.normalizeCode(" 1234 5678 "), "12345678");
  assert.equal(workflow.isValidCode("12345678"), true);
  assert.equal(workflow.isValidCode(" 1234 5678 "), true);
  assert.equal(workflow.isValidCode("1234567"), false); // 7 digits
  assert.equal(workflow.isValidCode("123456789"), false); // 9 digits
  assert.equal(workflow.isValidCode("1234567a"), false); // non-digit
  assert.equal(workflow.isValidCode(""), false);
});

test("license display preserves explicit status and handles exact date boundaries", async () => {
  const { licenseDisplayStatus: status } = await loadWorkflowModule();
  const row = { status: "active", valid_from: 100, valid_until: 200 };
  assert.equal(status(row, 99), "not_started");
  assert.equal(status(row, 100), "active");
  assert.equal(status(row, 199), "active");
  assert.equal(status(row, 200), "expired");
  assert.equal(status({ ...row, status: "disabled" }, 300), "disabled");
  assert.equal(status({ ...row, status: "revoked" }, 300), "revoked");
});

// A trial the rule that enforces it has ended is expired like any other ended license, and a
// status code the portal does not know is never passed through to the page.
test("license display treats an ended trial as expired and never passes an unknown status through", async () => {
  const { licenseDisplayStatus: status } = await loadWorkflowModule();
  const trial = { status: "active", valid_from: null, valid_until: null, trial_ends_at: 150 };
  assert.equal(status(trial, 149), "active");
  assert.equal(status(trial, 150), "expired");
  assert.equal(status({ ...trial, trial_ends_at: null, trial_starts_on_activation: true }, 10_000), "active", "an unstarted trial has not ended");
  // A trial with no end of its own (a zero-duration trial, the admin's default from_issue trial
  // with no end date) never reads as expired: nothing enforces an end on it.
  assert.equal(status({ ...trial, trial_ends_at: null, trial_starts_on_activation: false }, 10_000), "active");
  assert.equal(status({ ...trial, trial_ends_at: undefined }, 10_000), "active", "a row without the field claims nothing");
  assert.equal(status({ ...trial, valid_until: 120 }, 130), "expired", "whichever end comes first ends the license");
  assert.equal(status({ ...trial, status: "paused" }, 100), "unknown");
  assert.equal(status({ ...trial, status: "constructor" }, 100), "unknown");
});

// Every lifecycle state reads as words with its date; the next step (contact support) is
// rendered by <SupportContact/> after this lead, by the entitlements feature.
test("license status copy names each lifecycle state with its UTC date", async () => {
  const { licenseStatusLead: lead } = await loadWorkflowModule();
  const row = { status: "active", valid_from: 1_700_000_000, valid_until: 1_750_000_000 };
  assert.equal(lead(row, 1_710_000_000), "Active");
  assert.equal(lead(row, 1_760_000_000), "Expired on 2025-06-15.");
  assert.equal(lead(row, 1_600_000_000), "Starts 2023-11-14.");
  assert.equal(lead({ ...row, status: "disabled" }, 1_710_000_000), "Suspended.");
  assert.equal(lead({ ...row, status: "revoked" }, 1_710_000_000), "Revoked.");
  // An ended trial is dated by when it actually ended: the earlier of the trial end and valid_until.
  assert.equal(lead({ ...row, trial_ends_at: 1_705_000_000 }, 1_710_000_000), "Expired on 2024-01-11.");
  assert.equal(lead({ ...row, valid_until: null, trial_ends_at: 1_705_000_000 }, 1_710_000_000), "Expired on 2024-01-11.");
  assert.equal(lead({ ...row, status: "paused" }, 1_710_000_000), "Unavailable.");
  for (const status of ["active", "disabled", "revoked", "paused"]) {
    for (const now of [1_600_000_000, 1_710_000_000, 1_760_000_000]) {
      const copy = lead({ ...row, status }, now);
      assert.doesNotMatch(copy, /disabled|not_started|paused|_/, `no raw status code in "${copy}"`);
    }
  }
});

test("license mode names a trial's end, says the first activation starts it, or just says Trial", async () => {
  const { licenseModeLabel: mode } = await loadWorkflowModule();
  const now = 1_700_000_000;
  const usable = { status: "active", valid_from: null, valid_until: null };
  const protectedTrial = { ...usable, license_mode: "trial", trial_starts_on_activation: false };
  // 1) An end: "ends" ahead of it, "ended" once it has passed.
  assert.equal(mode({ ...protectedTrial, trial_ends_at: 1_800_000_000 }, now), "Protected device · Trial · ends 2027-01-15");
  assert.equal(mode({ ...protectedTrial, trial_ends_at: 1_600_000_000 }, now), "Protected device · Trial · ended 2020-09-13");
  assert.equal(mode({ ...protectedTrial, trial_ends_at: now }, now), "Protected device · Trial · ended 2023-11-14");
  // 2) No end yet, and the first activation starts the clock.
  assert.equal(mode({ ...protectedTrial, trial_ends_at: null, trial_starts_on_activation: true }, now), "Protected device · Trial starts when you activate");
  // 3) No end and no activation clock -- a zero-duration trial, or the admin's default from_issue
  //    trial with no end date: just "Protected device · Trial" (the Valid column already says "No
  //    end date").
  assert.equal(mode({ ...protectedTrial, trial_ends_at: null }, now), "Protected device · Trial");
  // Every license is protected, so a license that is not a trial reads just "Protected device".
  assert.equal(mode({ ...usable, license_mode: "node_locked", trial_ends_at: null }, now), "Protected device");
});

// "starts when you activate" is a promise about a license the customer can still activate. Next
// to "Revoked.", "Suspended." or "Expired on ..." it would contradict the status, so it reads "Trial".
test("license mode says the first activation starts a trial only while the license is usable", async () => {
  const { licenseModeLabel: mode } = await loadWorkflowModule();
  const now = 1_700_000_000;
  const pending = { license_mode: "trial", status: "active", valid_from: null, valid_until: null,
    trial_ends_at: null, trial_starts_on_activation: true };
  assert.equal(mode(pending, now), "Protected device · Trial starts when you activate");
  assert.equal(mode({ ...pending, valid_from: now + 86_400 }, now), "Protected device · Trial starts when you activate",
    "not yet valid: activating once it starts still starts the trial");
  assert.equal(mode({ ...pending, status: "revoked" }, now), "Protected device · Trial", "revoked");
  assert.equal(mode({ ...pending, status: "disabled" }, now), "Protected device · Trial", "suspended");
  assert.equal(mode({ ...pending, valid_until: now - 86_400 }, now), "Protected device · Trial", "expired, with an unstarted trial");
  assert.equal(mode({ ...pending, status: "paused" }, now), "Protected device · Trial", "a status the portal does not know is not usable");
});

test("a license needs attention when it is expired, suspended or revoked, not when it is yet to start", async () => {
  const { licenseNeedsAttention: attention, LICENSE_ATTENTION_COPY } = await loadWorkflowModule();
  assert.equal(LICENSE_ATTENTION_COPY, "Needs attention");
  const row = { status: "active", valid_from: null, valid_until: null };
  assert.equal(attention(row, 1_000), false);
  assert.equal(attention({ ...row, valid_until: 1_000 }, 1_000), true);
  assert.equal(attention({ ...row, trial_ends_at: 900 }, 1_000), true);
  assert.equal(attention({ ...row, status: "disabled" }, 1_000), true);
  assert.equal(attention({ ...row, status: "revoked" }, 1_000), true);
  assert.equal(attention({ ...row, valid_from: 2_000 }, 1_000), false);
});
