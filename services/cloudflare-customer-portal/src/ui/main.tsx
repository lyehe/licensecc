import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  authRequestPath,
  authVerifyPath,
  checkoutPath,
  devicesPath,
  downloadPath,
  entitlementsPath,
  formatTimestamp,
  formatWindow,
  heartbeatPath,
  isLikelyEmail,
  isValidCode,
  logoutPath,
  mePath,
  normalizeCode,
  normalizeEmail,
  releasePath,
  shortHash,
  usagePath,
} from "./portalWorkflow";
import "./styles.css";

interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
}

interface PortalMe {
  customer_id: string;
}

interface EntitlementRow {
  project: string;
  feature: string;
  status: string;
  license_fingerprint?: string;
  valid_from: number | null;
  valid_until: number | null;
}

interface DeviceRow {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_key_id: string;
  created_at: number;
}

interface UsageRow {
  project: string;
  feature: string;
  event_type: string;
  count: number;
}

type Tab = "entitlements" | "devices" | "usage" | "download";

// Invariant 3: ALWAYS credentials:"same-origin" (the HttpOnly session cookie travels automatically),
// ALWAYS content-type: application/json, and NEVER an Authorization/bearer header — the browser never
// holds the backend lcca_ token. This helper is the single network chokepoint for the SPA.
async function api<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return { ok: false, code: "invalid_response", request_id: "" };
  }
}

function errorLine(result: ApiEnvelope<unknown>): string {
  // Render exactly like admin: "code (request_id)".
  return `${result.code} (${result.request_id})`;
}

