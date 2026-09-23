import React, { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { passwordMessage } from "../auth/passwordMessages";

type Settings = { email: string; has_password: boolean; can_reset: boolean; email_verified: boolean };
export function PasswordSettings(): React.ReactElement {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void api<Settings>("/portal/v1/auth/password").then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setSettings(result.data); else setFailed(true);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt]);
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await api("/portal/v1/auth/password", { method: "POST", body: JSON.stringify({ password, current_password: current }) });
      setCurrent(""); setPassword("");
      setMessage(result.ok ? "Password saved. Other browser sessions have been signed out." : passwordMessage(result.code));
      if (result.ok) setAttempt((value) => value + 1);
    } catch { setCurrent(""); setPassword(""); setMessage("Unable to connect. Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="tablePane full"><h2>Email and password</h2>
    {failed ? <p>Unable to load password settings. <button onClick={() => setAttempt((value) => value + 1)}>Retry password settings</button></p> : !settings ? <p>Loading password settings…</p> : <>
      <p>{settings.email || "No verified email available"}</p>
      {settings.has_password && !settings.email_verified && <p>Email not verified. Password recovery by email is unavailable.</p>}
      {!settings.has_password && !settings.can_reset ? <p>Sign in again with Google, GitHub, or an email code to set a password.</p> : <details className="passwordEditor"><summary>{settings.has_password ? "Change password" : "Set password"}</summary><form className="passwordSettings" onSubmit={(event) => void submit(event)}>
        {settings.has_password && !settings.can_reset && <label>Current password<input type="password" autoComplete="current-password" required maxLength={128} value={current} onChange={(event) => setCurrent(event.target.value)} /></label>}
        <label>New password<input type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <p>Use 15–128 characters. Saving signs out your other browser sessions.</p>
        <button type="submit" disabled={busy}>{busy ? "Saving…" : settings.has_password ? "Change password" : "Set password"}</button>
      </form></details>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
