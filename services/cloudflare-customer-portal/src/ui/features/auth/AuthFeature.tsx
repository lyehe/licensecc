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

export type AuthPhase = "loading" | "request" | "verify" | "authed";

interface AuthOptions {
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
  runOnce(work: () => Promise<void>): Promise<void>;
}

export interface PortalAuth {
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

  const loadMe = useCallback(async (): Promise<boolean> => {
    const result = await api<PortalMe>(mePath());
    if (result.ok && result.data) {
      setPhase("authed");
      return true;
    }
    setPhase("request");
    return false;
  }, []);

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
      afterLogout();
      setEmail("");
      setCode("");
      setPhase("request");
    });
  }

  return {
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

export function AuthFeature({ auth, busy, message }: {
  auth: PortalAuth;
  busy: boolean;
  message: StatusMessage | null;
}): React.ReactElement | null {
  if (auth.phase === "authed") return null;
  if (auth.phase === "loading") {
    return (
      <main>
        <header className="topbar">
          <div>
            <h1>licensecc customer portal</h1>
            <p>loading…</p>
          </div>
        </header>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>licensecc customer portal</h1>
          <StatusLine message={message} fallback="sign in to manage your licenses" />
        </div>
      </header>
      <section className="authPane">
        {auth.phase === "request" && (
          <form onSubmit={(event) => void auth.submitRequest(event)}>
            <h2>Sign in</h2>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={auth.email}
                onChange={(event) => auth.setEmail(event.target.value)}
              />
            </label>
            <button disabled={busy} type="submit">Send code</button>
          </form>
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