function App(): React.ReactElement {
  // Auth state machine: anonymous -> "request" (enter email) -> "verify" (enter 8-digit code) ->
  // authed (me resolved). A magic-redeem lands the browser authed at "/" so the first me() succeeds.
  const [phase, setPhase] = useState<"loading" | "request" | "verify" | "authed">("loading");
  const [me, setMe] = useState<PortalMe | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [activeTab, setActiveTab] = useState<Tab>("entitlements");
  const [entitlements, setEntitlements] = useState<EntitlementRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);

  async function loadMe(): Promise<boolean> {
    const result = await api<PortalMe>(mePath());
    if (result.ok && result.data) {
      setMe(result.data);
      setPhase("authed");
      return true;
    }
    setPhase("request");
    return false;
  }

  // On first paint, try the existing cookie (covers the post-magic-redeem landing): me() ok -> authed.
  useEffect(() => {
    void loadMe();
  }, []);

  async function refreshData(): Promise<void> {
    const [entitlementResponse, deviceResponse, usageResponse] = await Promise.all([
      api<{ items: EntitlementRow[] }>(entitlementsPath()),
      api<{ items: DeviceRow[] }>(devicesPath()),
      api<{ items: UsageRow[] }>(usagePath()),
    ]);
    if (entitlementResponse.ok && entitlementResponse.data) setEntitlements(entitlementResponse.data.items);
    if (deviceResponse.ok && deviceResponse.data) setDevices(deviceResponse.data.items);
    if (usageResponse.ok && usageResponse.data) setUsage(usageResponse.data.items);
    const failed = [entitlementResponse, deviceResponse, usageResponse].find((item) => !item.ok);
    if (failed) setMessage(errorLine(failed));
  }

  useEffect(() => {
    if (phase === "authed") {
      void refreshData();
    }
  }, [phase]);

  async function runOnce(work: () => Promise<void>): Promise<void> {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitRequest(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runOnce(async () => {
      const normalized = normalizeEmail(email);
      if (!isLikelyEmail(normalized)) {
        setMessage("invalid_email");
        return;
      }
      const result = await api(authRequestPath(), {
        method: "POST",
        body: JSON.stringify({ email: normalized }),
      });
      setMessage(errorLine(result));
      if (result.ok) {
        setEmail(normalized);
        setPhase("verify");
      }
    });
  }

  async function submitVerify(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runOnce(async () => {
      const normalized = normalizeCode(code);
      if (!isValidCode(normalized)) {
        setMessage("invalid_code");
        return;
      }
      const result = await api(authVerifyPath(), {
        method: "POST",
        body: JSON.stringify({ email: normalizeEmail(email), code: normalized }),
      });
      setMessage(errorLine(result));
      if (result.ok) {
        // The server set the HttpOnly cookie; me() now succeeds and lands the dashboard.
        setCode("");
        await loadMe();
      }
    });
  }

  async function logout(): Promise<void> {
    await runOnce(async () => {
      const result = await api(logoutPath(), { method: "POST", body: "{}" });
      setMessage(errorLine(result));
      setMe(null);
      setEntitlements([]);
      setDevices([]);
      setUsage([]);
      setEmail("");
      setCode("");
      setPhase("request");
    });
  }

  async function seatAction(
    item: { project: string; feature: string },
    path: string,
  ): Promise<void> {
    await runOnce(async () => {
      // Body is ONLY project + feature — the Worker server-resolves the fingerprint (invariant 4).
      const result = await api(path, {
        method: "POST",
        body: JSON.stringify({ project: item.project, feature: item.feature }),
      });
      setMessage(errorLine(result));
      if (result.ok) {
        await refreshData();
      }
    });
  }

  async function download(item: { project: string; feature: string }): Promise<void> {
    await runOnce(async () => {
      // The Worker streams the signed .lic as an attachment. Body is project+feature only; the
      // browser never parses or signs — it just saves the bytes. No Authorization header (invariant 3).
      const response = await fetch(downloadPath(), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: item.project, feature: item.feature }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || contentType.includes("application/json")) {
        try {
          const result = (await response.json()) as ApiEnvelope<unknown>;
          setMessage(errorLine(result));
        } catch {
          setMessage(`download_failed (${response.status})`);
        }
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${item.project}-${item.feature}.lic`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage("download_started");
    });
  }

  if (phase === "loading") {
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

  if (phase !== "authed") {
    return (
      <main>
        <header className="topbar">
          <div>
            <h1>licensecc customer portal</h1>
            <p>{message || "sign in to manage your licenses"}</p>
          </div>
        </header>
        <section className="authPane">
          {phase === "request" && (
            <form onSubmit={(event) => void submitRequest(event)}>
              <h2>Sign in</h2>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <button disabled={busy} type="submit">Send code</button>
            </form>
          )}
          {phase === "verify" && (
            <form onSubmit={(event) => void submitVerify(event)}>
              <h2>Check your email</h2>
              <p>We sent an 8-digit code to {email}. Enter it below.</p>
              <label>
                8-digit code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <div className="actions">
                <button disabled={busy} type="submit">Verify</button>
                <button disabled={busy} type="button" onClick={() => { setPhase("request"); setMessage(""); }}>Use a different email</button>
              </div>
            </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>licensecc customer portal</h1>
          <p>{message || "ready"}</p>
        </div>
        <nav>
          <button className={activeTab === "entitlements" ? "active" : ""} onClick={() => setActiveTab("entitlements")}>My entitlements</button>
          <button className={activeTab === "devices" ? "active" : ""} onClick={() => setActiveTab("devices")}>My devices</button>
          <button className={activeTab === "usage" ? "active" : ""} onClick={() => setActiveTab("usage")}>Usage</button>
          <button className={activeTab === "download" ? "active" : ""} onClick={() => setActiveTab("download")}>Download</button>
          <button disabled={busy} onClick={() => void logout()}>Log out</button>
        </nav>
      </header>

      {activeTab === "entitlements" && (
        <section className="tablePane full">
          <h2>My entitlements</h2>
          <table>
            <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Status</th><th>Valid</th></tr></thead>
            <tbody>
              {entitlements.map((item, index) => (
                <tr key={`${item.project}/${item.feature}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{item.license_fingerprint ? shortHash(item.license_fingerprint) : "-"}</code></td>
                  <td><span className={`status ${item.status}`}>{item.status}</span></td>
                  <td>{formatWindow(item.valid_from, item.valid_until)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === "devices" && (
        <section className="tablePane full">
          <h2>My devices &amp; seats</h2>
          <table>
            <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Device</th><th>Since</th><th>Seat actions</th></tr></thead>
            <tbody>
              {devices.map((item, index) => (
                <tr key={`${item.device_key_id}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{shortHash(item.license_fingerprint)}</code></td>
                  <td><code>{shortHash(item.device_key_id)}</code></td>
                  <td>{formatTimestamp(item.created_at)}</td>
                  <td className="actions">
                    <button disabled={busy} onClick={() => void seatAction(item, checkoutPath())}>Checkout</button>
                    <button disabled={busy} onClick={() => void seatAction(item, heartbeatPath())}>Heartbeat</button>
                    <button disabled={busy} onClick={() => void seatAction(item, releasePath())}>Release</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entitlements.length > 0 && (
            <div className="seatGrid">
              <h2>Seats by entitlement</h2>
              {entitlements.map((item, index) => (
                <div className="seatCard" key={`seat/${item.project}/${item.feature}/${index}`}>
                  <div>
                    <strong>{item.project}</strong>
                    <span className="muted"> / {item.feature}</span>
                  </div>
                  <div className="actions">
                    <button disabled={busy} onClick={() => void seatAction(item, checkoutPath())}>Checkout</button>
                    <button disabled={busy} onClick={() => void seatAction(item, heartbeatPath())}>Heartbeat</button>
                    <button disabled={busy} onClick={() => void seatAction(item, releasePath())}>Release</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "usage" && (
        <section className="usagePane">
          <section className="grid metrics">
            <div><span>Tracked tuples</span><strong>{usage.length}</strong></div>
            <div><span>Total events</span><strong>{usage.reduce((sum, item) => sum + (Number(item.count) || 0), 0)}</strong></div>
            <div><span>Event types</span><strong>{new Set(usage.map((item) => item.event_type)).size}</strong></div>
            <div><span>Entitlements</span><strong>{entitlements.length}</strong></div>
          </section>
          <section className="tablePane full">
            <h2>Recent usage</h2>
            <table>
              <thead><tr><th>Project</th><th>Feature</th><th>Event</th><th>Count</th></tr></thead>
              <tbody>
                {usage.map((item, index) => (
                  <tr key={`${item.project}/${item.feature}/${item.event_type}/${index}`}>
                    <td>{item.project}</td>
                    <td>{item.feature}</td>
                    <td>{item.event_type}</td>
                    <td>{item.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </section>
      )}

      {activeTab === "download" && (
        <section className="tablePane full">
          <h2>Download licenses</h2>
          <table>
            <thead><tr><th>Project</th><th>Feature</th><th>Status</th><th>Valid</th><th>License</th></tr></thead>
            <tbody>
              {entitlements.map((item, index) => (
                <tr key={`dl/${item.project}/${item.feature}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><span className={`status ${item.status}`}>{item.status}</span></td>
                  <td>{formatWindow(item.valid_from, item.valid_until)}</td>
                  <td className="actions">
                    <button disabled={busy} onClick={() => void download(item)}>Download .lic</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
