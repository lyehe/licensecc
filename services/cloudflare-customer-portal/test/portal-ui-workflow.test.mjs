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
