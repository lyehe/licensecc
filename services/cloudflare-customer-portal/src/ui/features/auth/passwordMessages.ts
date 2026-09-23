export function passwordMessage(code: string): string {
  return ({
    invalid_email: "Enter a valid email address.",
    invalid_link: "This link has expired or was already used. Request a new link.",
    email_unconfigured: "Email delivery is not configured. Contact your administrator or use another sign-in method.",
    invalid_credentials: "Email or password is incorrect.",
    invalid_registration: "Enter a valid email and a password of 15–128 characters.",
    rate_limited: "Too many attempts. Please try again later.",
    verified_sign_in_required: "Sign in again with Google, GitHub, or an email code before setting a password.",
    password_change_conflict: "Your sign-in settings changed. Reload and try again.",
  } as Record<string, string>)[code] ?? "Unable to complete the request. Please try again.";
}
