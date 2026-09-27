import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "@typescript/typescript6";
import { BACKEND_PROXY_ERROR_MANIFEST } from "../src/auth/portal_backend_error_manifest.mjs";

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

test("portal UI workflow builds session-scoped read + action paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.mePath(), "/api/portal/me");
  assert.equal(workflow.entitlementsPath(), "/api/portal/entitlements");
  assert.equal(workflow.devicesPath(), "/api/portal/devices");
  assert.equal(workflow.downloadPath(), "/api/portal/download");
  assert.equal(workflow.checkoutPath(), "/api/portal/checkout");
  assert.equal(workflow.heartbeatPath(), "/api/portal/heartbeat");
  assert.equal(workflow.releasePath(), "/api/portal/release");
});

test("portal UI workflow exposes the self-serve device-release path + copy", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.deviceReleasePath(), "/api/portal/devices/release");
  assert.equal(workflow.DEVICE_RELEASE_ACTION_LABEL, "Release");
  // The confirm copy MUST state the consequence so a customer cannot release a device by reflex.
  assert.match(workflow.DEVICE_RELEASE_CONFIRM_COPY, /frees one device slot/);
  assert.match(workflow.DEVICE_RELEASE_CONFIRM_COPY, /activate again/);
});

test("portal UI workflow maps floating-seat release confirmation copy to its consequences", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.FLOATING_SEAT_RELEASE_CONFIRM_TITLE, "Release seat?");
  assert.match(workflow.FLOATING_SEAT_RELEASE_CONFIRM_COPY, /cannot be undone/i);
  assert.match(workflow.FLOATING_SEAT_RELEASE_CONFIRM_COPY, /available to another user/i);
  assert.match(workflow.FLOATING_SEAT_RELEASE_CONFIRM_COPY, /browser must check out a new seat/i);
  assert.match(workflow.FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY, /outcome is unknown/i);
  assert.match(workflow.FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY, /check the seat status/i);
  assert.equal(workflow.FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE, "floating_seat_release_refresh_failed");
  assert.match(workflow.FLOATING_SEAT_RELEASE_REFRESH_ERROR_COPY, /released; status refresh failed/i);
  assert.equal(
    workflow.describeResultCode(workflow.FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE),
    workflow.FLOATING_SEAT_RELEASE_REFRESH_ERROR_COPY,
  );
  assert.equal(workflow.PORTAL_STATUS_REFRESH_ACTION_LABEL, "Refresh status");
});

test("portal UI workflow exposes the OTP 10-minute expiry copy", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.OTP_EXPIRY_COPY, /10 minutes/);
});

// C6: one sentence for every auth 429 that now carries the server's retry-after header, and the
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

test("portal UI workflow exposes empty-state copy for every tab", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.NO_ENTITLEMENTS_EMPTY_COPY, /No licenses yet/);
  assert.match(workflow.NO_ENTITLEMENTS_EMPTY_COPY, /after purchase/);
  assert.match(workflow.NO_DEVICES_EMPTY_COPY, /No devices/i);
});

