import { expect, test } from "@playwright/test";
import { contrastRatio, parseRgb } from "./e2e-contrast.mjs";
import "./portal-ui.consent.e2e.mjs";
import "./portal-ui.nodes.e2e.mjs";
import "./portal-ui.network-failures.e2e.mjs";
import "./portal-ui.session-expired.e2e.mjs";
import "./portal-ui.license-lifecycle.e2e.mjs";
import "./portal-ui.devices-search.e2e.mjs";
import "./portal-ui.devices-results.e2e.mjs";

function makeEnvelope(code, data) {
  makeEnvelope.nextRequestId += 1;
  return {
    ok: true,
    code,
    request_id: `portal-e2e-${makeEnvelope.nextRequestId}`,
    data,
  };
}
makeEnvelope.nextRequestId = 0;

test("registration verifies email before choosing a password and opens an empty account", async ({ page }) => {
  let authed = false;
  const submissions = [];
  await page.route("**/portal/v1/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/providers")) return route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: true }) });
    if (path.endsWith("/password/register")) { submissions.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: makeEnvelope("verification_requested") }); }
    if (path.endsWith("/password/complete")) { submissions.push(route.request().postDataJSON()); authed = true; return route.fulfill({ json: makeEnvelope("signed_in", { customer_id: "new-customer" }) }); }
    throw new Error(`Unexpected auth route ${path}`);
  });
  await page.route("**/api/portal/**", (route) => {
    if (!authed) return route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } });
    return route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "new-customer" } : { items: [] }) });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Send code" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("new@example.com");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Send verification link", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Check your email");
  // This is a confirmation, not an error -- it must NOT use the error colour, unlike
  // the two failures below.
  await expect(page.getByRole("alert")).toHaveCSS("color", "rgb(155, 196, 155)");
  expect(submissions).toEqual([{ email: "new@example.com" }]);
  const token = "a".repeat(43);
  await page.goto(`/password-action#token=${token}`);
  await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  expect(page.url()).not.toContain(token);
  expect(submissions).toHaveLength(1);
  await page.getByLabel("New password", { exact: true }).fill("A long testing passphrase 1!");
  await page.getByLabel("Confirm password", { exact: true }).fill("A different testing passphrase");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
  // An actual auth error uses the same error colour `.statusline.error` uses.
  await expect(page.getByRole("alert")).toHaveCSS("color", "rgb(219, 146, 146)");
  expect(submissions).toHaveLength(1);
  await page.getByLabel("Confirm password", { exact: true }).fill("A long testing passphrase 1!");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  expect(submissions[1]).toEqual({ token, password: "A long testing passphrase 1!" });
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("password login errors clear the secret and explain recovery", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: true, password: true }) }));
  await page.route("**/portal/v1/auth/password/login", (route) => route.fulfill({ status: 401, json: { ok: false, code: "invalid_credentials" } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeHidden();
  if (!await page.locator(".otherSignIn").evaluate(element => element.open)) await page.getByText("Other sign-in options", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("new@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A wrong testing passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  // Reuses the existing error colour token rather than a new literal.
  await expect(page.getByRole("alert")).toHaveCSS("color", "rgb(219, 146, 146)");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.getByText("Forgot your password?", { exact: true }).click();
  // Reworded to drop "verified" -- an admin-invited account with an
  // unverified login email also recovers, and verifies, through this same reset.
  await expect(page.getByText(/We'll email a reset link to your login address/)).toBeVisible();
  await page.route("**/portal/v1/auth/password/reset", route => {
    expect(route.request().postDataJSON()).toEqual({ email: "new@example.com" });
    return route.fulfill({ status: 202, json: makeEnvelope("verification_requested") });
  });
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your email");
  // A confirmation, not an error -- unaffected by the error-colour fix above.
  await expect(page.getByRole("alert")).toHaveCSS("color", "rgb(155, 196, 155)");
});

test("a suspended account's correct password is told so, with the configured support contact", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true, support: "mailto:help@example.com" }) }));
  await page.route("**/portal/v1/auth/password/login", (route) => route.fulfill({ status: 403, json: { ok: false, code: "account_suspended", request_id: "portal-e2e-suspended" } }));
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("suspended@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A correct testing passphrase 1!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("This account is suspended. Contact support.");
  await expect(alert.getByRole("link", { name: "Contact support", exact: true })).toHaveAttribute("href", "mailto:help@example.com");
  await expect(page.getByText("account_suspended")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});

test("expired password link shows recovery guidance and reloading cannot retain the secret", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", route => route.fulfill({ json: makeEnvelope("auth_providers", { password: true }) }));
  let attempts = 0;
  await page.route("**/portal/v1/auth/password/complete", route => {
    attempts += 1;
    return route.fulfill({ status: 400, json: { ok: false, code: "invalid_link" } });
  });
  const token = "b".repeat(43);
  await page.goto(`/password-action#token=${token}`);
  await expect(page).toHaveTitle("Set a password · Licensecc");
  await expect(page.getByRole("heading", { name: "Choose your password" })).toBeFocused();
  await page.getByLabel("New password", { exact: true }).fill("A replacement passphrase 2!");
  await page.getByLabel("Confirm password", { exact: true }).fill("A replacement passphrase 2!");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("expired or was already used");
  // A server-reported failure (not the local validation error above) also gets the
  // error colour.
  await expect(page.getByRole("alert")).toHaveCSS("color", "rgb(219, 146, 146)");
  await expect(page.getByRole("alert").getByRole("link", { name: "Request a new link" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
  expect(page.url()).not.toContain(token);
  expect(await page.evaluate(value => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(v => v.includes(value)), token)).toBe(false);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Open the link from your email again");
  await expect(page.getByRole("button", { name: "Save password and sign in" })).toHaveCount(0);
  expect(attempts).toBe(1);
});

// "Request a new link" (invalid_link) is an actual affordance, not inert text -- it returns to
// sign-in with the reset form already open, reusing PasswordSignIn's own `mode`.
test("Request a new link returns to sign-in with the reset form already open", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", route => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: true }) }));
  await page.route("**/portal/v1/auth/password/complete", route => route.fulfill({ status: 400, json: { ok: false, code: "invalid_link" } }));
  const token = "c".repeat(43);
  await page.goto(`/password-action#token=${token}`);
  await page.getByLabel("New password", { exact: true }).fill("A replacement passphrase 3!");
  await page.getByLabel("Confirm password", { exact: true }).fill("A replacement passphrase 3!");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  const requestNewLink = page.getByRole("link", { name: "Request a new link" });
  await expect(requestNewLink).toBeVisible();
  await requestNewLink.click();
  await expect(page.getByRole("heading", { name: "Reset password", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  expect(page.url()).not.toContain(token);
});

test("password sign-in hides email-only actions when email delivery is off", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", route => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, password: true, email: false }) }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create an account", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Forgot your password?" })).toHaveCount(0);
  // Password-only mode (password configured, no email delivery: no reset email can ever be sent) --
  // the forgot-password entry becomes a support-contact sentence instead of silently disappearing.
  // No `support` field in this fixture, so it names the administrator fallback.
  await expect(page.getByText("Contact your administrator to reset your password.", { exact: true })).toBeVisible();
});

// The same password-only mode, but with a configured support contact -- the sentence must link
// it exactly as <SupportContact/> does everywhere else, never a bare mailto/URL string.
test("password-only mode with a configured support contact links it in the reset-password hint", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", route => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, password: true, email: false, support: "mailto:help@example.com" }) }));
  await page.goto("/");
  const hint = page.getByText("Contact support to reset your password.", { exact: true });
  await expect(hint).toBeVisible();
  await expect(hint.getByRole("link", { name: "Contact support", exact: true })).toHaveAttribute("href", "mailto:help@example.com");
});

test("password completion enforces the server length and explains a sign-in-required success", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/password/complete", route => route.fulfill({ json: makeEnvelope("password_updated", { sign_in_required: true }) }));
  await page.goto("/password-action#token=" + "A".repeat(43));
  await expect(page.getByLabel("New password")).toHaveAttribute("maxlength", "128");
  await page.getByLabel("New password").fill("A long testing passphrase 1!");
  await page.getByLabel("Confirm password").fill("A long testing passphrase 1!");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Password saved. Sign in with your new password.");
});

test("Account password change requires the current password and confirms session rotation", async ({ page }) => {
  let submitted;
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => {
    if (route.request().method() === "POST") { submitted = route.request().postDataJSON(); return route.fulfill({ json: makeEnvelope("signed_in") }); }
    return route.fulfill({ json: makeEnvelope("password_settings", { has_password: true, can_reset: false, email_verified: false, email: "new@example.com" }) });
  });
  await page.goto("/#/account");
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toHaveCount(0);
  await expect(page.getByLabel("Current password", { exact: true })).toBeHidden();
  await page.locator("summary").filter({ hasText: /^Change password$/ }).click();
  await page.getByLabel("Current password", { exact: true }).fill("A long testing passphrase 1!");
  await page.getByLabel("New password", { exact: true }).fill("A replacement passphrase 2!");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  const savedMessage = page.getByText("Password saved. Other browser sessions have been signed out.");
  await expect(savedMessage).toBeVisible();
  // This result shares one role="status" slot with a failed change below -- a
  // confirmation must not use the error colour.
  await expect(savedMessage).toHaveCSS("color", "rgb(155, 196, 155)");
  expect(submitted).toEqual({ current_password: "A long testing passphrase 1!", password: "A replacement passphrase 2!" });
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
});

// The same result slot must use the error colour for an actual failure.
test("Account password change failure uses the error colour, not the confirmation's", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 409, json: { ok: false, code: "password_change_conflict", request_id: "portal-e2e-conflict" } });
    return route.fulfill({ json: makeEnvelope("password_settings", { has_password: true, can_reset: false, email_verified: false, email: "new@example.com" }) });
  });
  await page.goto("/#/account");
  await page.locator("summary").filter({ hasText: /^Change password$/ }).click();
  await page.getByLabel("Current password", { exact: true }).fill("A wrong testing passphrase");
  await page.getByLabel("New password", { exact: true }).fill("A replacement passphrase 2!");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  const failureMessage = page.getByText("Your sign-in settings changed. Reload and try again.");
  await expect(failureMessage).toBeVisible();
  await expect(failureMessage).toHaveCSS("color", "rgb(219, 146, 146)");
});

