import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "@typescript/typescript6";

// Transpile the PURE authCopy.ts (no React/DOM/node deps, no imports at all) and import it as an ES
// module -- the same seam test/portal-ui-workflow.test.mjs uses for portalWorkflow.ts.
async function loadAuthCopyModule() {
  const source = readFileSync(new URL("../src/ui/features/auth/authCopy.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "licensecc-portal-auth-copy-"));
  const file = join(dir, "authCopy.mjs");
  writeFileSync(file, transpiled, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The resend button's client-side-only cooldown label -- "Resend code" once free, else "Resend
// code (0:59)" counting down. The cooldown never reaches a full minute, so the minutes digit is
// always "0".
test("authCopy formats the resend cooldown label and never reaches a full minute", async () => {
  const authCopy = await loadAuthCopyModule();
  assert.equal(authCopy.RESEND_COOLDOWN_SECONDS, 60);
  assert.equal(authCopy.resendCodeLabel(0), "Resend code");
  assert.equal(authCopy.resendCodeLabel(-1), "Resend code", "a non-positive remainder reads as available");
  assert.equal(authCopy.resendCodeLabel(59), "Resend code (0:59)");
  assert.equal(authCopy.resendCodeLabel(9), "Resend code (0:09)", "single-digit seconds are zero-padded");
  assert.equal(authCopy.resendCodeLabel(1), "Resend code (0:01)");
});

// Recovery hints (passwordMessages' verified_sign_in_required, PasswordSettings' own hard-coded
// sentence) list only the methods GET /portal/v1/auth/providers actually reports as configured, and
// never name an unconfigured one.
test("authCopy lists only configured recovery methods, joined in prose", async () => {
  const authCopy = await loadAuthCopyModule();
  assert.deepEqual(authCopy.configuredRecoveryMethods(null), []);
  assert.deepEqual(authCopy.configuredRecoveryMethods(undefined), []);
  assert.deepEqual(authCopy.configuredRecoveryMethods({ google: false, github: false, email: false }), []);
  assert.deepEqual(authCopy.configuredRecoveryMethods({ google: true, github: false, email: false }), ["Google"]);
  assert.deepEqual(authCopy.configuredRecoveryMethods({ google: true, github: true, email: false }), ["Google", "GitHub"]);
  assert.deepEqual(
    authCopy.configuredRecoveryMethods({ google: true, github: true, email: true }),
    ["Google", "GitHub", "an email code"],
  );
  assert.equal(authCopy.joinWithOr([]), "");
  assert.equal(authCopy.joinWithOr(["Google"]), "Google");
  assert.equal(authCopy.joinWithOr(["Google", "GitHub"]), "Google or GitHub");
  assert.equal(
    authCopy.joinWithOr(["Google", "GitHub", "an email code"]),
    "Google, GitHub, or an email code",
  );
});

// Connecting Google or GitHub with a session older than the server allows comes back to Account
// with auth_error=reauth_required and the provider in auth_provider. The sentence names that
// provider, and an unexpected value never reaches the page.
test("authCopy asks the customer to sign in again to connect the named provider", async () => {
  const authCopy = await loadAuthCopyModule();
  assert.equal(authCopy.reauthToConnectMessage("google"), "For your security, sign in again to connect Google.");
  assert.equal(authCopy.reauthToConnectMessage("github"), "For your security, sign in again to connect GitHub.");
  for (const other of [null, "", "gitlab", "__proto__", "<b>Google</b>"]) {
    assert.equal(authCopy.reauthToConnectMessage(other), "For your security, sign in again to connect Google or GitHub.", String(other));
  }
});