test("portal UI workflow maps raw result codes to human-readable copy", async () => {
  const workflow = await loadWorkflowModule();
  // pool_exhausted is deliberately absent from this pure string map (D2): its copy links out via
  // <SupportContact/>, a React node, so it is mapped instead in ui/shared/ActionResult.tsx -- see the
  // dedicated coverage test below, which checks that file directly.
  assert.equal(workflow.describeResultCode("pool_exhausted"), null);
  assert.equal(
    workflow.describeResultCode("device_limit_exceeded"),
    "This license's device limit is reached — release a device under Devices.",
  );
  assert.equal(
    workflow.describeResultCode("expired_subscription"),
    "This subscription has expired — renew it to continue.",
  );
  assert.equal(
    workflow.describeResultCode("invalid_otp"),
    "That code is wrong or expired — request a new one.",
  );
  assert.equal(
    workflow.describeResultCode("seat_reclaimed"),
    "Your seat was reclaimed after inactivity — check out again.",
  );
  assert.equal(
    workflow.describeResultCode("rate_limited"),
    "Too many attempts — wait a moment and try again.",
  );
  // An unmapped code returns null so the caller (StatusLine) can fall back to the generic reference
  // message instead of the raw code.
  assert.equal(workflow.describeResultCode("some_unknown_code"), null);
  assert.equal(workflow.describeResultCode(""), null);
  // Prototype-safe lookup (C1 / RF3): a code equal to an Object.prototype member name must resolve to
  // null too, via Object.hasOwn -- NOT `RESULT_CODE_COPY[code] ?? null`, which would instead return
  // that inherited function/value and crash React ("Objects are not valid as a React child") or
  // silently render a function. Carried forward from A3, which fixed the identical bug in
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

test("portal UI workflow maps the download_failed_<status> family by prefix, status hidden from the sentence", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.describeResultCode(`${workflow.DOWNLOAD_FAILED_PREFIX}500`), workflow.DOWNLOAD_FAILED_COPY);
  assert.equal(workflow.describeResultCode(`${workflow.DOWNLOAD_FAILED_PREFIX}404`), workflow.DOWNLOAD_FAILED_COPY);
  assert.equal(workflow.describeResultCode("download_failed_0"), workflow.DOWNLOAD_FAILED_COPY);
  // The status code itself never appears in the main sentence (it stays in Technical details only).
  assert.doesNotMatch(workflow.DOWNLOAD_FAILED_COPY, /[0-9]/);
});