// `recovery_available` (routes/password.ts) shares the reset query's own eligibility predicate,
// so this copy must never promise a recovery the server would refuse.
test("password settings point an eligible unverified email at Forgot your password", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: true }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => route.fulfill({ json: makeEnvelope("password_settings", { has_password: true, can_reset: false, email_verified: false, recovery_available: true, email: "invited@example.com" }) }));
  await page.goto("/#/account");
  await expect(page.getByText("Use 'Forgot your password?' once to verify this email.", { exact: true })).toBeVisible();
  await expect(page.getByText("Email not verified. Password recovery by email is unavailable.", { exact: true })).toHaveCount(0);
});

test("password settings fall back to the unavailable notice when no address is eligible to recover", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: true }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => route.fulfill({ json: makeEnvelope("password_settings", { has_password: true, can_reset: false, email_verified: false, recovery_available: false, email: "claimed@example.com" }) }));
  await page.goto("/#/account");
  await expect(page.getByText("Email not verified. Password recovery by email is unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText("Use 'Forgot your password?' once to verify this email.", { exact: true })).toHaveCount(0);
});

test("password settings hide the recovery promise when the portal has no email delivery configured", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => route.fulfill({ json: makeEnvelope("password_settings", { has_password: true, can_reset: false, email_verified: false, recovery_available: true, email: "invited@example.com" }) }));
  await page.goto("/#/account");
  await expect(page.getByText("Email not verified. Password recovery by email is unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText("Use 'Forgot your password?' once to verify this email.", { exact: true })).toHaveCount(0);
});

// No existing PasswordSettings fixture ever set has_password:false, so
// RecoveryHint's actual list-only-configured-methods rendering (as opposed to the pure
// configuredRecoveryMethods/joinWithOr helpers it calls) was never exercised end to end. These five
// cover every configuration RecoveryHint can render, each with a distinct providers response so the
// exact sentence pins to that exact configuration.
async function goToPasswordSettingsNeedingSetup(page, providers) {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { password: true, ...providers }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => route.fulfill({ json: makeEnvelope("password_settings", { has_password: false, can_reset: false, email_verified: false, email: "" }) }));
  await page.goto("/#/account");
}

test("password settings' recovery hint names only Google when only Google is configured", async ({ page }) => {
  await goToPasswordSettingsNeedingSetup(page, { google: true, github: false, email: false });
  await expect(page.getByText("Sign in again with Google to set a password.", { exact: true })).toBeVisible();
});

test("password settings' recovery hint names both Google and email codes when both are configured", async ({ page }) => {
  await goToPasswordSettingsNeedingSetup(page, { google: true, github: false, email: true });
  await expect(page.getByText("Sign in again with Google or an email code to set a password.", { exact: true })).toBeVisible();
});

test("password settings' recovery hint names only GitHub when only GitHub is configured", async ({ page }) => {
  await goToPasswordSettingsNeedingSetup(page, { google: false, github: true, email: false });
  await expect(page.getByText("Sign in again with GitHub to set a password.", { exact: true })).toBeVisible();
});

test("password settings' recovery hint falls back to the administrator when no method is configured", async ({ page }) => {
  await goToPasswordSettingsNeedingSetup(page, { google: false, github: false, email: false });
  await expect(page.getByText("Contact your administrator to set a password.", { exact: true })).toBeVisible();
  await expect(page.getByText("Sign in again with", { exact: false })).toHaveCount(0);
});

test("password settings' recovery hint falls back to the configured support contact when no method is configured", async ({ page }) => {
  await goToPasswordSettingsNeedingSetup(page, { google: false, github: false, email: false, support: "mailto:help@example.com" });
  const hint = page.getByText("Contact support to set a password.", { exact: true });
  await expect(hint).toBeVisible();
  await expect(hint.getByRole("link", { name: "Contact support", exact: true })).toHaveAttribute("href", "mailto:help@example.com");
});

test("social sign-in buttons submit to their own start routes and hide unavailable email", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.goto("/?auth_error=sign_in_cancelled");
  await expect(page.getByText("Sign-in was cancelled. You can try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send code", exact: true })).toHaveCount(0);
  for (const [provider, label] of [["google", "Google"], ["github", "GitHub"]]) {
    await expect(page.getByRole("button", { name: `Continue with ${label}` })).toBeVisible();
    await expect(page.locator(`form[action="/portal/v1/auth/${provider}/start"]`)).toHaveAttribute("method", "post");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const navigation = page.waitForRequest((request) => request.url().endsWith("/portal/v1/auth/github/start") && request.method() === "POST");
  await page.route("**/portal/v1/auth/github/start", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Provider redirect boundary</h1>" }));
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await navigation;
  await expect(page.getByRole("heading", { name: "Provider redirect boundary" })).toBeVisible();
});

test("link_expired shows the exact expired-link sentence, never the raw code", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }) }));
  await page.goto("/?auth_error=link_expired");
  await expect(page.getByText("This sign-in link has expired or was already used. Request a new code.")).toBeVisible();
  await expect(page.getByText("link_expired", { exact: false })).toHaveCount(0);
  expect(page.url()).not.toContain("auth_error");
});

// ProviderResult's ERRORS lookup already guards with Object.hasOwn, but no
// test ever exercised a prototype-polluting `auth_error` value. `__proto__`/`constructor` name
// Object.prototype members, so an unsafe `ERRORS[error]` lookup would resolve to that inherited
// function/value instead of falling back -- React would then throw or silently render a function.
for (const maliciousCode of ["__proto__", "constructor"]) {
  test(`auth_error=${maliciousCode} falls back to the generic sign-in-failed sentence, never the raw code or a page error`, async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
    await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }) }));
    await page.goto(`/?auth_error=${maliciousCode}`);
    await expect(page.getByText("Unable to complete sign-in. Please try again.")).toBeVisible();
    await expect(page.getByText(maliciousCode, { exact: false })).toHaveCount(0);
    expect(page.url()).not.toContain("auth_error");
    expect(pageErrors).toEqual([]);
  });
}

