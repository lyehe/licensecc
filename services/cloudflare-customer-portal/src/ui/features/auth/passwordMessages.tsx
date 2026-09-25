import React from "react";
import { configuredRecoveryMethods, joinWithOr, rateLimitMessage } from "../../portalWorkflow";
import { SupportContact } from "../../shared/SupportContact";
import { useProviders } from "./ProviderSignIn";

// Recovery hints (here, and PasswordSettings.tsx's own near-identical sentence) list only the
// sign-in methods GET /portal/v1/auth/providers actually reports as configured, falling back to a
// support-contact sentence when none is configured. `tail` is the rest of the sentence after the
// method list, which differs slightly by caller ("before setting a password." here, "to set a
// password." in PasswordSettings) -- the fallback sentence is the same everywhere it is used.
export function RecoveryHint({ tail }: { tail: string }): React.ReactElement {
  const { providers } = useProviders();
  const methods = configuredRecoveryMethods(providers);
  if (methods.length === 0) return <><SupportContact /> to set a password.</>;
  return <>Sign in again with {joinWithOr(methods)} {tail}</>;
}

const MESSAGES: Record<string, React.ReactNode> = {
  invalid_email: "Enter a valid email address.",
  // "Request a new link" is a real affordance: it returns to sign-in with the reset form already
  // open. AuthFeature reads this exact query marker once on mount and strips it from the URL.
  invalid_link: <>This link has expired or was already used. <a href="/?password_action=reset">Request a new link</a></>,
  email_unconfigured: <>Email delivery is not configured. <SupportContact /> or use another sign-in method.</>,
  account_suspended: <>This account is suspended. <SupportContact />.</>,
  invalid_credentials: "Email or password is incorrect.",
  invalid_registration: "Enter a valid email and a password of 15–128 characters.",
  verified_sign_in_required: <RecoveryHint tail="before setting a password." />,
  password_change_conflict: "Your sign-in settings changed. Reload and try again.",
  // api()'s own network_unavailable (a dropped connection) reaches passwordMessage() from
  // PasswordSettings, PasswordAction and PasswordSignIn alike, which previously had no copy for it
  // and fell through to the generic "Unable to complete the request" fallback below.
  network_unavailable: "Couldn't reach the portal. Check your connection and try again.",
};

export function passwordMessage(code: string, retryAfter?: number): React.ReactNode {
  // The single shared rate-limit sentence, driven by the server's real retry-after header when one
  // reached this call, else the same "later" fallback every other unheadered 429 uses.
  if (code === "rate_limited") return rateLimitMessage(retryAfter);
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : "Unable to complete the request. Please try again.";
}

// The password-action page (choosing a password from an emailed link) never collects an email, so
// its invalid_registration guidance should describe only the password requirement.
export function passwordActionMessage(code: string, retryAfter?: number): React.ReactNode {
  return code === "invalid_registration" ? "Choose a password of 15–128 characters." : passwordMessage(code, retryAfter);
}
