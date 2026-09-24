import React from "react";
import { SupportContact } from "../../shared/SupportContact";

const MESSAGES: Record<string, React.ReactNode> = {
  invalid_email: "Enter a valid email address.",
  invalid_link: "This link has expired or was already used. Request a new link.",
  email_unconfigured: <>Email delivery is not configured. <SupportContact /> or use another sign-in method.</>,
  account_suspended: <>This account is suspended. <SupportContact />.</>,
  invalid_credentials: "Email or password is incorrect.",
  invalid_registration: "Enter a valid email and a password of 15–128 characters.",
  rate_limited: "Too many attempts. Please try again later.",
  verified_sign_in_required: "Sign in again with Google, GitHub, or an email code before setting a password.",
  password_change_conflict: "Your sign-in settings changed. Reload and try again.",
};

export function passwordMessage(code: string): React.ReactNode {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : "Unable to complete the request. Please try again.";
}

// The password-action page (choosing a password from an emailed link) never collects an email, so
// its invalid_registration guidance should describe only the password requirement.
export function passwordActionMessage(code: string): React.ReactNode {
  return code === "invalid_registration" ? "Choose a password of 15–128 characters." : passwordMessage(code);
}