test("OAuth sign-in to a suspended account explains it and names the administrator when no contact is set", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  // No support field at all, as from a Worker without PORTAL_SUPPORT_CONTACT: that means no contact.
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.goto("/?auth_error=account_suspended");
  const suspendedMessage = page.getByText("This account is suspended. Contact your administrator.", { exact: true });
  await expect(suspendedMessage).toBeVisible();
  // ProviderResult shares one role="status" slot with the "Sign-in provider connected."
  // confirmation below -- an actual auth failure must get the error colour.
  await expect(suspendedMessage).toHaveCSS("color", "rgb(219, 146, 146)");
  await expect(page.getByRole("link", { name: "Contact support" })).toHaveCount(0);
  await expect(page.getByText("account_suspended")).toHaveCount(0);
  expect(page.url()).not.toContain("auth_error");
});

// The SAME ProviderResult component (ProviderSignIn.tsx) renders the "Sign-in provider
// connected." confirmation after linking a provider under Account -- it must NOT get the error colour
// the failure above does.
test("a linked-provider confirmation under Account is not coloured like an error", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [{ provider: "google", email: "customer@example.com" }] }) }));
  await page.goto("/?auth_result=linked#/account");
  const linkedMessage = page.getByText("Sign-in provider connected.", { exact: true });
  await expect(linkedMessage).toBeVisible();
  await expect(linkedMessage).toHaveCSS("color", "rgb(155, 196, 155)");
  expect(page.url()).not.toContain("auth_result");
});

test("an existing-email conflict and an unconfigured portal link the configured support contact", async ({ page }) => {
  let providers = { google: true, github: true, email: false, support: "https://support.example.com/help" };
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", providers) }));
  await page.goto("/?auth_error=account_link_required");
  const conflict = page.getByRole("status").filter({ hasText: "An account already uses this email." });
  await expect(conflict).toHaveText("An account already uses this email. Sign in with the method you already use for it, then connect Google or GitHub under Account. Contact support if you can't sign in.");
  await expect(conflict.getByRole("link", { name: "Contact support", exact: true })).toHaveAttribute("href", "https://support.example.com/help");
  providers = { google: false, github: false, email: false, password: false, support: "https://support.example.com/help" };
  await page.goto("/");
  const unconfigured = page.getByText("Sign-in is not configured yet. Contact support.", { exact: true });
  await expect(unconfigured).toBeVisible();
  await expect(unconfigured.getByRole("link", { name: "Contact support", exact: true })).toHaveAttribute("href", "https://support.example.com/help");
});

test("a signed-in user who opens an already-used magic link lands on Apps without a stale message", async ({ page }) => {
  const api = makePortalApiFixture();
  await signIn(page, api);
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  // Simulate following the emailed magic link a second time while already signed in: the
  // interstitial's form POST redirects the top-level navigation to /?auth_error=link_expired.
  await page.goto("/?auth_error=link_expired");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.getByText("This sign-in link has expired or was already used. Request a new code.")).toHaveCount(0);
  expect(page.url()).not.toContain("auth_error");
  // The stale code must not resurface later, out of context, when Account happens to mount.
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.getByText("This sign-in link has expired or was already used. Request a new code.")).toHaveCount(0);
});

test("unconfigured providers show a clear unavailable state", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false }) }));
  await page.goto("/");
  await expect(page.getByText("Sign-in is not configured yet. Contact your administrator.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with|Send code/ })).toHaveCount(0);
});

// Providers failing once must recover through Retry sign-in
// options, landing back on a usable sign-in form -- not a stuck "Unable to load" state.
test("providers failing once then succeeding recovers through Retry sign-in options", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  let attempt = 0;
  await page.route("**/portal/v1/auth/providers", (route) => {
    attempt += 1;
    if (attempt === 1) return route.fulfill({ status: 500, json: { ok: false, code: "portal_error", request_id: "providers-e2e" } });
    return route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }) });
  });
  await page.goto("/");
  await expect(page.getByText("Unable to load sign-in options.")).toBeVisible();
  await page.getByRole("button", { name: "Retry sign-in options" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect(page.getByText("Unable to load sign-in options.")).toHaveCount(0);
  expect(attempt).toBeGreaterThanOrEqual(2);
});

// Focus moves to the new h1 on every auth step and password-mode switch, using tabIndex={-1}.
test("focus moves to the new heading on every sign-in step and mode switch", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: true }) }));
  await page.route("**/portal/v1/auth/request", (route) => route.fulfill({ json: makeEnvelope("otp_requested") }));
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Sign in");
  await expect(heading).toBeFocused();

  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(heading).toHaveText("Create account");
  await expect(heading).toBeFocused();

  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await expect(heading).toHaveText("Sign in");
  await expect(heading).toBeFocused();

  if (!await page.locator(".otherSignIn").evaluate((element) => element.open)) await page.getByText("Other sign-in options", { exact: true }).click();
  await page.getByText("Use an email code instead", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(heading).toHaveText("Check your email");
  await expect(heading).toBeFocused();
});

// One sentence, driven by the server's real retry-after header, for the OTP request path.
test("a mocked 429 with retry-after shows the shared rate-limit sentence with minutes (OTP request)", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }) }));
  await page.route("**/portal/v1/auth/request", (route) => route.fulfill({ status: 429, headers: { "retry-after": "120" }, json: { ok: false, code: "rate_limited", request_id: "rl-e2e" } }));
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("Too many attempts. Try again in 2 minutes.", { exact: true })).toBeVisible();
  // StatusLine still tucks the raw code under a collapsed "Technical details" disclosure -- it
  // is present in the DOM but not visible, so this checks visibility, not (non-)existence.
  await expect(page.getByText("rate_limited", { exact: false })).not.toBeVisible();
});

// Same sentence, same header, on a password screen -- proving the UI copy is genuinely shared
// rather than duplicated per auth surface.
test("a mocked password-login 429 with retry-after shows the shared rate-limit sentence", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/password/login", (route) => route.fulfill({ status: 429, headers: { "retry-after": "45" }, json: { ok: false, code: "rate_limited", request_id: "rl-e2e-2" } }));
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A testing passphrase 1!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Too many attempts. Try again in 1 minutes.");
});

// When no header reaches the client at all (a top-level redirect from an OAuth/magic-link rate
// limit), the sentence falls back to the same "later" wording, never the old bespoke copy.
test("auth_error=rate_limited (redirect path, no header) shows the later-form sentence", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: false, email: false }) }));
  await page.goto("/?auth_error=rate_limited");
  await expect(page.getByText("Too many attempts. Try again later.", { exact: true })).toBeVisible();
  await expect(page.getByText("Too many sign-in attempts", { exact: false })).toHaveCount(0);
  expect(page.url()).not.toContain("auth_error");
});

// The resend button's client-side-only 60s cooldown counts down and re-enables at zero.
test("the resend cooldown counts down and re-enables at zero", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }) }));
  await page.route("**/portal/v1/auth/request", (route) => route.fulfill({ json: { ok: true, code: "otp_requested", request_id: "resend-e2e" } }));
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("button", { name: "Resend code (0:59)", exact: true })).toBeDisabled();
  await page.clock.runFor("00:30");
  await expect(page.getByRole("button", { name: "Resend code (0:29)", exact: true })).toBeDisabled();
  await page.clock.runFor("00:29");
  await expect(page.getByRole("button", { name: "Resend code", exact: true })).toBeEnabled();
});

test("the resend countdown stops its timer once it reaches zero", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }) }));
  await page.route("**/portal/v1/auth/request", (route) => route.fulfill({ json: { ok: true, code: "otp_requested", request_id: "resend-stop-e2e" } }));
  await page.goto("/");
  // Count the countdown timer's ticks: it is the page's only 250 ms interval. Installed after the
  // fake clock, so it wraps the clock's own setInterval.
  await page.evaluate(() => {
    const original = window.setInterval;
    window.__countdownTicks = 0;
    window.setInterval = (callback, delay, ...rest) => original((...args) => {
      if (delay === 250) window.__countdownTicks += 1;
      return callback(...args);
    }, delay, ...rest);
  });
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("button", { name: "Resend code (0:59)", exact: true })).toBeDisabled();
  await page.clock.runFor("00:30");
  expect(await page.evaluate(() => window.__countdownTicks)).toBeGreaterThan(0);
  await page.clock.runFor("00:30");
  await expect(page.getByRole("button", { name: "Resend code", exact: true })).toBeEnabled();
  const ticksAtZero = await page.evaluate(() => window.__countdownTicks);
  await page.clock.runFor("00:10");
  expect(await page.evaluate(() => window.__countdownTicks)).toBe(ticksAtZero);
});

