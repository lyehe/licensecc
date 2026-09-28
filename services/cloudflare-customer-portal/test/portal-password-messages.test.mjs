// passwordMessages.tsx unit tests. It is deliberately NOT a pure module like portalWorkflow.ts (it
// renders <SupportContact/> and, for the recovery hint, reads useProviders()'s fetched context), so
// this test stubs those two component/hook dependencies rather than resolving their own real
// dependency chains (api.tsx, ProviderSignIn.tsx's data effect). Only string-valued MESSAGES entries
// and the shared rate-limit sentence are exercised here; the recovery hint's dynamic method list and
// <SupportContact/>'s own rendering are covered end-to-end by the e2e suite and by
// portal-support-contact.test.mjs respectively.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "@typescript/typescript6";

const SUPPORT_CONTACT_IMPORT = 'import { SupportContact } from "../../shared/SupportContact";';
const USE_PROVIDERS_IMPORT = 'import { useProviders } from "./ProviderSignIn";';
const WORKFLOW_IMPORT_FROM = 'from "../../portalWorkflow"';
const AUTH_COPY_IMPORT_FROM = 'from "./authCopy"';

// Transpile a pure (zero React/DOM) sibling module for real into `dir`, so passwordMessages.tsx's
// import of it exercises its actual logic rather than a stub.
function transpilePureModule(dir, sourceRelativePath, outputFilename) {
  const source = readFileSync(new URL(sourceRelativePath, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(dir, outputFilename), transpiled, "utf8");
}

async function loadPasswordMessages() {
  const dir = mkdtempSync(join(tmpdir(), "licensecc-portal-password-messages-"));
  try {
    // portalWorkflow.ts and authCopy.ts are the established pure seam (zero React/DOM deps) --
    // transpile both for real so rateLimitMessage/configuredRecoveryMethods/joinWithOr run their
    // actual logic, not a stub.
    transpilePureModule(dir, "../src/ui/portalWorkflow.ts", "portalWorkflow.mjs");
    transpilePureModule(dir, "../src/ui/features/auth/authCopy.ts", "authCopy.mjs");

    const fullSource = readFileSync(new URL("../src/ui/features/auth/passwordMessages.tsx", import.meta.url), "utf8");
    assert.ok(fullSource.includes(SUPPORT_CONTACT_IMPORT), "passwordMessages.tsx's SupportContact import changed -- update this test's stub");
    assert.ok(fullSource.includes(USE_PROVIDERS_IMPORT), "passwordMessages.tsx's useProviders import changed -- update this test's stub");
    assert.ok(fullSource.includes(WORKFLOW_IMPORT_FROM), "passwordMessages.tsx's portalWorkflow import changed -- update this test's rewrite");
    assert.ok(fullSource.includes(AUTH_COPY_IMPORT_FROM), "passwordMessages.tsx's authCopy import changed -- update this test's rewrite");
    const stubbed = fullSource
      .replace(SUPPORT_CONTACT_IMPORT, "const SupportContact = () => null;")
      .replace(USE_PROVIDERS_IMPORT, 'const useProviders = () => ({ providers: null, failed: false, retry: () => {} });')
      .replace(WORKFLOW_IMPORT_FROM, 'from "./portalWorkflow.mjs"')
      .replace(AUTH_COPY_IMPORT_FROM, 'from "./authCopy.mjs"');
    const transpiled = ts.transpileModule(stubbed, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText.replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, specifier) => `from "${import.meta.resolve(specifier)}"`);
    writeFileSync(join(dir, "passwordMessages.mjs"), transpiled, "utf8");
    return await import(pathToFileURL(join(dir, "passwordMessages.mjs")).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// api()'s own network_unavailable (a dropped connection) now reaches
// passwordMessage() from PasswordSettings, PasswordAction and PasswordSignIn alike, and must give
// the same customer-facing sentence StatusLine already shows everywhere else.
test("passwordMessage gives the network-unavailable copy verbatim", async () => {
  const { passwordMessage } = await loadPasswordMessages();
  assert.equal(
    passwordMessage("network_unavailable"),
    "Couldn't reach the portal. Check your connection and try again.",
  );
});

test("passwordMessage's rate-limit copy is the single shared sentence, with and without retryAfter", async () => {
  const { passwordMessage } = await loadPasswordMessages();
  assert.equal(passwordMessage("rate_limited"), "Too many attempts. Try again later.");
  assert.equal(passwordMessage("rate_limited", 120), "Too many attempts. Try again in 2 minutes.");
  assert.doesNotMatch(passwordMessage("rate_limited"), /wait a moment/i, "the old passwordMessages wording must be gone");
});

test("passwordActionMessage forwards retryAfter through to the shared rate-limit sentence", async () => {
  const { passwordActionMessage } = await loadPasswordMessages();
  assert.equal(passwordActionMessage("rate_limited", 30), "Too many attempts. Try again in 1 minutes.");
  assert.equal(passwordActionMessage("rate_limited"), "Too many attempts. Try again later.");
  // Unaffected sibling behavior: the password-action page's own invalid_registration override.
  assert.equal(passwordActionMessage("invalid_registration"), "Choose a password of 15–128 characters.");
});

test("passwordMessage still gives the unmapped-code fallback and other unaffected codes verbatim", async () => {
  const { passwordMessage } = await loadPasswordMessages();
  assert.equal(passwordMessage("some_unknown_code"), "Unable to complete the request. Please try again.");
  assert.equal(passwordMessage("invalid_credentials"), "Email or password is incorrect.");
});