test("portal UI workflow gives every StatusLine-reachable result code human copy (C1 coverage)", async () => {
  const workflow = await loadWorkflowModule();

  // ---- 1) envelope(reqId, "...") literals from the four route files C1 scans --------------------
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
  // otherwise make this whole test vacuously pass with zero collected codes.
  assert.ok(
    routeCodes.size >= 20,
    `expected at least 20 distinct envelope() codes across the four route files, found ${routeCodes.size}`,
  );

  // ---- 2) BACKEND_PROXY_ERROR_MANIFEST codes ------------------------------------------------------
  const manifestCodes = new Set();
  for (const statuses of Object.values(BACKEND_PROXY_ERROR_MANIFEST)) {
    for (const codes of Object.values(statuses)) {
      for (const code of codes) manifestCodes.add(code);
    }
  }
  assert.ok(manifestCodes.size >= 15, `expected at least 15 distinct manifest codes, found ${manifestCodes.size}`);

  // ---- 3) local UI-only codes: string literals + identifier constants passed to localMessage() ----
  // Walk EVERY .ts/.tsx file under src/ui recursively rather than scanning a fixed file list -- a
  // fixed list silently misses a later task's new file that calls localMessage(...) (carried into
  // C2's dispatch: C1's original list of 5 files would not have noticed a 6th).
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
  // Sanity check on the walk itself, mirroring the >=20/>=15 guards above: a silently-broken walk
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
  // Identifier calls (localMessage(CONST, ...)) resolve through the explicit imports below: most UI
  // constants are portalWorkflow.ts's own exports, reachable here as workflow.<NAME> since it is the
  // exact module already loaded above. DEVICES_REFRESH_FAILURE_CODE (DevicesFeature.tsx) is the one
  // exception -- a re-exported alias of FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE defined locally
  // rather than in portalWorkflow.ts -- so it is asserted textually below (rather than transpiling a
  // React/JSX file just for one string) so a future rename cannot silently drift the two apart.
  const devicesFeatureSource = readFileSync(new URL("features/devices/DevicesFeature.tsx", uiRoot), "utf8");
  assert.match(
    devicesFeatureSource,
    /export const DEVICES_REFRESH_FAILURE_CODE = FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE;/,
    "DEVICES_REFRESH_FAILURE_CODE must stay a plain alias of FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE",
  );
  const KNOWN_LOCAL_ALIASES = { DEVICES_REFRESH_FAILURE_CODE: "FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE" };
  for (const identifier of identifierUsages) {
    const aliasTarget = KNOWN_LOCAL_ALIASES[identifier];
    const resolved = typeof workflow[identifier] === "string"
      ? workflow[identifier]
      : typeof workflow[aliasTarget] === "string" ? workflow[aliasTarget] : undefined;
    assert.ok(
      resolved !== undefined,
      `localMessage(${identifier}, ...) uses a constant this coverage test cannot resolve -- ` +
      "export it from portalWorkflow.ts (preferred) or extend KNOWN_LOCAL_ALIASES",
    );
    localCodes.add(resolved);
  }

  // ---- 4) the dynamic `${operation}_ok` success family (self-service.ts apiAction) -----------------
  // Not a string literal (a template literal keyed by the server-controlled `operation`); its only
  // three possible values are fixed by SESSION_DISPATCH's three seat operations (checkout/heartbeat/
  // release), and DevicesFeature.tsx's seatAction() passes every one of them to setMessage/resultMessage.
  const seatAckCodes = ["checkout_ok", "heartbeat_ok", "release_ok"];

  // ---- 5) pure data-payload codes StatusLine never renders -----------------------------------------
  // Each is a GET envelope's 200 `data` payload consumed as fields/rows elsewhere, never handed to
  // setMessage -- confirmed by grepping resultMessage( call sites (usePortalData.ts, AuthFeature.tsx):
  // none of them pass a "me"/"entitlements"/"devices"/"usage" result to it.
  const DATA_ONLY_CODES = new Set([
    "me", // GET /api/portal/me: PortalMe read off result.data in AuthFeature's loadMe(), never given to setMessage
    "entitlements", // GET /api/portal/entitlements: { items } consumed as table rows in usePortalData.ts, never given to setMessage
    "devices", // GET /api/portal/devices: { items } consumed as table rows in usePortalData.ts, never given to setMessage
    "usage", // GET /api/portal/usage: { items } consumed as table rows in usePortalData.ts, never given to setMessage
    "bootstrap_otp", // POST /portal/v1/admin/bootstrap-otp: operator break-glass payload; the customer SPA has no caller for this route at all, so it never reaches setMessage
  ]);

  // ---- 6) codes covered by a React node (ui/shared/ActionResult.tsx) instead of RESULT_CODE_COPY --
  // pool_exhausted's copy links out through <SupportContact/> (D2), which cannot live in this pure
  // string map, so it is excluded here the same way DATA_ONLY_CODES is -- but verified against the
  // node file's actual source, not just blindly excluded, so a future removal there would still fail.
  const NODE_ONLY_CODES = new Set(["pool_exhausted"]);
  const actionResultSource = readFileSync(new URL("../src/ui/shared/ActionResult.tsx", import.meta.url), "utf8");
  for (const code of NODE_ONLY_CODES) {
    const keyRe = new RegExp(`\\b${code}:\\s*<>`);
    assert.match(
      actionResultSource,
      keyRe,
      `ActionResult.tsx must map "${code}" to a React node -- update NODE_ONLY_CODES if it moved elsewhere`,
    );
  }
  assert.match(
    actionResultSource,
    /<SupportContact\s*\/>/,
    "ActionResult.tsx's pool_exhausted copy must link out through <SupportContact/>",
  );

  const allCodes = new Set([...routeCodes, ...manifestCodes, ...localCodes, ...seatAckCodes]);
  const uncovered = [...allCodes].filter(
    (code) => !DATA_ONLY_CODES.has(code) && !NODE_ONLY_CODES.has(code) && workflow.describeResultCode(code) === null,
  );
  assert.deepEqual(uncovered, [], `every StatusLine-reachable code needs RESULT_CODE_COPY (or NODE_ONLY_CODES) copy; missing: ${uncovered.join(", ")}`);

  // Every DATA_ONLY_CODES/NODE_ONLY_CODES entry must actually be one of the collected codes, or the
  // exclusion is dead (and may be hiding a code that should really be covered).
  const deadExclusions = [...DATA_ONLY_CODES, ...NODE_ONLY_CODES].filter((code) => !allCodes.has(code));
  assert.deepEqual(deadExclusions, [], `DATA_ONLY_CODES/NODE_ONLY_CODES entries never collected -- remove them: ${deadExclusions.join(", ")}`);

  // The verbatim success copy pinned by the brief.
  assert.equal(workflow.describeResultCode("otp_requested"), "Check your email for a sign-in code.");
  assert.equal(workflow.describeResultCode("logged_out"), "You're signed out.");
  assert.equal(workflow.describeResultCode("checkout_ok"), "Seat started.");
  assert.equal(workflow.describeResultCode("release_ok"), "Seat released.");
  assert.equal(workflow.describeResultCode("device_released"), "Device released.");
  assert.equal(workflow.describeResultCode("download_started"), "Download started.");

  // No copy anywhere in the map leaks a raw snake_case code as its own text.
  for (const code of allCodes) {
    if (DATA_ONLY_CODES.has(code)) continue;
    const copy = workflow.describeResultCode(code);
    assert.ok(copy === null || !copy.includes(code), `copy for "${code}" must not embed the raw code: ${copy}`);
  }
});

