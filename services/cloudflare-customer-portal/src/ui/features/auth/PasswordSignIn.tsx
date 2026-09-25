import React, { useState } from "react";
import { api } from "../../shared/api";
import { SupportContact } from "../../shared/SupportContact";

import { passwordMessage } from "./passwordMessages";

export type PasswordMode = "login" | "register" | "reset";
const MODE_COPY: Record<Exclude<PasswordMode, "login">, string> = {
  register: "Verify your email, then choose a password. Your administrator can assign licenses after registration.",
  // Reworded (dropped "verified"): an admin-created account with an unverified login email also
  // recovers, and verifies that address, through this same reset -- see PasswordSettings.tsx.
  reset: "We’ll email a reset link to your login address. You can also recover through a connected Google or GitHub account.",
};
const SUBMIT_LABEL: Record<PasswordMode, string> = {
  login: "Sign in",
  register: "Send verification link",
  reset: "Send reset link",
};

export function PasswordSignIn({ onSignedIn, mode, onModeChange, emailLinks }: { onSignedIn(): Promise<boolean>; mode: PasswordMode; onModeChange(mode: PasswordMode): void; emailLinks: boolean }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<React.ReactNode>("");
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api(`/portal/v1/auth/password/${mode}`, {
        method: "POST", body: JSON.stringify(mode === "login" ? { email, password } : { email }),
      });
      setPassword("");
      if (result.ok && mode === "login") await onSignedIn();
      else if (result.ok) setMessage("Check your email. If this address is eligible, you’ll receive a link valid for 15 minutes. Check spam too. You can resend after one minute.");
      else setMessage(passwordMessage(result.code, result.retryAfter));
    } catch {
      setPassword("");
      setMessage("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const switchMode = (nextMode: PasswordMode): void => {
    onModeChange(nextMode);
    setPassword("");
    setMessage("");
  };
  return <section className="passwordSignIn" aria-label="Email and password">
    <form onSubmit={(event) => void submit(event)}>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      {mode === "login" ? <label>Password<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label> : <p>{MODE_COPY[mode]}</p>}
      {message && <p role="alert">{message}</p>}
      <button className="primary" disabled={busy} type="submit">{busy ? "Please wait…" : SUBMIT_LABEL[mode]}</button>
      {(emailLinks || mode !== "login") && <button disabled={busy} type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Create an account" : "Back to sign in"}</button>}
    </form>
    {mode === "login" && (emailLinks
      ? <button disabled={busy} type="button" onClick={() => switchMode("reset")}>Forgot your password?</button>
      // Password-only mode (password configured, no email delivery -- no reset email can ever be
      // sent): a support-contact sentence replaces the now-impossible email-based reset entirely.
      : <p><SupportContact /> to reset your password.</p>)}
  </section>;
}
