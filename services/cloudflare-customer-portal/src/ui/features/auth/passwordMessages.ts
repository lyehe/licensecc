export function passwordMessage(code: string): string {
  return ({
    invalid_credentials: "Email or password is incorrect.",
    invalid_registration: "Enter a valid email and a password of 15–128 characters.",
    registration_unavailable: "Unable to create this account. Try signing in or contact your administrator.",
    rate_limited: "Too many attempts. Please try again later.",
    verified_sign_in_required: "Sign in again with Google, GitHub, or an email code before setting a password.",
    password_change_conflict: "Your sign-in settings changed. Reload and try again.",
  } as Record<string, string>)[code] ?? "Unable to complete the request. Please try again.";
}
