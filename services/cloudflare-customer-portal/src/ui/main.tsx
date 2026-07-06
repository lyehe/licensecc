import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ACTIVATION_DOWNLOAD_ACTION_LABEL,
  ACTIVATION_DOWNLOAD_DISCLOSURE,
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
  LOGIN_CODE_SENT_COPY,
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
  id: string;
  project: string;
  feature: string;
  status: string;
  license_fingerprint?: string;
  valid_from: number | null;
  valid_until: number | null;
  license_mode: "trial" | "node_locked" | "floating";
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  heartbeat_grace_sec: number;
  policy_id: string | null;
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
type SeatOperation = "checkout" | "heartbeat" | "release";

interface SeatSession {
  seat_id: string;
  client_instance_id: string;
}

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

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function seatPath(operation: SeatOperation): string {
  if (operation === "checkout") return checkoutPath();
  if (operation === "heartbeat") return heartbeatPath();
  return releasePath();
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
  const [seatSessions, setSeatSessions] = useState<Record<string, SeatSession>>({});
  const [downloadDeviceKeys, setDownloadDeviceKeys] = useState<Record<string, string>>({});

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
      setSeatSessions({});
      setDownloadDeviceKeys({});
      setEmail("");
      setCode("");
      setPhase("request");
    });
  }

  async function seatAction(
    item: EntitlementRow,
    operation: SeatOperation,
  ): Promise<void> {
    await runOnce(async () => {
      const existing = seatSessions[item.id];
      if ((operation === "heartbeat" || operation === "release") && existing === undefined) {
        setMessage("seat_not_checked_out");
        return;
      }
      const clientInstanceId = existing?.client_instance_id ?? crypto.randomUUID();
      const body: Record<string, string> = {
        entitlement_id: item.id,
        client_instance_id: clientInstanceId,
        nonce: randomHex(32),
      };
      if (existing !== undefined) body.seat_id = existing.seat_id;
      const result = await api<Record<string, unknown>>(seatPath(operation), {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMessage(errorLine(result));
      if (result.ok) {
        if (operation === "checkout" && typeof result.data?.seat_id === "string") {
          setSeatSessions((current) => ({
            ...current,
            [item.id]: { seat_id: result.data.seat_id as string, client_instance_id: clientInstanceId },
          }));
        }
        if (operation === "release") {
          setSeatSessions((current) => {
            const next = { ...current };
            delete next[item.id];
            return next;
          });
        }
        await refreshData();
      }
    });
  }

  async function download(item: EntitlementRow): Promise<void> {
    await runOnce(async () => {
      const deviceKeyId = (downloadDeviceKeys[item.id] ?? "").trim();
      if (deviceKeyId === "") {
        setMessage("device_key_required");
        return;
      }
      // The Worker converts the backend JSON `lic` field into an attachment. The browser never holds
      // a backend bearer; the body carries only the opaque entitlement id plus the activation device.
      const response = await fetch(downloadPath(), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entitlement_id: item.id, device_key_id: deviceKeyId }),
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
              <p>{LOGIN_CODE_SENT_COPY}</p>
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

  const floatingEntitlements = entitlements.filter((item) => item.license_mode === "floating");
  const downloadableEntitlements = entitlements.filter((item) => item.license_mode !== "floating");

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
            <thead><tr><th>Project</th><th>Feature</th><th>Mode</th><th>Capacity</th><th>Fingerprint</th><th>Status</th><th>Valid</th></tr></thead>
            <tbody>
              {entitlements.map((item, index) => (
                <tr key={`${item.project}/${item.feature}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td>{item.license_mode}</td>
                  <td>{item.license_mode === "floating" ? `pool ${item.pool_size}` : `devices ${item.max_active_devices}`}</td>
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
            <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Device</th><th>Since</th></tr></thead>
            <tbody>
              {devices.map((item, index) => (
                <tr key={`${item.device_key_id}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{shortHash(item.license_fingerprint)}</code></td>
                  <td><code>{shortHash(item.device_key_id)}</code></td>
                  <td>{formatTimestamp(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {floatingEntitlements.length > 0 && (
            <div className="seatGrid">
              <h2>Seats by entitlement</h2>
              {floatingEntitlements.map((item, index) => (
                <div className="seatCard" key={`seat/${item.id}/${index}`}>
                  <div>
                    <strong>{item.project}</strong>
                    <span className="muted"> / {item.feature}</span>
                    <span className="muted"> pool {item.pool_size}</span>
                  </div>
                  <div className="actions">
                    <button disabled={busy || item.status !== "active" || seatSessions[item.id] !== undefined} onClick={() => void seatAction(item, "checkout")}>Start seat</button>
                    <button disabled={busy || item.status !== "active" || seatSessions[item.id] === undefined} onClick={() => void seatAction(item, "heartbeat")}>Refresh</button>
                    <button disabled={busy || seatSessions[item.id] === undefined} onClick={() => void seatAction(item, "release")}>Release</button>
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
          <p className="muted">{ACTIVATION_DOWNLOAD_DISCLOSURE}</p>
          <table>
            <thead><tr><th>Project</th><th>Feature</th><th>Status</th><th>Valid</th><th>License</th></tr></thead>
            <tbody>
              {downloadableEntitlements.map((item, index) => (
                <tr key={`dl/${item.id}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><span className={`status ${item.status}`}>{item.status}</span></td>
                  <td>{formatWindow(item.valid_from, item.valid_until)}</td>
                  <td className="actions">
                    <input
                      aria-label={`Device key for ${item.project} ${item.feature}`}
                      placeholder="device key id"
                      value={downloadDeviceKeys[item.id] ?? ""}
                      onChange={(event) => setDownloadDeviceKeys({ ...downloadDeviceKeys, [item.id]: event.target.value })}
                    />
                    <button disabled={busy || item.status !== "active" || (downloadDeviceKeys[item.id] ?? "").trim() === ""} onClick={() => void download(item)}>{ACTIVATION_DOWNLOAD_ACTION_LABEL}</button>
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
