import React, { useLayoutEffect, useRef, useState } from "react";
import { api } from "../../shared/api";
import { passwordActionMessage } from "./passwordMessages";

// Capture before any effects/requests. Fragments never reach the server; remove
// the bearer immediately from browser history and retain it only in memory.
export function capturePasswordAction(): string | null {
  if (window.location.pathname !== "/password-action") return null;
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
  window.history.replaceState(null, "", "/password-action");
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
}

export function PasswordAction({ token, onDone }: { token: string; onDone(): Promise<boolean> }): React.ReactElement {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<React.ReactNode>(token ? "" : "Open the link from your email again, or request a new link.");
  // Told apart from the "Password saved" confirmation below so only an actual failure gets the
  // error colour -- both currently share this one message slot and role="alert". A
  // missing/malformed token is itself a failure.
  const [messageIsError, setMessageIsError] = useState(!token);
  const [finished, setFinished] = useState(false);
  const [confirmSignIn, setConfirmSignIn] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);
  async function confirmSession(): Promise<void> {
    setBusy(true);
    try {
      if (!await onDone()) {
        setConfirmSignIn(true);
        setMessage("Password saved. We couldn't confirm your sign-in. Try confirming again, or go back to sign in.");
      }
    } catch {
      setConfirmSignIn(true);
      setMessage("Password saved. We couldn't confirm your sign-in. Try confirming again, or go back to sign in.");
    } finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setMessage("Passwords do not match."); setMessageIsError(true); return; }
    setBusy(true); setMessage(""); setMessageIsError(false);
    try {
      const result = await api<{ customer_id: string }>("/portal/v1/auth/password/complete", { method: "POST", body: JSON.stringify({ token, password }) });
      setPassword(""); setConfirmation("");
      if (result.ok && result.code === "password_updated") { setFinished(true); setMessage("Password saved. Sign in with your new password."); }
      else if (result.ok && result.code === "signed_in" && typeof result.data?.customer_id === "string" && result.data.customer_id) {
        setFinished(true); await confirmSession();
      }
      else if (result.ok) {
        // An undocumented success is not proof of sign-in. The token may have been consumed;
        // leave this screen terminal rather than inviting a second password write.
        setFinished(true); setMessage("The server returned an unexpected result. Go back to sign in, or request a new password link."); setMessageIsError(true);
      }
      else { setMessage(passwordActionMessage(result.code, result.retryAfter)); setMessageIsError(true); }
    } catch { setMessage("Unable to connect. Please try again."); setMessageIsError(true); }
    finally { setPassword(""); setConfirmation(""); setBusy(false); }
  }
  return <main className="authPane"><section className="authCard">
    <h1 ref={heading} tabIndex={-1}>Choose your password</h1>
    <p>15–128 characters. Use a password you don't use elsewhere.</p>
    {message && <p role="alert" className={messageIsError ? "statusline error" : "statusline"}>{message}</p>}
    {token && !finished && <form onSubmit={event => void submit(event)}>
      <label>New password<input type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label>Confirm password<input type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
    </form>}
    {confirmSignIn && <button type="button" disabled={busy} onClick={() => void confirmSession()}>{busy ? "Confirming…" : "Confirm sign-in"}</button>}
    <a href="/">Back to sign in</a>
  </section></main>;
}