// C2: a dropped connection (api()'s own fetch rejection, or the download's raw fetch) and a failed
// sign-out both need copy the customer actually sees, verbatim per the dispatch.
test("portal UI workflow maps network-failure and failed-logout copy verbatim (C2)", async () => {
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

// C3: api()'s global onUnauthorized hook (App.tsx) shows this local code once a mid-session 401 is
// confirmed (retrySession() finds the session really is gone), regardless of which api() caller's
// response actually carried the server's own `unauthorized` code.
test("portal UI workflow maps the session-ended copy verbatim (C3)", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(
    workflow.describeResultCode("session_ended"),
    "Your session ended. Sign in again.",
  );
});

// D3: sign-out's best-effort seat release. StatusLine (api.tsx) special-cases this code to interpolate
// the released/failed counts via seatsReleasedMessage() instead of this static string -- this is only
// the fallback for the (never expected in practice) case where the message carries no params, and it
// must still be non-null coverage per C1, and never leak the raw code itself.
test("portal UI workflow maps the seats-released-on-signout fallback copy, never the raw code (D3)", async () => {
  const workflow = await loadWorkflowModule();
  const copy = workflow.describeResultCode("seats_released_on_signout");
  assert.equal(typeof copy, "string");
  assert.doesNotMatch(copy, /seats_released_on_signout/);
});

test("portal UI workflow builds filtered usage paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.usagePath(), "/api/portal/usage");
  assert.equal(workflow.usagePath({}), "/api/portal/usage");
  assert.equal(workflow.usagePath({ project: "", feature: "" }), "/api/portal/usage");
  assert.equal(workflow.usagePath({ project: "DEFAULT" }), "/api/portal/usage?project=DEFAULT");
  assert.equal(
    workflow.usagePath({ project: "DEFAULT", feature: "pro seats" }),
    "/api/portal/usage?project=DEFAULT&feature=pro+seats",
  );
});

test("portal UI workflow shortens fingerprints like admin", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.shortHash("short"), "short");
  assert.equal(workflow.shortHash("a".repeat(16)), "a".repeat(16));
  assert.equal(workflow.shortHash("a".repeat(64)), "aaaaaaaa...aaaaaaaa");
});

test("portal UI workflow copy discloses account-safe auth and activation download", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.LOGIN_CODE_SENT_COPY, /If this email is registered/);
  assert.doesNotMatch(workflow.LOGIN_CODE_SENT_COPY, /We sent.*to/);
  assert.equal(workflow.ACTIVATION_DOWNLOAD_ACTION_LABEL, "Activate and download .lic");
  assert.match(workflow.ACTIVATION_DOWNLOAD_DISCLOSURE, /activates this license/);
  assert.match(workflow.ACTIVATION_DOWNLOAD_DISCLOSURE, /trial time/);
  // The download form asks for a raw "device key id"; the UI must say where it comes from.
  assert.match(workflow.DEVICE_KEY_HELP_COPY, /device key id/i);
  assert.match(workflow.DEVICE_KEY_HELP_COPY, /Devices/);
});

test("portal UI workflow formats epoch windows and timestamps", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.formatEpoch(1_710_000_000), "2024-03-09");
  // C5: a missing start or end says so in words, through its own helper, never a bare "any".
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

