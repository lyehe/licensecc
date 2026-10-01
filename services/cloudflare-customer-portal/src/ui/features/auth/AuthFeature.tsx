import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  authRequestPath,
  authVerifyPath,
  isLikelyEmail,
  isValidCode,
  LOGIN_CODE_SENT_COPY,
  logoutPath,
  mePath,
  normalizeCode,
  normalizeEmail,
  OTP_EXPIRY_COPY,
} from "../../portalWorkflow";
import { api, beginNewSession, localMessage, resultMessage, StatusLine } from "../../shared/api";
import { SupportContact } from "../../shared/SupportContact";
import type { PortalMe, StatusMessage } from "../../types";

import { resendCodeLabel, RESEND_COOLDOWN_SECONDS } from "./authCopy";
import { PasswordSignIn, type PasswordMode } from "./PasswordSignIn";
import { ProviderButtons, ProviderResult, useProviders } from "./ProviderSignIn";

export type AuthPhase = "loading" | "request" | "verify" | "authed" | "error";
const PASSWORD_HEADINGS: Record<PasswordMode, string> = {
  login: "Sign in",
  register: "Create account",
  reset: "Reset password",
};

interface AuthOptions {
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
  runOnce(work: () => Promise<void>): Promise<void>;
}

export interface PortalAuth {
  customerId: string | null;
  // The signed-in account's resolved display email: customers.email, else the password
  // account's email, else the earliest linked identity's email, else null. Read-only from the
  // consumer's side -- it is derived from /me, never typed by the user. Distinct from `loginEmail`
  // below, the sign-in form's OWN draft value.
  email: string | null;
  retrySession(): Promise<boolean>;
  phase: AuthPhase;
  loginEmail: string;
  code: string;
  setLoginEmail(value: string): void;
  setCode(value: string): void;
  submitRequest(event: React.FormEvent): Promise<void>;
  submitVerify(event: React.FormEvent): Promise<void>;
  resendCode(): Promise<void>;
  useDifferentEmail(): void;
  // Returns whether sign-out actually completed, so a caller can tell a real sign-out apart from a
  // failed attempt that leaves the customer signed in.
  logout(afterLogout: () => void): Promise<boolean>;
}

export function usePortalAuth({ setMessage, runOnce }: AuthOptions): PortalAuth {
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [loginEmail, setLoginEmail] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);

  const loadMe = useCallback(async (): Promise<boolean> => {
    setPhase("loading");
    try {
      // This IS the session check the global onUnauthorized hook (api.tsx, wired in App.tsx) calls to
      // find out whether a session is really gone. Its own 401 must never re-trigger that hook -- that
      // would be circular -- so it is the one api() call in this file that opts out.
      const result = await api<PortalMe>(mePath(), undefined, { skipUnauthorizedHook: true });
      if (result.ok && result.data) {
        // A confirmed session, new or reconfirmed. Bumps the epoch so a straggler response from a
        // request sent under an OLDER session can never bounce this one back to sign-in.
        beginNewSession();
        setCustomerId(result.data.customer_id);
        setEmail(result.data.email ?? null);
        setMessage(null);
        setPhase("authed");
        return true;
      }
      setPhase(result.code === "unauthorized" ? "request" : "error");
    } catch {
      setPhase("error");
    }
    return false;
  }, [setMessage]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function requestCode(): Promise<string | null> {
    const normalized = normalizeEmail(loginEmail);
    if (!isLikelyEmail(normalized)) {
      setMessage(localMessage("invalid_email", false));
      return null;
    }
    const result = await api(authRequestPath(), {
      method: "POST",
      body: JSON.stringify({ email: normalized }),
    });
    setMessage(resultMessage(result));
    return result.ok ? normalized : null;
  }

  async function submitRequest(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await runOnce(async () => {
      const normalized = await requestCode();
      if (normalized !== null) {
        setLoginEmail(normalized);
        setPhase("verify");
      }
    });
  }

  async function resendCode(): Promise<void> {
    await runOnce(async () => {
      await requestCode();
    });
  }

  async function submitVerify(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await runOnce(async () => {
      const normalized = normalizeCode(code);
      if (!isValidCode(normalized)) {
        setMessage(localMessage("invalid_code", false));
        return;
      }
      const result = await api(authVerifyPath(), {
        method: "POST",
        body: JSON.stringify({ email: normalizeEmail(loginEmail), code: normalized }),
      });
      setMessage(resultMessage(result));
      if (result.ok) {
        setCode("");
        await loadMe();
      }
    });
  }

  function useDifferentEmail(): void {
    setPhase("request");
    setMessage(null);
  }

  async function logout(afterLogout: () => void): Promise<boolean> {
    let succeeded = false;
    await runOnce(async () => {
      const result = await api(logoutPath(), { method: "POST", body: "{}" });
      if (!result.ok) {
        // Whatever the server said -- or api()'s own network_unavailable when it couldn't even ask --
        // the customer is still signed in. Say so specifically rather than forwarding a code like
        // "unauthorized" that would misleadingly suggest the session is already gone.
        setMessage(localMessage("logout_failed", false));
        return;
      }
      setMessage(resultMessage(result));
      afterLogout();
      setCustomerId(null);
      setEmail(null);
      setLoginEmail("");
      setCode("");
      setPhase("request");
      succeeded = true;
    });
    return succeeded;
  }

  return {
    customerId,
    email,
    retrySession: loadMe,
    phase,
    loginEmail,
    code,
    setLoginEmail,
    setCode,
    submitRequest,
    submitVerify,
    resendCode,
    useDifferentEmail,
    logout,
  };
}

