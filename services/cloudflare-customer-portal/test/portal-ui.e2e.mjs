import { expect, test } from "@playwright/test";
import { contrastRatio, parseRgb } from "./e2e-contrast.mjs";

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
  const controls = { failMe: false, rejectRefreshes: 0, email: null };
  const requests = { authRequests: 0, verifies: 0, refreshRejects: 0, logouts: 0, retires: [] };

  const entitlements = [
    { id: "ent_pro", project: "DEFAULT", feature: "pro", status: "active", license_fingerprint: "a".repeat(64), valid_from: 1_710_000_000, valid_until: null, enforcement_mode: "device_bound_v1", license_mode: "trial", max_active_devices: 1, policy_id: "pol_pro", trial_ends_at: null, trial_starts_on_activation: false },
    { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: 2_100_000_000, enforcement_mode: "device_bound_v1", license_mode: "node_locked", max_active_devices: 1, policy_id: "pol_node", trial_ends_at: null, trial_starts_on_activation: false },
  ];
  const bindingNow = 1_800_000_000;
  const bindings = [
    { binding_id: Buffer.alloc(16, 9).toString("base64url"), project: "DEFAULT", feature: "pro", revision: 0, hold_until: bindingNow + 3600, state: "active", label: "Primary workstation", last_proof_at: bindingNow - 30, created_at: bindingNow - 3600, server_time: bindingNow },
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
    // ---- Connected devices (protected bindings) ----
    if (method === "GET" && path === "/api/portal/device-bindings") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("device_bindings", { customer_id: "cus_self", items: bindings.map((item) => ({ ...item })), has_more: false, next_cursor: null }));
    }
    if (method === "POST" && path === "/api/portal/device-bindings/retire") {
      const body = await jsonBody(request);
      requests.retires.push(body);
      const target = bindings.find((item) => item.binding_id === body.binding_id);
      if (target === undefined || target.revision !== body.expected_revision) {
        return fulfill(409, { ok: false, code: "revision_conflict", request_id: "portal-e2e-retire-conflict" });
      }
      target.state = "retiring";
      target.revision += 1;
      return fulfill(200, makeEnvelope("binding_retired", { binding_id: target.binding_id, state: "retiring", effective_release_at: target.hold_until, revision: target.revision, generation: 2 }));
    }

    return fulfill(404, { ok: false, code: "not_found", request_id: "portal-e2e-unhandled" });
  }

  return { route, requests, VALID_CODE, controls, entitlements, bindings };
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

  // --- Per-app access (read-only): the active protected license offers no download, only the
  // instruction to connect from the licensed application itself. ---
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await expect(page.locator(".tablePane tbody tr").filter({hasText:"pro"}).first()).toBeVisible();
  await expect(page.locator(".status.active").first()).toHaveText("Active");
  await expect(page.getByText("aaaaaaaa...aaaaaaaa").first()).toBeVisible();
  await expect(page.getByText("Connect from your app").first()).toBeVisible();

  // --- Connected devices (protected bindings): the Devices page shows only this section, with a
  // Disconnect action -- no browser seats, no legacy "Activated devices" list, no download. ---
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page).toHaveTitle("Devices · Licensecc");
  await expect(page.getByRole("heading", { name: "Connected devices" })).toBeVisible();
  await expect(page.getByText("Browser seats", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Activated devices", { exact: false })).toHaveCount(0);
  const deviceRow = page.locator("tr").filter({ hasText: "Primary workstation" });
  await expect(deviceRow.getByRole("cell", { name: "Connected", exact: true })).toBeVisible();

  // Opening the confirmation must not send a request; Cancel is a no-op.
  await deviceRow.getByRole("button", { name: "Disconnect", exact: true }).click();
  const disconnectDialog = page.getByRole("dialog");
  await expect(disconnectDialog).toBeVisible();
  await expect(disconnectDialog).toContainText("DEFAULT");
  await expect(disconnectDialog).toContainText("pro");
  await expect(disconnectDialog).toContainText("Primary workstation");
  await expect(disconnectDialog).toContainText("This connection cannot be restored");
  await disconnectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(disconnectDialog).toHaveCount(0);
  expect(api.requests.retires).toHaveLength(0);

  // Confirming sends exactly one retire request and shows the resulting status.
  await deviceRow.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(disconnectDialog).toBeVisible();
  await disconnectDialog.getByRole("button", { name: "Disconnect device", exact: true }).click();
  await expect(disconnectDialog).toHaveCount(0);
  await expect.poll(() => api.requests.retires).toHaveLength(1);
  expect(api.requests.retires[0]).toEqual({ binding_id: api.bindings[0].binding_id, expected_revision: 0 });
  await expect(page.getByText(/Renewal stopped for Primary workstation/)).toBeVisible();
  await expect(page.getByRole("cell", { name: /Disconnecting/ })).toBeVisible();

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
  await expect(page.getByText("Primary workstation")).toBeVisible();
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
  api.controls.rejectRefreshes = 1;
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account data unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No apps assigned yet" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("link", { name: "View licenses for DEFAULT" })).toBeVisible();
});

test("protected access uses app enrollment; an expired license shows no action, only its status", async ({ page }, testInfo) => {
  const api = makePortalApiFixture();
  api.entitlements.push({ ...api.entitlements[1], id: "protected", feature: "protected" });
  api.entitlements[1].valid_until = Math.floor(Date.now() / 1000) - 1;
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  await signIn(page, api);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  // Scoped to the Feature cell specifically: a plain row-wide hasText would also catch the "pro"
  // row's own "Protected device" Mode text (hasText matches case-insensitively).
  const protectedRow = page.locator("tr").filter({ has: page.locator('td[data-label="Feature"]', { hasText: "protected" }) });
  await expect(protectedRow.getByText("Connect from your app", { exact: true })).toBeVisible();
  await expect(protectedRow.getByRole("cell", { name: "Protected device", exact: true })).toBeVisible();
  await expect(page.getByLabel("Device key for DEFAULT protected")).toHaveCount(0);
  await expect(page.locator(".status.expired")).toHaveCount(1);
  // An expired license offers no action at all; its status says what to do instead.
  const expiredRow = page.locator("tr").filter({ hasText: "solo" });
  await expect(expiredRow.locator('td[data-label="Status"]')).toHaveText(/^Expired on \d{4}-\d{2}-\d{2}\. Contact your administrator to renew\.$/);
  await expect(expiredRow.getByText("Connect from your app")).toHaveCount(0);
  await expect(page.getByLabel("Device key for DEFAULT solo")).toHaveCount(0);
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
