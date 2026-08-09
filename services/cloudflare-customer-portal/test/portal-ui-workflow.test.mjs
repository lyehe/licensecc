import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

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
  assert.equal(workflow.FLOATING_SEAT_RELEASE_CONFIRM_TITLE, "Release floating seat?");
  assert.match(workflow.FLOATING_SEAT_RELEASE_CONFIRM_COPY, /cannot be undone/i);
  assert.match(workflow.FLOATING_SEAT_RELEASE_CONFIRM_COPY, /available to another user/i);
  assert.match(workflow.FLOATING_SEAT_RELEASE_CONFIRM_COPY, /device must check out a new seat/i);
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

test("portal UI workflow exposes resend-code action + 10-minute expiry copy", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.RESEND_CODE_ACTION_LABEL, /resend/i);
  assert.match(workflow.OTP_EXPIRY_COPY, /10 minutes/);
});

test("portal UI workflow exposes empty-state copy for every tab", async () => {
  const workflow = await loadWorkflowModule();
  assert.match(workflow.NO_ENTITLEMENTS_EMPTY_COPY, /No entitlements yet/);
  assert.match(workflow.NO_ENTITLEMENTS_EMPTY_COPY, /after purchase/);
  assert.match(workflow.NO_DEVICES_EMPTY_COPY, /No devices/i);
  assert.match(workflow.NO_USAGE_EMPTY_COPY, /No usage/i);
  assert.match(workflow.NO_DOWNLOADS_EMPTY_COPY, /No .*licenses|nothing to download/i);
});

test("portal UI workflow maps raw result codes to human-readable copy", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(
    workflow.describeResultCode("pool_exhausted"),
    "All seats are in use — release one or ask your administrator.",
  );
  assert.equal(
    workflow.describeResultCode("device_limit_exceeded"),
    "This license's device limit is reached — release a device on the Devices tab.",
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
  // An unmapped code returns null so the UI can fall back to showing the raw code.
  assert.equal(workflow.describeResultCode("some_unknown_code"), null);
  assert.equal(workflow.describeResultCode(""), null);
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
  assert.match(workflow.ACTIVATION_DOWNLOAD_DISCLOSURE, /activates this entitlement/);
  assert.match(workflow.ACTIVATION_DOWNLOAD_DISCLOSURE, /trial time/);
  // The download form asks for a raw "device key id"; the UI must say where it comes from.
  assert.match(workflow.DEVICE_KEY_HELP_COPY, /device key id/i);
  assert.match(workflow.DEVICE_KEY_HELP_COPY, /Devices/);
});

test("portal UI workflow formats epoch windows and timestamps", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.formatEpoch(null), "any");
  assert.equal(workflow.formatEpoch(undefined), "any");
  assert.equal(workflow.formatEpoch(0), "any");
  assert.equal(workflow.formatEpoch(-5), "any");
  assert.equal(workflow.formatEpoch(1_710_000_000), "2024-03-09");
  assert.equal(workflow.formatWindow(null, null), "any to any");
  assert.equal(workflow.formatWindow(1_710_000_000, null), "2024-03-09 to any");
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
