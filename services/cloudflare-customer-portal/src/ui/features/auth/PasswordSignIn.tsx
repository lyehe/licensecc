import React, { useState } from "react";
import { api } from "../../shared/api";

import { passwordMessage } from "./passwordMessages";

export function PasswordSignIn({ onSignedIn }: { onSignedIn(): Promise<boolean> }): React.ReactElement {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await api(`/portal/v1/auth/password/${register ? "register" : "login"}`, {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      setPassword("");
      if (result.ok) await onSignedIn();
      else setMessage(passwordMessage(result.code));
    } catch { setPassword(""); setMessage("Unable to connect. Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="passwordSignIn" aria-label="Email and password">
    <form onSubmit={(event) => void submit(event)}>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete={register ? "new-password" : "current-password"} required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={register ? "passwordHelp" : undefined} /></label>
      {register && <p id="passwordHelp">15–128 characters. New accounts have no licenses; your email is not verified.</p>}
      {message && <p role="alert">{message}</p>}
      <button className="primary" disabled={busy} type="submit">{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button>
      <button disabled={busy} type="button" onClick={() => { setRegister(!register); setPassword(""); setMessage(""); }}>{register ? "Already have an account? Sign in" : "Create an account"}</button>
    </form>
    <details><summary>Forgot your password?</summary><p>Sign in with a connected Google or GitHub account, then change your password in Account. Otherwise, contact your administrator for recovery.</p></details>
  </section>;
}
