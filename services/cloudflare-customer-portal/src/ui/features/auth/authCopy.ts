// Pure, dependency-free copy/formatting helpers scoped to the auth flow. Split out of
// ../../portalWorkflow.ts (the portal-wide pure module) so that shared module can stay under the
// repository's hotspot review threshold: these three concerns -- the resend cooldown label, and the
// configured-only recovery-method list -- are used exclusively by files under features/auth, never
// by anything portal-wide. Same purity contract as portalWorkflow.ts: no React, no DOM, no node:, so
// its own unit test can `ts.transpileModule` + `import()` it directly.

// Client-side-only cooldown: after a code is sent, Resend is disabled for this many seconds and
// shows the remaining time, e.g. "Resend code (0:59)". Never a full minute, so the label's minutes
// digit is always "0".
export const RESEND_COOLDOWN_SECONDS = 60;

export function resendCodeLabel(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return "Resend code";
  return `Resend code (0:${String(secondsRemaining).padStart(2, "0")})`;
}

// Recovery hints (passwordMessages' verified_sign_in_required, PasswordSettings' own sentence) list
// only the sign-in methods GET /portal/v1/auth/providers actually reports as configured -- never a
// method the operator has not turned on. `email` here means the email-code/magic-link method.
export function configuredRecoveryMethods(providers: { google?: boolean; github?: boolean; email?: boolean } | null | undefined): string[] {
  const methods: string[] = [];
  if (providers?.google) methods.push("Google");
  if (providers?.github) methods.push("GitHub");
  if (providers?.email) methods.push("an email code");
  return methods;
}

// "Google", "Google or GitHub", "Google, GitHub, or an email code" -- an Oxford comma before the
// final item only once there are 3+, matching ordinary English list prose.
export function joinWithOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
