import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadUiModules } from "../../../test/helpers/ui-modules.mjs";

async function loadPasswordMessages() {
  const [module] = await loadUiModules(fileURLToPath(new URL("../", import.meta.url)), ["ui/features/auth/passwordMessages.tsx"]);
  return module;
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