test("portal UI workflow persists seat sessions across reload", async () => {
  const workflow = await loadWorkflowModule();
  const now = 1_000_000;

  // The localStorage key is a stable, versioned namespace so a schema change is a new key, not a
  // silent misread of stale shapes.
  assert.equal(workflow.SEATS_KEY, "licensecc.portal.seats.v1");

  // Round-trip: a live lease (expires_at strictly in the future) survives serialize -> hydrate.
  const live = {
    "ent-live": { seat_id: "seat-1", client_instance_id: "cid-1", expires_at: now + 3600 },
  };
  const json = workflow.serializeSeatSessions(live);
  assert.deepEqual(workflow.hydrateSeatSessions(json, now), live);

  // Expired lease (expires_at <= now) is dropped so its Release/Refresh buttons don't re-enable
  // against a seat the server already reclaimed.
  const mixed = workflow.serializeSeatSessions({
    "ent-live": { seat_id: "seat-1", client_instance_id: "cid-1", expires_at: now + 10 },
    "ent-dead": { seat_id: "seat-2", client_instance_id: "cid-2", expires_at: now },
    "ent-past": { seat_id: "seat-3", client_instance_id: "cid-3", expires_at: now - 1 },
  });
  assert.deepEqual(workflow.hydrateSeatSessions(mixed, now), {
    "ent-live": { seat_id: "seat-1", client_instance_id: "cid-1", expires_at: now + 10 },
  });

  // Garbage / absent storage tolerated -> empty map (never throws).
  assert.deepEqual(workflow.hydrateSeatSessions(null, now), {});
  assert.deepEqual(workflow.hydrateSeatSessions("", now), {});
  assert.deepEqual(workflow.hydrateSeatSessions("not json", now), {});
  assert.deepEqual(workflow.hydrateSeatSessions("[1,2,3]", now), {});
  assert.deepEqual(workflow.hydrateSeatSessions('{"bad":123}', now), {});
  // Entries missing required string fields are skipped, not partially hydrated.
  assert.deepEqual(
    workflow.hydrateSeatSessions('{"ent":{"seat_id":"s","expires_at":2000000}}', now),
    {},
  );
});


test("license display preserves explicit status and handles exact date boundaries", async () => {
  const { licenseDisplayStatus: status, canDownloadLicense: downloadable } = await loadWorkflowModule();
  const row = { status: "active", valid_from: 100, valid_until: 200 };
  assert.equal(status(row, 99), "not_started");
  assert.equal(status(row, 100), "active");
  assert.equal(status(row, 199), "active");
  assert.equal(status(row, 200), "expired");
  assert.equal(status({ ...row, status: "disabled" }, 300), "disabled");
  assert.equal(status({ ...row, status: "revoked" }, 300), "revoked");
  assert.equal(downloadable({ license_mode: "node_locked", enforcement_mode: "device_bound_v1" }), false);
  assert.equal(downloadable({ license_mode: "trial", enforcement_mode: "legacy" }), true);
  assert.equal(downloadable({ license_mode: "floating" }), false);
});

// C5: a trial the rule that enforces it has ended is expired like any other ended license, and a
// status code the portal does not know is never passed through to the page.
test("license display treats an ended trial as expired and never passes an unknown status through (C5)", async () => {
  const { licenseDisplayStatus: status } = await loadWorkflowModule();
  const trial = { status: "active", valid_from: null, valid_until: null, trial_ends_at: 150 };
  assert.equal(status(trial, 149), "active");
  assert.equal(status(trial, 150), "expired");
  assert.equal(status({ ...trial, trial_ends_at: null, trial_starts_on_activation: true }, 10_000), "active", "an unstarted trial has not ended");
  // A trial with no end of its own (a zero-duration legacy trial, the admin's default from_issue
  // trial with no end date) never reads as expired: nothing enforces an end on it.
  assert.equal(status({ ...trial, trial_ends_at: null, trial_starts_on_activation: false }, 10_000), "active");
  assert.equal(status({ ...trial, trial_ends_at: undefined }, 10_000), "active", "a row without the field claims nothing");
  assert.equal(status({ ...trial, valid_until: 120 }, 130), "expired", "whichever end comes first ends the license");
  assert.equal(status({ ...trial, status: "paused" }, 100), "unknown");
  assert.equal(status({ ...trial, status: "constructor" }, 100), "unknown");
});

