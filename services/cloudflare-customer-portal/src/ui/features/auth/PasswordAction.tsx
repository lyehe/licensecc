import React, { useState } from "react";
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

export function PasswordAction({ token, onDone }: { token: string; onDone(): Promise<void> }): React.ReactElement {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(token ? "" : "Open the link from your email again, or request a new link.");
  const [finished, setFinished] = useState(false);
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setMessage("Passwords do not match."); return; }
    setBusy(true); setMessage("");
    try {
      const result = await api("/portal/v1/auth/password/complete", { method: "POST", body: JSON.stringify({ token, password }) });
      setPassword(""); setConfirmation("");
      if (result.ok && result.code === "password_updated") { setFinished(true); setMessage("Password saved. Sign in with your new password."); }
      else if (result.ok) { setFinished(true); await onDone(); }
      else setMessage(passwordActionMessage(result.code));
    } catch { setMessage("Unable to connect. Please try again."); }
    finally { setPassword(""); setConfirmation(""); setBusy(false); }
  }
  return <main className="authPane"><section className="authCard">
    <h1>Choose your password</h1>
    <p>15–128 characters. Use a password you don’t use elsewhere.</p>
    {message && <p role="alert">{message}</p>}
    {token && !finished && <form onSubmit={event => void submit(event)}>
      <label>New password<input type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label>Confirm password<input type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save password and sign in"}</button>
    </form>}
    <a href="/">Back to sign in</a>
  </section></main>;
}
