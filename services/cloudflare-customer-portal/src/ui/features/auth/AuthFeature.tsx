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
import type { PortalMe, StatusMessage } from "../../types";

import { PasswordSignIn } from "./PasswordSignIn";
import { ProviderButtons, ProviderResult, useProviders } from "./ProviderSignIn";

export type AuthPhase = "loading" | "request" | "verify" | "authed" | "error";

interface AuthOptions {
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
  runOnce(work: () => Promise<void>): Promise<void>;
}

export interface PortalAuth {
  customerId: string | null;
  retrySession(): Promise<boolean>;
  phase: AuthPhase;
  email: string;
  code: string;
  setEmail(value: string): void;
  setCode(value: string): void;
  submitRequest(event: React.FormEvent): Promise<void>;
  submitVerify(event: React.FormEvent): Promise<void>;
  resendCode(): Promise<void>;
  useDifferentEmail(): void;
  logout(afterLogout: () => void): Promise<void>;
}

export function usePortalAuth({ setMessage, runOnce }: AuthOptions): PortalAuth {
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);

  const loadMe = useCallback(async (): Promise<boolean> => {
    setPhase("loading");
    try {
      const result = await api<PortalMe>(mePath());
      if (result.ok && result.data) {
        setCustomerId(result.data.customer_id);
        setMessage(null);
        setPhase("authed");
        return true;
      }
      setPhase(result.code === "unauthorized" ? "request" : "error");
      } catch { setPhase("error"); }
    return false;
  }, [setMessage]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function submitRequest(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await runOnce(async () => {
      const normalized = normalizeEmail(email);
      if (!isLikelyEmail(normalized)) {
        setMessage(localMessage("invalid_email", false));
        return;
      }
      const result = await api(authRequestPath(), {
        method: "POST",
        body: JSON.stringify({ email: normalized }),
      });
      setMessage(resultMessage(result));
      if (result.ok) {
        setEmail(normalized);
        setPhase("verify");
      }
    });
  }

  async function resendCode(): Promise<void> {
    await runOnce(async () => {
      const normalized = normalizeEmail(email);
      if (!isLikelyEmail(normalized)) {
        setMessage(localMessage("invalid_email", false));
        return;
      }
      const result = await api(authRequestPath(), {
        method: "POST",
        body: JSON.stringify({ email: normalized }),
      });
      setMessage(resultMessage(result));
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
        body: JSON.stringify({ email: normalizeEmail(email), code: normalized }),
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
      setMessage(resultMessage(result));
      if (!result.ok) return;
      afterLogout();
      setCustomerId(null);
      setEmail("");
      setCode("");
      setPhase("request");
    });
  }

  return {
    customerId,
    retrySession: loadMe,
    phase,
    email,
    code,
    setEmail,
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
  const [passwordMode,setPasswordMode]=useState<"login"|"register"|"reset">("login");
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
        <h1>{!emailCode && providers?.password && auth.phase==="request" ? (passwordMode==="register"?"Create account":passwordMode==="reset"?"Reset password":"Sign in") : "Sign in"}</h1>
        <p>{connecting ? "Sign in to approve this device connection." : "Sign in to manage your licenses and devices."}</p>
        <StatusLine message={message} fallback="" />
        <ProviderResult />
        {auth.phase === "request" && failed && <p>Unable to load sign-in options. <button onClick={retry}>Retry sign-in options</button></p>}
        {auth.phase === "request" && !providers && !failed && <p>Loading sign-in options…</p>}
        {auth.phase === "request" && providers && !providers.google && !providers.github && !providers.email && !providers.password && <p>Sign-in is not configured yet. Contact your administrator.</p>}
        {auth.phase === "request" && providers?.password && !emailCode && <PasswordSignIn onSignedIn={auth.retrySession} mode={passwordMode} onModeChange={setPasswordMode} />}
        {auth.phase === "request" && providers?.email && (!providers.password || emailCode) && (
          <form onSubmit={(event) => void auth.submitRequest(event)}>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={auth.email}
                onChange={(event) => auth.setEmail(event.target.value)}
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