test("Account shows connected methods and keeps linking failures visible", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [{ provider: "google", email: "customer@example.com" }] }) }));
  await page.goto("/?auth_error=link_failed#/account");
  await expect(page.getByText("Unable to connect this provider. Sign in again and retry from Account.")).toBeVisible();
  await expect(page.getByText("Google · customer@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toBeVisible();
  await expect(page.locator('form[action="/portal/v1/auth/github/start?mode=link"]')).toHaveAttribute("method", "post");
});

async function routeAccountIdentities(page, identities, unlink) {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: identities() }) }));
  await page.route("**/portal/v1/auth/identities/unlink", (route) => {
    expect(route.request().method()).toBe("POST");
    return unlink(route, route.request().postDataJSON());
  });
}

test("Account disconnects a provider only after an inline confirm, then offers to connect it again", async ({ page }) => {
  let identities = [{ provider: "google", email: "customer@example.com" }, { provider: "github", email: "octo@example.com" }];
  const unlinks = [];
  await routeAccountIdentities(page, () => identities, (route, body) => {
    unlinks.push(body);
    identities = identities.filter((identity) => identity.provider !== body.provider);
    return route.fulfill({ json: makeEnvelope("identity_unlinked", { provider: body.provider }) });
  });
  await page.goto("/#/account");
  await expect(page.getByText("GitHub · octo@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toHaveCount(0);
  // One live region is mounted, empty, before any result, so a screen reader announces its change.
  const notice = page.locator(".accountNotice");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toHaveText("");
  await page.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Disconnect GitHub? You won't be able to sign in with GitHub until you connect it again." });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  // The first click only asks; nothing is sent until the customer confirms.
  expect(unlinks).toEqual([]);
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect GitHub", exact: true })).toBeFocused();
  expect(unlinks).toEqual([]);
  await page.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
  await confirm.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
  await expect(notice).toHaveText("GitHub disconnected.");
  expect(unlinks).toEqual([{ provider: "github" }]);
  await expect(page.getByText("GitHub · octo@example.com")).toHaveCount(0);
  await expect(page.getByText("Google · customer@example.com")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toBeVisible();
  await expect(page.locator('form[action="/portal/v1/auth/github/start?mode=link"]')).toHaveAttribute("method", "post");
  await expect(page.getByRole("button", { name: "Connect Google", exact: true })).toHaveCount(0);
});

test("Account explains that the last sign-in method cannot be disconnected, without a raw code", async ({ page }) => {
  const identities = [{ provider: "google", email: "customer@example.com" }];
  const responses = [
    { status: 503, json: { ok: false, code: "config_error", request_id: "portal-e2e-unlink-503" } },
    { status: 409, json: { ok: false, code: "last_sign_in_method", request_id: "portal-e2e-unlink-409" } },
  ];
  await routeAccountIdentities(page, () => identities, (route) => route.fulfill(responses.shift()));
  await page.goto("/#/account");
  // The failure text lands in the live region that was already mounted, while focus goes back to
  // Disconnect, so it is announced rather than only shown.
  const notice = page.locator(".accountNotice");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toHaveText("");
  const disconnect = async () => {
    await page.getByRole("button", { name: "Disconnect Google", exact: true }).click();
    await page.getByRole("group", { name: /^Disconnect Google\?/ }).getByRole("button", { name: "Disconnect Google", exact: true }).click();
  };
  await disconnect();
  await expect(notice).toHaveText("Unable to disconnect Google. Please try again.");
  await expect(page.getByRole("button", { name: "Disconnect Google", exact: true })).toBeFocused();
  await disconnect();
  await expect(notice).toHaveText("You can't disconnect your only sign-in method. Set up another way to sign in first.");
  await expect(page.getByText("Unable to disconnect Google. Please try again.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Google · customer@example.com")).toBeVisible();
  for (const raw of ["last_sign_in_method", "config_error", "portal-e2e-unlink"]) await expect(page.getByText(raw)).toHaveCount(0);
  expect(responses).toEqual([]);
});

// In-memory portal backend. The fixture mints NO real session: a successful verify simply flips an
// `authed` flag (the SPA gates on me() succeeding, exactly as it would behind the HttpOnly cookie).
// Crucially the fixtures NEVER return a bearer/token/private-key/another-customer's id — the leak
// guard asserts the rendered page never surfaces such material.
function makePortalApiFixture() {
  const VALID_CODE = "80315426";
  let authed = false;
  const controls = { rejectUsage: false, failMe: false, failNextRelease: false, failNextDeviceRelease: false, deferNextRelease: false, rejectNextRelease: false, rejectRefreshes: 0, resolveRelease: null, email: null };
  const requests = { authRequests: 0, verifies: 0, checkouts: 0, heartbeats: 0, releases: 0, deviceReleases: 0, refreshRejects: 0, downloads: 0, logouts: 0, seatActions: [] };

  const entitlements = [
    { id: "ent_floating", project: "DEFAULT", feature: "pro", status: "active", license_fingerprint: "a".repeat(64), valid_from: 1_710_000_000, valid_until: null, license_mode: "floating", pool_size: 5, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_float" },
    { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: 2_100_000_000, license_mode: "node_locked", pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_node" },
  ];
  const devices = [
    { project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64), device_key_id: "d".repeat(40), created_at: 1_710_000_500 },
  ];
  const usage = [
    { project: "DEFAULT", feature: "pro", event_type: "checkout", count: 12 },
    { project: "DEFAULT", feature: "pro", event_type: "heartbeat", count: 87 },
  ];

  async function jsonBody(request) {
    const text = request.postData() ?? "{}";
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function route(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const fulfill = (status, body, contentType = "application/json") => route.fulfill({
      status,
      contentType,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

    // ---- Auth ----
    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: true, github: true, email: true }));
    if (path === "/portal/v1/auth/identities") return fulfill(200, makeEnvelope("identities", { items: [] }));
    if (method === "POST" && path === "/portal/v1/auth/request") {
      requests.authRequests += 1;
      return fulfill(200, makeEnvelope("otp_requested"));
    }
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      requests.verifies += 1;
      const body = await jsonBody(request);
      if (body.code === VALID_CODE) {
        authed = true;
        return fulfill(200, makeEnvelope("signed_in", { customer_id: "cus_self" }));
      }
      return fulfill(401, { ok: false, code: "invalid_otp", request_id: "portal-e2e-bad" });
    }
    if (method === "POST" && path === "/portal/v1/auth/logout") {
      requests.logouts += 1;
      authed = false;
      return fulfill(200, makeEnvelope("logged_out"));
    }

    // ---- Session-scoped reads ----
    if (method === "GET" && path === "/api/portal/me") {
      if (controls.failMe) return fulfill(503, { ok: false, code: "unavailable", request_id: "session-check" });
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("me", { customer_id: "cus_self", email: controls.email }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (controls.rejectRefreshes > 0) {
        controls.rejectRefreshes -= 1;
        requests.refreshRejects += 1;
        return route.abort("failed");
      }
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("entitlements", { items: entitlements.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (controls.rejectRefreshes > 0) {
        controls.rejectRefreshes -= 1;
        requests.refreshRejects += 1;
        return route.abort("failed");
      }
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("devices", { items: devices.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (controls.rejectUsage) return route.abort("failed");
      if (controls.rejectRefreshes > 0) {
        controls.rejectRefreshes -= 1;
        requests.refreshRejects += 1;
        return route.abort("failed");
      }
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("usage", { items: usage.map((item) => ({ ...item })) }));
    }

    if (method === "POST" && path === "/api/portal/devices/release") {
      requests.deviceReleases += 1;
      if (controls.failNextDeviceRelease) {
        controls.failNextDeviceRelease = false;
        return fulfill(503, { ok: false, code: "temporarily_unavailable", request_id: "portal-e2e-device-release-failure" });
      }
      const body = await jsonBody(request);
      const index = devices.findIndex((item) => item.device_key_id === body.device_key_id);
      if (index >= 0) devices.splice(index, 1);
      return fulfill(200, makeEnvelope("device_released"));
    }

    // ---- Per-seat actions: body MUST target an entitlement id, never a raw fingerprint. ----
    if (method === "POST" && (path === "/api/portal/checkout" || path === "/api/portal/heartbeat" || path === "/api/portal/release")) {
      const body = await jsonBody(request);
      // Assert the client never supplies the fingerprint (invariant 4: server-resolved).
      if ("license_fingerprint" in body || body.entitlement_id !== "ent_floating" || typeof body.client_instance_id !== "string" || typeof body.nonce !== "string") {
        return fulfill(400, { ok: false, code: "fingerprint_must_not_be_client_supplied", request_id: "portal-e2e-leak" });
      }
      const op = path.split("/").pop();
      if ((op === "heartbeat" || op === "release") && body.seat_id !== "seat-e2e") {
        return fulfill(400, { ok: false, code: "seat_id_required", request_id: "portal-e2e-seat" });
      }
      requests[`${op}s`] += 1;
      requests.seatActions.push({ op, body });
      if (op === "release" && controls.deferNextRelease) {
        controls.deferNextRelease = false;
        await new Promise((resolve) => { controls.resolveRelease = resolve; });
        controls.resolveRelease = null;
      }
      if (op === "release" && controls.rejectNextRelease) {
        controls.rejectNextRelease = false;
        return route.abort("failed");
      }
      if (op === "release" && controls.failNextRelease) {
        controls.failNextRelease = false;
        return fulfill(503, { ok: false, code: "verification_error", request_id: "portal-e2e-release-failure" });
      }
      return fulfill(200, makeEnvelope(`${op}_ok`, { seat_id: "seat-e2e", mode: "live" }));
    }

    // ---- Download: stream a signed-looking attachment (NOT a private key) ----
    if (method === "POST" && path === "/api/portal/download") {
      requests.downloads += 1;
      const body = await jsonBody(request);
      if ("license_fingerprint" in body || body.entitlement_id !== "ent_node" || typeof body.device_key_id !== "string" || body.device_key_id === "") {
        return fulfill(400, { ok: false, code: "fingerprint_must_not_be_client_supplied", request_id: "portal-e2e-leak" });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-disposition": "attachment; filename=\"DEFAULT-solo.lic\"" },
        body: "[license]\nsigned-license-bytes-not-a-key\n",
      });
    }

    return fulfill(404, { ok: false, code: "not_found", request_id: "portal-e2e-unhandled" });
  }

  return { route, requests, VALID_CODE, controls, entitlements, devices };
}

test("customer portal signs in with an 8-digit code and walks every screen without leaking secrets", async ({ page }) => {
  const api = makePortalApiFixture();
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  // The resend button's 60s client-side cooldown would otherwise make the click below wait a
  // real minute; fast-forward past it, then resume so the rest of this long walkthrough runs on real
  // time exactly as before.
  await page.clock.install();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Sign in · Licensecc");

  // --- Login: email -> request code ---
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  // The verify screen's own heading, not a loose text match: otp_requested's StatusLine copy ("Check
  // your email for a sign-in code.") now also legitimately contains "Check your email", so a bare
  // /Check your email/ regex matches both and is a strict-mode violation.
  const checkYourEmailHeading = page.getByRole("heading", { name: "Check your email" });
  await expect(checkYourEmailHeading).toBeVisible();
  await expect(checkYourEmailHeading).toBeFocused();
  await expect(page).toHaveTitle("Check your email · Licensecc");
  await expect.poll(() => api.requests.authRequests).toBe(1);

  // Resending shares the request path but must retain the verification form and input. It is
  // disabled with a countdown for 60s after a code is sent (client-side only).
  await page.getByLabel("8-digit code").fill("1234");
  await expect(page.getByRole("button", { name: "Resend code (0:59)", exact: true })).toBeDisabled();
  await page.clock.fastForward("01:00");
  await page.clock.resume();
  await page.getByRole("button", { name: "Resend code", exact: true }).click();
  await expect.poll(() => api.requests.authRequests).toBe(2);
  await expect(page.getByLabel("8-digit code")).toHaveValue("1234");
  await expect(page.getByRole("button", { name: "Send code", exact: true })).toHaveCount(0);

  // --- Login: enter the 8-digit code -> me() -> dashboard ---
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("link", { name: "Apps", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Apps · Licensecc");
  await expect.poll(() => api.requests.verifies).toBe(1);

  // --- Per-app access (read-only) ---
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await expect(page.locator(".tablePane tbody tr").filter({hasText:"pro"}).first()).toBeVisible();
  await expect(page.locator(".status.active").first()).toHaveText("Active");
  await expect(page.getByText("aaaaaaaa...aaaaaaaa").first()).toBeVisible();

  // --- My devices/seats: floating seat checkout/heartbeat/release ---
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page).toHaveTitle("Devices · Licensecc");
  await page.getByText("Browser seats", {exact:true}).click();
  const seatCard = page.locator(".seatCard").filter({ hasText: "pro" }).first();
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Renew seat" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeDisabled();

  await seatCard.getByRole("button", { name: "Start seat" }).click();
  await expect.poll(() => api.requests.checkouts).toBe(1);
  const checkout = api.requests.seatActions.at(-1);
  expect(checkout).toMatchObject({ op: "checkout", body: { entitlement_id: "ent_floating" } });
  expect(checkout.body).not.toHaveProperty("seat_id");
  expect(checkout.body.client_instance_id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Renew seat" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeEnabled();
  // Starting the seat flips hasBrowserSession and remounts the panel (<details> -> <section>),
  // unmounting the just-clicked Start seat button; focus must land on the seat's Release button,
  // never fall through to <body>.
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  await seatCard.getByRole("button", { name: "Renew seat" }).click();
  await expect.poll(() => api.requests.heartbeats).toBe(1);
  const heartbeat = api.requests.seatActions.at(-1);
  expect(heartbeat).toMatchObject({ op: "heartbeat", body: { entitlement_id: "ent_floating", seat_id: "seat-e2e" } });
  expect(heartbeat.body.client_instance_id).toBe(checkout.body.client_instance_id);
  // Seats persist per customer id ("cus_self" throughout this fixture), not under one shared key.
  const storedSeatSessionBeforeReleaseConfirm = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"));

  // Release is destructive: opening the confirmation must not send a request or change the live
  // session. The dialog names the exact app, feature and this browser, plus the availability impact
  // (no longer the seat id or license fingerprint -- the dialog is pinned to app/feature/
  // "This browser" only).
  await page.setViewportSize({ width: 320, height: 240 });
  await seatCard.getByRole("button", { name: "Release seat" }).click();
  const releaseDialog = page.getByRole("dialog");
  await expect(releaseDialog).toBeVisible();
  await expect(releaseDialog).toContainText("DEFAULT");
  await expect(releaseDialog).toContainText("pro");
  await expect(releaseDialog).toContainText("This browser");
  await expect(releaseDialog).toContainText(checkout.body.client_instance_id);
  await expect(releaseDialog).toContainText("cannot be undone");
  await expect(releaseDialog).toContainText("available to another user");
  // A native <dialog> (no separate overlay/backdrop div to inspect) -- still scrollable and
  // clipped at a small viewport, and the page itself never gains horizontal scroll.
  const compactModalLayout = await page.evaluate(() => {
    const modal = document.querySelector("dialog[open]");
    return {
      modalScrollable: modal !== null && modal.scrollHeight > modal.clientHeight,
      modalOverflow: modal === null ? "" : getComputedStyle(modal).overflow,
      bodyHasHorizontalOverflow: document.body.scrollWidth > window.innerWidth,
    };
  });
  expect(compactModalLayout.modalScrollable).toBe(true);
  expect(compactModalLayout.modalOverflow).toBe("auto");
  expect(compactModalLayout.bodyHasHorizontalOverflow).toBe(false);
  const cancelRelease = releaseDialog.getByRole("button", { name: "Cancel" });
  const confirmRelease = releaseDialog.getByRole("button", { name: "Confirm release" });
  const releaseTitle = releaseDialog.getByRole("heading", { name: "Release seat?" });
  await releaseTitle.scrollIntoViewIfNeeded();
  const titleInViewport = await releaseTitle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(titleInViewport).toBe(true);
  await confirmRelease.scrollIntoViewIfNeeded();
  const actionsInViewport = await confirmRelease.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(actionsInViewport).toBe(true);
  // A native dialog's own default: showModal() focuses the first focusable descendant (Cancel), no
  // explicit autofocus code needed.
  await expect(cancelRelease).toBeFocused();
  // A modal <dialog> alone does not reliably keep the rest of the page out of the
  // accessibility tree in every engine, so App.tsx still makes `main` inert by hand while either new
  // confirm dialog is pending -- verified directly against this Chromium build, not assumed.
  await expect(page.locator("main")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(page.locator("main").getByRole("button", { name: "Renew seat" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(confirmRelease).toBeFocused();
  // This Chromium's native modal-dialog Tab cycle makes a transient stop on <body> between the
  // dialog's last and first controls (verified directly) rather than wrapping in a single Tab --
  // background content is still never reached either way, which the next two checks confirm.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(cancelRelease).toBeFocused();
  // Inert content cannot even take focus programmatically.
  const backgroundFocused = await page.locator("main").evaluate((main) => {
    const button = Array.from(main.querySelectorAll("button")).find((candidate) => candidate.textContent === "Refresh");
    button?.focus();
    return document.activeElement === button;
  });
  expect(backgroundFocused).toBe(false);
  await expect(cancelRelease).toBeFocused();
  await expect.poll(() => api.requests.releases).toBe(0);

  // Cancel is a no-op for the session and backend.
  await cancelRelease.click();
  await expect(releaseDialog).toHaveCount(0);
  await expect.poll(() => api.requests.releases).toBe(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"))).toBe(storedSeatSessionBeforeReleaseConfirm);
  await expect(seatCard.getByRole("button", { name: "Renew seat" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeEnabled();
  // Every close -- Cancel here -- returns focus to the "Browser seats" section heading, matching
  // ProtectedNodes' own heading-focus pattern.
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Escape is the keyboard cancellation path and likewise must not release the seat.
  await seatCard.getByRole("button", { name: "Release seat" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => api.requests.releases).toBe(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"))).toBe(storedSeatSessionBeforeReleaseConfirm);
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeFocused();

  // A deferred failed confirmation keeps focus inside the busy dialog, blocks Escape/Cancel, and
  // then preserves the active seat, leaves the error visible, and returns focus to the heading.
  api.controls.failNextRelease = true;
  api.controls.deferNextRelease = true;
  await seatCard.getByRole("button", { name: "Release seat" }).click();
  const failedReleaseDialog = page.getByRole("dialog");
  await expect(failedReleaseDialog).toBeVisible();
  await failedReleaseDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect.poll(() => api.requests.releases).toBe(1);
  await expect(failedReleaseDialog).toHaveAttribute("aria-busy", "true");
  await expect(failedReleaseDialog.getByText("Releasing…")).toBeVisible();
  await expect(failedReleaseDialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(failedReleaseDialog.getByRole("button", { name: "Confirm release" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(failedReleaseDialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await expect.poll(() => typeof api.controls.resolveRelease).toBe("function");
  api.controls.resolveRelease();
  await expect(failedReleaseDialog).toHaveCount(0);
  // Human text, not the raw code: the code stays available, but only inside the collapsed
  // "Technical details" disclosure.
  await expect(page.getByText("We couldn't verify that request. Try again.", { exact: true })).toBeVisible();
  await expect(page.getByText("verification_error", { exact: false })).not.toBeVisible();
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"))).toBe(storedSeatSessionBeforeReleaseConfirm);

  // A rejected fetch keeps the context/modal present with an explicit failure, then Escape closes
  // it through the normal policy path and returns focus to the heading.
  api.controls.rejectNextRelease = true;
  await seatCard.getByRole("button", { name: "Release seat" }).click();
  const networkErrorDialog = page.getByRole("dialog");
  await networkErrorDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect(networkErrorDialog).toContainText("service was unreachable");
  await expect(networkErrorDialog).toContainText("outcome is unknown");
  await expect(networkErrorDialog).toContainText(/check the seat status/i);
  await expect(networkErrorDialog).toContainText(checkout.body.client_instance_id);
  await expect(networkErrorDialog.getByRole("alert")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await expect(networkErrorDialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await expect(networkErrorDialog.getByRole("button", { name: "Confirm release" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(networkErrorDialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"))).toBe(storedSeatSessionBeforeReleaseConfirm);

  // Only the explicit confirmation sends the original request, and a double click remains one
  // release while the existing busy guard is active. Releasing the last live seat used to always
  // collapse the panel into a plain <details>; now it instead shows this seat's own result
  // (its role="status" line) and stays expanded so that result is visible without reopening
  // anything. Focus after this close goes to the "Browser seats" heading, not the re-enabled
  // Start seat button.
  await seatCard.getByRole("button", { name: "Release seat" }).click();
  const confirmReleaseDialog = page.getByRole("dialog");
  await expect(confirmReleaseDialog).toBeVisible();
  await confirmReleaseDialog.getByRole("button", { name: "Confirm release" }).dblclick();
  await expect.poll(() => api.requests.releases).toBe(3);
  const release = api.requests.seatActions.at(-1);
  expect(release).toMatchObject({ op: "release", body: { entitlement_id: "ent_floating", seat_id: "seat-e2e" } });
  expect(release.body).toEqual({
    entitlement_id: "ent_floating",
    client_instance_id: checkout.body.client_instance_id,
    nonce: expect.any(String),
    seat_id: "seat-e2e",
  });
  expect(release.body.client_instance_id).toBe(checkout.body.client_instance_id);
  // Human text, not the raw code: Technical details stay collapsed. This is the SEAT's own
  // local result line now, not the page-level one.
  await expect(seatCard.getByRole("status")).toContainText("Seat released.");
  await expect(page.getByText("release_ok", { exact: false })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Renew seat" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Release seat" })).toBeDisabled();

  // A valid release is authoritative even when the follow-up status refresh rejects. The local
  // session is already gone, the dialog closes once, and manual status refresh remains available;
  // no second release POST is offered or sent.
  await seatCard.getByRole("button", { name: "Start seat" }).click();
  await expect.poll(() => api.requests.checkouts).toBe(2);
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Renew seat" })).toBeEnabled();
  const refreshFailureReleaseCount = api.requests.releases;
  const refreshFailureStoredSession = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"));
  expect(refreshFailureStoredSession).not.toBeNull();
  api.controls.rejectRefreshes = 3;
  await seatCard.getByRole("button", { name: "Release seat" }).click();
  const refreshFailedDialog = page.getByRole("dialog");
  await refreshFailedDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect.poll(() => api.requests.releases).toBe(refreshFailureReleaseCount + 1);
  await expect(refreshFailedDialog).toHaveCount(0);
  await expect.poll(() => api.requests.refreshRejects).toBe(3);
  // Not tag-qualified (StatusLine's non-empty root changed from <p> to <div> so it can validly
  // contain the collapsed Technical-details <details>); role + class alone identify it either way.
  await expect(page.locator('.feedback [role="status"]')).toContainText(/released; status refresh failed/i);
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_self"))).toBe("{}");
  // This release also leaves no browser session, but the panel stays expanded (this seat's own
  // "Seat released." result is showing). Focus still lands on the "Browser seats" heading -- it
  // is never busy-disabled the way the Start seat button is, so the failed refresh does not change
  // where focus goes.
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeDisabled();

  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("button", { name: "Refresh status" })).toHaveCount(0);
  await expect(page.locator('.feedback [role="status"]')).toHaveText("");
  await expect(page.getByRole("link", { name: "Devices", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  // --- Usage ---
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.getByText("Activity",{exact:true}).click();
  await expect(page.getByText("87", { exact: true })).toBeVisible();

  // --- Download: triggers a browser download of the streamed attachment ---
  // License download is part of the app details.
  await page.locator("tr").filter({has:page.getByLabel("Device key for DEFAULT solo")}).getByText("Activate and download",{exact:true}).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Activate and download .lic" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("DEFAULT-solo.lic");
  await expect.poll(() => api.requests.downloads).toBe(1);

  // --- Leak guard: the rendered page text must NEVER expose any credential / cross-tenant id. ---
  const pageText = await page.locator("body").innerText();
  for (const needle of ["PRIVATE KEY", "BEGIN", "Bearer ", "lcca_", "lccp_", "token", "cus_other", "other@example.com"]) {
    expect(pageText).not.toContain(needle);
  }

  // --- Logout returns to the sign-in screen ---
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect.poll(() => api.requests.logouts).toBe(1);
});

async function signIn(page, api) {
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
}

test("signing in moves focus to the signed-in page content", async ({ page }) => {
  const api = makePortalApiFixture();
  await signIn(page, api);
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.locator("#content")).toBeFocused();
});

test("the signed-in header and the empty Apps state show the resolved account email", async ({ page }) => {
  const api = makePortalApiFixture();
  api.entitlements.length = 0;
  api.controls.email = "alice@example.com";
  await signIn(page, api);
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.locator("header").getByText("Signed in as alice@example.com", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No apps assigned yet" })).toBeVisible();
  await expect(page.getByText("Signed in as alice@example.com. No apps are assigned to this account yet.", { exact: true })).toBeVisible();
});

test("a null account email never renders a dangling \"Signed in as\" or the literal word null", async ({ page }) => {
  const api = makePortalApiFixture();
  api.entitlements.length = 0;
  await signIn(page, api);
  await expect(page.getByRole("heading", { name: "No apps assigned yet" })).toBeVisible();
  await expect(page.getByText("Signed in as", { exact: false })).toHaveCount(0);
  await expect(page.getByText("No apps are assigned to this account yet.", { exact: true })).toBeVisible();
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("null");
});

// `button.primary`'s hover state must keep the text/background pair readable, not just visually
// distinct -- WCAG's contrast ratio, computed here from the pair's actual computed styles rather than
// trusted by inspection. Exercises the shared `button.primary:hover:not(:disabled)` rule across three
// independent components (AuthFeature's own two primary buttons, and PasswordAction's) so a fix to the
// one shared CSS rule is verified in more than one place.
test("hovering a primary button keeps at least a 4.5:1 contrast between its text and its background", async ({ page }) => {
  async function hoverContrast(locator) {
    await locator.hover();
    const [color, background] = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.color, style.backgroundColor];
    });
    return contrastRatio(parseRgb(color), parseRgb(background));
  }

  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: true, password: true }) }));
  await page.goto("/");

  // PasswordSignIn's own primary button (password login, the default when a password provider exists).
  expect(await hoverContrast(page.getByRole("button", { name: "Sign in", exact: true }))).toBeGreaterThanOrEqual(4.5);

  // AuthFeature's own primary button, the email-code request form's "Send code".
  if (!await page.locator(".otherSignIn").evaluate((element) => element.open)) await page.getByText("Other sign-in options", { exact: true }).click();
  await page.getByRole("button", { name: "Use an email code instead" }).click();
  expect(await hoverContrast(page.getByRole("button", { name: "Send code", exact: true }))).toBeGreaterThanOrEqual(4.5);

  // PasswordAction's own primary button (choosing a password from an emailed link).
  await page.goto(`/password-action#token=${"c".repeat(43)}`);
  expect(await hoverContrast(page.getByRole("button", { name: "Save password and sign in", exact: true }))).toBeGreaterThanOrEqual(4.5);
});

// Sign out right-aligns inside `.headerInner`, and `.signedInAs` must stay
// visible without overlapping it, at desktop width and at 390px alike.
test("Sign out's right edge aligns with the header's content box at desktop and phone width", async ({ page }) => {
  const api = makePortalApiFixture();
  api.controls.email = "user@example.com";
  await signIn(page, api);
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();

  async function edgeGap() {
    return page.evaluate(() => {
      const header = document.querySelector(".headerInner");
      const signOut = document.querySelector(".signOutControl");
      const contentRight = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight);
      return Math.abs(contentRight - signOut.getBoundingClientRect().right);
    });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await edgeGap()).toBeLessThanOrEqual(2);
  await expect(page.locator("header").getByText("Signed in as user@example.com", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await edgeGap()).toBeLessThanOrEqual(2);
  await expect(page.locator("header").getByText("Signed in as user@example.com", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a long account email wraps in the header instead of causing horizontal scroll at phone width", async ({ page }) => {
  const longEmail = "a-very-long-customer-email-address-for-overflow-testing-1234567890@example-subdomain.long-domain-name-example.com";
  const api = makePortalApiFixture();
  api.controls.email = longEmail;
  await signIn(page, api);
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.locator("header").getByText(`Signed in as ${longEmail}`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("app grouping, browser history and mobile reflow preserve the customer context", async ({ page }) => {
  const api = makePortalApiFixture();
  api.entitlements.push({ ...api.entitlements[0], id: "second_app", project: "SECOND_APP", feature: "second-feature" });
  api.entitlements.push({ ...api.entitlements[0], id: "duplicate_feature" });
  api.entitlements.reverse();
  await signIn(page, api);
  await expect(page.locator(".appRow")).toHaveCount(2);
  await expect(page.locator(".appRow h2")).toHaveText(["DEFAULT", "SECOND_APP"]);
  await expect(page.locator(".appRow").nth(0)).toContainText("3 licenses · 2 features");
  await expect(page.locator(".appRow").nth(1)).toContainText("1 license · 1 feature");
  await page.getByRole("link", { name: "View licenses for SECOND_APP" }).click();
  await expect(page.getByRole("heading", { name: "SECOND_APP", exact: true })).toBeVisible();
  await expect(page.getByText("solo", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "SECOND_APP", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "SECOND_APP", exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("link", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: "../../build/worker-staging/portal-redesign-nodes-mobile.png", fullPage: true });
  await page.getByRole("searchbox", { name: "Find a device" }).fill("missing");
  await expect(page.getByRole("heading", { name: "No matching devices" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Find a device" }).fill("");
  await expect(page.getByText("d".repeat(40), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page).toHaveTitle("Account · Licensecc");
  await expect(page.getByText("cus_self", { exact: true })).toBeHidden();
  await page.getByText("Account details", { exact: true }).click();
  await expect(page.getByText("cus_self", { exact: true })).toBeVisible();
  await expect(page.getByText("Your apps and devices stay connected.")).toBeVisible();
});

test("session and account-read failures do not masquerade as an empty account", async ({ page }) => {
  const api = makePortalApiFixture();
  api.controls.failMe = true;
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unable to check your session" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  api.controls.failMe = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  api.controls.rejectRefreshes = 3;
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account data unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No apps assigned yet" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("link", { name: "View licenses for DEFAULT" })).toBeVisible();
});

test("usage failure stays local and removing a searched registration keeps the filter truthful", async ({ page }) => {
  const api = makePortalApiFixture();
  api.controls.rejectUsage = true;
  api.entitlements.push({ ...api.entitlements[1], id: "second_app", project: "SECOND_APP" });
  api.devices.push({ ...api.devices[0], project: "SECOND_APP", device_key_id: "second-node" });
  await signIn(page, api);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await expect(page.getByText(/Activity is unavailable/)).toBeVisible();
  await page.locator("tr").filter({has:page.getByLabel("Device key for DEFAULT solo")}).getByText("Activate and download",{exact:true}).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  await expect(page.getByRole("button", { name: "Activate and download .lic" })).toBeEnabled();
  api.controls.rejectUsage = false;
  await page.getByRole("button", { name: "Retry activity" }).click();
  await page.getByText("Activity",{exact:true}).click();
  await expect(page.getByText("87", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  // One page-level search box (matching name, ID or app) replaces the registrations-only App
  // select; typing the app name filters the same way the old dropdown did.
  await page.getByRole("searchbox", { name: "Find a device" }).fill("DEFAULT");
  // The native <dialog> confirm replaces window.confirm() -- no page.on("dialog") handler needed
  // any more -- and names the exact device, app and feature before anything is sent.
  await page.locator(".registrations").getByRole("button", { name: "Release", exact: true }).click();
  const deviceReleaseDialog = page.getByRole("dialog");
  await expect(deviceReleaseDialog).toBeVisible();
  await expect(deviceReleaseDialog).toContainText("d".repeat(40));
  await expect(deviceReleaseDialog).toContainText("DEFAULT");
  await expect(deviceReleaseDialog).toContainText("pro");
  await deviceReleaseDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect(deviceReleaseDialog).toHaveCount(0);
  // A SUCCESSFUL Confirm returns focus to the section heading too, not
  // only Cancel/Escape (already covered by the legacy-release test below).
  await expect(page.getByRole("heading", { name: "Activated devices (older app versions)" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "No matching devices" })).toBeVisible();
  // The released row is gone after the refresh, so its result shows under the list instead.
  await expect(page.locator(".registrations").getByRole("status")).toContainText("Device released.");
  await expect(page.getByRole("searchbox", { name: "Find a device" })).toHaveValue("DEFAULT");
  await page.getByRole("searchbox", { name: "Find a device" }).fill("");
  await expect(page.getByText("second-node", { exact: true })).toBeVisible();
});

// The legacy-release confirm follows the exact same native <dialog> pattern as the floating-seat
// release above -- Escape cancels with no request sent, and focus returns to this section's own
// heading ("Activated devices (older app versions)"), not window.confirm's old accept/dismiss.
test("the legacy device release confirm names the device, app and feature; Escape cancels without a request and returns focus to the section heading", async ({ page }) => {
  const api = makePortalApiFixture();
  await signIn(page, api);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  const releaseButton = page.locator(".registrations").getByRole("button", { name: "Release", exact: true });
  const heading = page.getByRole("heading", { name: "Activated devices (older app versions)" });
  await releaseButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("d".repeat(40));
  await expect(dialog).toContainText("DEFAULT");
  await expect(dialog).toContainText("pro");
  await expect.poll(() => api.requests.deviceReleases).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.requests.deviceReleases).toBe(0);
  await expect(heading).toBeFocused();
  await expect(page.getByText("d".repeat(40), { exact: true })).toBeVisible();

  // Cancel is the same no-request path as Escape, and also returns focus to the heading.
  await releaseButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.requests.deviceReleases).toBe(0);
  await expect(heading).toBeFocused();
});

test("releasing the only activated device keeps its section, shows Device released. and keeps focus on the heading", async ({ page }) => {
  const api = makePortalApiFixture();
  await signIn(page, api);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  const section = page.locator(".registrations");
  const heading = page.getByRole("heading", { name: "Activated devices (older app versions)" });
  await section.getByRole("button", { name: "Release", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm release" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => api.requests.deviceReleases).toBe(1);
  await expect(section.getByRole("heading", { name: "No activated devices" })).toBeVisible();
  await expect(section.getByRole("status")).toContainText("Device released.");
  await expect(heading).toBeFocused();
  // The result belongs to this visit only.
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByText("Device released.")).toHaveCount(0);
  await expect(section).toHaveCount(0);
});

// Browser Back is not blocked by the inert page behind a confirmation, so the device confirmation has
// to outlive the Devices page: it stays open and usable where Back lands, and Forward returns to it.
test("browser Back while a device Release confirmation is open keeps it usable, and Forward returns to it", async ({ page }) => {
  const api = makePortalApiFixture();
  await signIn(page, api);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  const releaseButton = page.locator(".registrations").getByRole("button", { name: "Release", exact: true });
  const dialog = page.getByRole("dialog");
  const main = page.locator("main");

  await releaseButton.click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Apps");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main).not.toHaveAttribute("inert");
  await expect(main).not.toHaveAttribute("aria-hidden");
  await expect(page.locator("#content")).toBeFocused();
  await expect(page.getByRole("link", { name: "View licenses for DEFAULT" })).toBeVisible();

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await releaseButton.click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Apps");
  await page.goForward();
  await expect(page.locator("h1")).toHaveText("Devices");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("d".repeat(40));
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main).not.toHaveAttribute("inert");
  await expect(page.getByRole("heading", { name: "Activated devices (older app versions)" })).toBeFocused();
  expect(api.requests.deviceReleases).toBe(0);

  // A release confirmed on the page Back landed on succeeds with no result line anywhere, and the next
  // visit to Devices lists the device as gone.
  await releaseButton.click();
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Apps");
  await dialog.getByRole("button", { name: "Confirm release" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.requests.deviceReleases).toBe(1);
  await expect(page.locator(".feedback").getByRole("status")).toHaveCount(0);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connected devices" })).toBeVisible();
  await expect(page.getByText("d".repeat(40), { exact: true })).toHaveCount(0);
  await expect(page.locator(".registrations")).toHaveCount(0);
});

// A release confirmed on another page has no device row on screen to report into. A refusal must still
// be reported where the customer is, in the page-level line, and it belongs to that visit only.
test("a device release confirmed on another page after Back and refused by the server is reported on that page, and not again on Devices", async ({ page }) => {
  const api = makePortalApiFixture();
  api.controls.failNextDeviceRelease = true;
  await signIn(page, api);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.locator(".registrations").getByRole("button", { name: "Release", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Apps");
  await dialog.getByRole("button", { name: "Confirm release" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.requests.deviceReleases).toBe(1);

  const pageLine = page.locator(".feedback").getByRole("status");
  await expect(pageLine).toContainText("This is temporarily unavailable. Try again shortly.");
  await expect(pageLine).toHaveClass(/error/);
  await pageLine.getByText("Technical details", { exact: true }).click();
  await expect(pageLine.getByText("temporarily_unavailable (portal-e2e-device-release-failure)", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByText("d".repeat(40), { exact: true })).toBeVisible();
  await expect(page.locator(".registrations").getByRole("status")).toHaveCount(0);
  await expect(page.getByText("This is temporarily unavailable. Try again shortly.")).toHaveCount(0);
});

test("protected access uses app enrollment while legacy downloads respect date boundaries", async ({ page }, testInfo) => {
  const api = makePortalApiFixture();
  api.entitlements.push({ ...api.entitlements[1], id: "protected", feature: "protected", enforcement_mode: "device_bound_v1" });
  api.entitlements[1].valid_until = Math.floor(Date.now() / 1000) - 1;
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  await signIn(page, api);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await expect(page.getByText("Connect from your app",{exact:true})).toBeVisible();
  await expect(page.getByRole("cell", { name: "Protected device", exact: true })).toBeVisible();
  await expect(page.getByLabel("Device key for DEFAULT protected")).toHaveCount(0);
  await expect(page.locator(".status.expired")).toHaveCount(1);
  // An expired license offers no download at all; its status says what to do instead.
  const expiredRow = page.locator("tr").filter({ hasText: "solo" });
  await expect(expiredRow.locator('td[data-label="Status"]')).toHaveText(/^Expired on \d{4}-\d{2}-\d{2}\. Contact your administrator to renew\.$/);
  await expect(expiredRow.getByText("Activate and download")).toHaveCount(0);
  await expect(page.getByLabel("Device key for DEFAULT solo")).toHaveCount(0);
  expect(api.requests.downloads).toBe(0);
  for (const width of [320, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("Status reflects license dates. Your app also checks device and trial access.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`license-access-${width}.png`), fullPage: true });
  }
  api.entitlements.splice(0, 2);
  await page.reload();
  await expect(page.getByText("Connect from your app",{exact:true})).toBeVisible();
});

test("sign-in headings follow the chosen method after registration and reset", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", route => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: true, password: true }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create account", exact: true })).toBeVisible();
  if (!await page.locator(".otherSignIn").evaluate(element => element.open)) await page.getByText("Other sign-in options", { exact: true }).click();
  await page.getByRole("button", { name: "Use an email code instead" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use a password instead" }).click();
  await expect(page.getByRole("heading", { name: "Create account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset password", exact: true })).toBeVisible();
  if (!await page.locator(".otherSignIn").evaluate(element => element.open)) await page.getByText("Other sign-in options", { exact: true }).click();
  await page.getByRole("button", { name: "Use an email code instead" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});