// AuthFeature-owned marker: PasswordAction.tsx's "Request a new link" (invalid_link) navigates here
// with it so the reset form opens immediately, reusing PasswordSignIn's own `mode` rather than
// inventing a second, parallel way to say "open the reset form". Read once on
// mount and stripped immediately, exactly like ProviderResult already does for auth_error/auth_result.
function initialPasswordMode(): PasswordMode {
  if (typeof window === "undefined") return "login";
  const url = new URL(window.location.href);
  if (url.searchParams.get("password_action") !== "reset") return "login";
  url.searchParams.delete("password_action");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return "reset";
}

export function AuthFeature({ auth, busy, message, connecting = false }: {
  auth: PortalAuth;
  busy: boolean;
  message: StatusMessage | null;
  connecting?: boolean;
}): React.ReactElement | null {
  const { providers, failed, retry } = useProviders();
  const [emailCode, setEmailCode] = useState(false);
  const [passwordMode, setPasswordMode] = useState<PasswordMode>(initialPasswordMode);
  const [resendDeadline, setResendDeadline] = useState(0);
  const [, forceResendTick] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const passwordHeading = !emailCode && providers?.password && auth.phase === "request"
    ? PASSWORD_HEADINGS[passwordMode]
    : "Sign in";
  // One heading for every auth step (loading/error/verify/request), so focus and document.title logic
  // elsewhere can each key off a single source of truth instead of re-deriving the same branches.
  const stepHeading = auth.phase === "loading" ? "Checking your session…"
    : auth.phase === "error" ? "Unable to check your session"
    : auth.phase === "verify" ? "Check your email"
    : passwordHeading;
  // Focus moves to the new h1 on every step/mode change: a fresh render whose
  // heading text actually changed is exactly a "new step" from the customer's perspective, whether
  // that is a phase transition or a login/register/reset mode switch within "request".
  useLayoutEffect(() => {
    heading.current?.focus();
  }, [stepHeading]);
  // The resend cooldown restarts every time a fresh otp_requested message
  // arrives -- the initial send AND every resend alike -- and is purely a client-side display timer;
  // the server enforces its own, separate rate limit regardless of what this countdown shows.
  // `resendDeadline` is the moment the button reads "Resend code" again; it is set (RESEND_COOLDOWN_
  // SECONDS - 1) seconds out so the very next render already shows the full "(0:59)", matching the
  // countdown then ticking down one displayed second at a time to zero.
  useLayoutEffect(() => {
    if (message?.code === "otp_requested") setResendDeadline(Date.now() + (RESEND_COOLDOWN_SECONDS - 1) * 1000);
  }, [message]);
  // resendCountdown is DERIVED from resendDeadline during render, not tracked as its own state that
  // an effect updates a beat later: the layout effect above sets resendDeadline synchronously, before
  // paint, so this computation already reflects the fresh deadline on that same pre-paint render --
  // the button is disabled from its very first painted frame, never flashing "Resend code" first. A
  // single recurring interval (registered once per deadline) forces the periodic re-renders needed to
  // count down after that; it keeps ticking under its own steam regardless of how promptly React gets
  // to render each intermediate frame, and the value is recomputed fresh from Date.now() every time.
  // Once the deadline passes, the deadline resets to 0, which re-renders with the button enabled and
  // lets this effect's cleanup stop the timer instead of ticking on until the next code is sent.
  useEffect(() => {
    if (resendDeadline === 0) return undefined;
    const id = setInterval(() => {
      if (Date.now() >= resendDeadline) {
        setResendDeadline(0);
        return;
      }
      forceResendTick((tick) => tick + 1);
    }, 250);
    return () => clearInterval(id);
  }, [resendDeadline]);
  const resendCountdown = resendDeadline === 0 ? 0 : Math.max(0, Math.ceil((resendDeadline - Date.now()) / 1000));
  if (auth.phase === "authed") return null;
  if (auth.phase === "loading" || auth.phase === "error") {
    return (
      <main className="authPane">
        <section className="authCard"><h1 ref={heading} tabIndex={-1}>{stepHeading}</h1>
          <p>{auth.phase === "loading" ? "Your account will appear shortly." : "Please try again when your connection is available."}</p>
          {auth.phase === "error" && <button onClick={() => void auth.retrySession()}>Retry</button>}
        </section>
      </main>
    );
  }

  return (
    <main className="authPane">
      <div className="authBrand brand"><span aria-hidden="true">L</span>Licensecc</div>
      <section className="authCard">
        <h1 ref={heading} tabIndex={-1}>{stepHeading}</h1>
        <p>{connecting ? "Sign in to approve this device connection." : "Sign in to manage your licenses and devices."}</p>
        <StatusLine message={message} fallback="" />
        <ProviderResult />
        {auth.phase === "request" && failed && <p>Unable to load sign-in options. <button onClick={retry}>Retry sign-in options</button></p>}
        {auth.phase === "request" && !providers && !failed && <p>Loading sign-in options…</p>}
        {auth.phase === "request" && providers && !providers.google && !providers.github && !providers.email && !providers.password && <p>Sign-in is not configured yet. <SupportContact />.</p>}
        {auth.phase === "request" && providers?.password && !emailCode && <PasswordSignIn onSignedIn={auth.retrySession} mode={passwordMode} onModeChange={setPasswordMode} emailLinks={Boolean(providers.email)} />}
        {auth.phase === "request" && providers?.email && (!providers.password || emailCode) && (
          <form onSubmit={(event) => void auth.submitRequest(event)}>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={auth.loginEmail}
                onChange={(event) => auth.setLoginEmail(event.target.value)}
              />
            </label>
            <button className="primary" disabled={busy} type="submit">Send code</button>
            <p>Use the email associated with your customer account.</p>
          </form>
        )}
        {auth.phase === "request" && providers && (
          providers.password ? <>
            {emailCode && <button type="button" onClick={() => setEmailCode(false)}>Use a password instead</button>}
            {(providers.google || providers.github || (providers.email && !emailCode)) && <details className="otherSignIn">
              <summary>Other sign-in options</summary>
              <ProviderButtons providers={providers} />
              {providers.email && !emailCode && <button type="button" onClick={() => setEmailCode(true)}>Use an email code instead</button>}
            </details>}
          </> : <ProviderButtons providers={providers} />
        )}
        {auth.phase === "verify" && (
          <form onSubmit={(event) => void auth.submitVerify(event)}>
            <p>{LOGIN_CODE_SENT_COPY}</p>
            <p className="muted">{OTP_EXPIRY_COPY}</p>
            <label>
              8-digit code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={auth.code}
                onChange={(event) => auth.setCode(event.target.value)}
              />
            </label>
            <div className="actions">
              <button disabled={busy} type="submit">Verify</button>
              <button disabled={busy || resendCountdown > 0} type="button" onClick={() => void auth.resendCode()}>{resendCodeLabel(resendCountdown)}</button>
              <button disabled={busy} type="button" onClick={auth.useDifferentEmail}>Use a different email</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