// C5: every lifecycle state reads as words with its date; the next step (contact support) is
// rendered by <SupportContact/> after this lead, by the entitlements feature.
test("license status copy names each lifecycle state with its UTC date (C5)", async () => {
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

test("license mode names a trial's end, says the first activation starts it, or just says Trial (C5)", async () => {
  const { licenseModeLabel: mode } = await loadWorkflowModule();
  const now = 1_700_000_000;
  const usable = { status: "active", valid_from: null, valid_until: null };
  const protectedTrial = { ...usable, enforcement_mode: "device_bound_v1", license_mode: "trial", trial_starts_on_activation: false };
  const legacyTrial = { ...usable, enforcement_mode: "legacy", license_mode: "trial", trial_starts_on_activation: false };
  // 1) An end: "ends" ahead of it, "ended" once it has passed.
  assert.equal(mode({ ...protectedTrial, trial_ends_at: 1_800_000_000 }, now), "Protected device · Trial · ends 2027-01-15");
  assert.equal(mode({ ...protectedTrial, trial_ends_at: 1_600_000_000 }, now), "Protected device · Trial · ended 2020-09-13");
  assert.equal(mode({ ...protectedTrial, trial_ends_at: now }, now), "Protected device · Trial · ended 2023-11-14");
  assert.equal(mode({ ...legacyTrial, trial_ends_at: 1_800_000_000 }, now), "Trial · ends 2027-01-15");
  // 2) No end yet, and the first activation starts the clock.
  assert.equal(mode({ ...protectedTrial, trial_ends_at: null, trial_starts_on_activation: true }, now), "Protected device · Trial starts when you activate");
  assert.equal(mode({ ...legacyTrial, trial_ends_at: null, trial_starts_on_activation: true }, now), "Trial starts when you activate");
  // 3) No end and no activation clock -- a zero-duration legacy trial, or the admin's default
  //    from_issue trial with no end date: just "Trial" (the Valid column already says "No end date").
  assert.equal(mode({ ...legacyTrial, trial_ends_at: null }, now), "Trial");
  assert.equal(mode({ ...protectedTrial, trial_ends_at: null }, now), "Protected device · Trial");
  // A row from a Worker that predates these fields makes no claim about the trial clock.
  assert.equal(mode({ ...usable, enforcement_mode: "device_bound_v1", license_mode: "trial" }, now), "Protected device · Trial");
  assert.equal(mode({ ...usable, license_mode: "trial" }, now), "Trial");
  assert.equal(mode({ ...usable, enforcement_mode: "device_bound_v1", license_mode: "node_locked", trial_ends_at: null }, now), "Protected device");
  assert.equal(mode({ ...usable, license_mode: "node_locked", trial_ends_at: null }, now), "Node-locked");
  assert.equal(mode({ ...usable, license_mode: "floating", trial_ends_at: null }, now), "Floating");
});

// C5: "starts when you activate" is a promise about a license the customer can still activate. Next
// to "Revoked.", "Suspended." or "Expired on ..." it would contradict the status, so it reads "Trial".
test("license mode says the first activation starts a trial only while the license is usable (C5)", async () => {
  const { licenseModeLabel: mode } = await loadWorkflowModule();
  const now = 1_700_000_000;
  const pending = { enforcement_mode: "device_bound_v1", license_mode: "trial", status: "active", valid_from: null, valid_until: null,
    trial_ends_at: null, trial_starts_on_activation: true };
  assert.equal(mode(pending, now), "Protected device · Trial starts when you activate");
  assert.equal(mode({ ...pending, valid_from: now + 86_400 }, now), "Protected device · Trial starts when you activate",
    "not yet valid: activating once it starts still starts the trial");
  assert.equal(mode({ ...pending, status: "revoked" }, now), "Protected device · Trial", "revoked");
  assert.equal(mode({ ...pending, status: "disabled" }, now), "Protected device · Trial", "suspended");
  assert.equal(mode({ ...pending, valid_until: now - 86_400 }, now), "Protected device · Trial", "expired, with an unstarted trial");
  assert.equal(mode({ ...pending, enforcement_mode: "legacy", valid_until: now - 86_400 }, now), "Trial", "an expired legacy row too");
  assert.equal(mode({ ...pending, status: "paused" }, now), "Protected device · Trial", "a status the portal does not know is not usable");
});

test("a license needs attention when it is expired, suspended or revoked, not when it is yet to start (C5)", async () => {
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
