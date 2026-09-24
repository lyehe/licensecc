import React, { useCallback, useEffect, useState } from "react";

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
  RESEND_CODE_ACTION_LABEL,
} from "../../portalWorkflow";
import { api, localMessage, resultMessage, StatusLine } from "../../shared/api";
import { SupportContact } from "../../shared/SupportContact";
import type { PortalMe, StatusMessage } from "../../types";

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
  // The signed-in account's resolved display email (task A4): customers.email, else the password
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
  logout(afterLogout: () => void): Promise<void>;
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
      // would be circular -- so it is the one api() call in this file that opts out (task C3).
      const result = await api<PortalMe>(mePath(), undefined, { skipUnauthorizedHook: true });
      if (result.ok && result.data) {
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

  async function logout(afterLogout: () => void): Promise<void> {
    await runOnce(async () => {
      const result = await api(logoutPath(), { method: "POST", body: "{}" });
      if (!result.ok) {
        // Whatever the server said -- or api()'s own network_unavailable when it couldn't even ask --
        // the customer is still signed in. Say so specifically rather than forwarding a code like
        // "unauthorized" that would misleadingly suggest the session is already gone (task C2).
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
    });
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

export function AuthFeature({ auth, busy, message, connecting = false }: {
  auth: PortalAuth;
  busy: boolean;
  message: StatusMessage | null;
  connecting?: boolean;
}): React.ReactElement | null {
  const { providers, failed, retry } = useProviders();
  const [emailCode, setEmailCode] = useState(false);
  const [passwordMode, setPasswordMode] = useState<PasswordMode>("login");
  const passwordHeading = !emailCode && providers?.password && auth.phase === "request"
    ? PASSWORD_HEADINGS[passwordMode]
    : "Sign in";
  if (auth.phase === "authed") return null;
  if (auth.phase === "loading" || auth.phase === "error") {
    return (
      <main className="authPane">
        <section className="authCard"><h1>{auth.phase === "loading" ? "Checking your session…" : "Unable to check your session"}</h1>
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
        <h1>{passwordHeading}</h1>
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
            <h2>Check your email</h2>
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
              <button disabled={busy} type="button" onClick={() => void auth.resendCode()}>{RESEND_CODE_ACTION_LABEL}</button>
              <button disabled={busy} type="button" onClick={auth.useDifferentEmail}>Use a different email</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
