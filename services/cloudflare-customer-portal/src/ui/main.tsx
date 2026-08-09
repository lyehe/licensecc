import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ACTIVATION_DOWNLOAD_ACTION_LABEL,
  ACTIVATION_DOWNLOAD_DISCLOSURE,
  DEVICE_KEY_HELP_COPY,
  DEVICE_RELEASE_ACTION_LABEL,
  DEVICE_RELEASE_CONFIRM_COPY,
  describeResultCode,
  FLOATING_SEAT_RELEASE_CONFIRM_COPY,
  FLOATING_SEAT_RELEASE_CONFIRM_TITLE,
  authRequestPath,
  authVerifyPath,
  checkoutPath,
  deviceReleasePath,
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
  NO_DEVICES_EMPTY_COPY,
  NO_DOWNLOADS_EMPTY_COPY,
  NO_ENTITLEMENTS_EMPTY_COPY,
  NO_USAGE_EMPTY_COPY,
  normalizeCode,
  normalizeEmail,
  OTP_EXPIRY_COPY,
  releasePath,
  RESEND_CODE_ACTION_LABEL,
  SeatSession,
  SEATS_KEY,
  serializeSeatSessions,
  hydrateSeatSessions,
  shortHash,
  usagePath,
} from "./portalWorkflow";
import type { ApiEnvelope } from "../shared/api";
import "./styles.css";

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

// A status line carries the raw envelope code + request_id (kept as small print for support and so
// existing e2e regexes still match the raw code) plus `ok` so success and failure render distinctly.
interface StatusMessage {
  code: string;
  request_id: string;
  ok: boolean;
}

function resultMessage(result: ApiEnvelope<unknown>): StatusMessage {
  return { code: result.code, request_id: result.request_id, ok: result.ok };
}

// Client-side (pre-network) codes have no request_id; ok gates the visual treatment.
function localMessage(code: string, ok: boolean): StatusMessage {
  return { code, request_id: "", ok };
}

// role="status" makes the polite live region announce every update to assistive tech. The humanized
// copy leads; the raw code + request_id trails as small print so support can still triage by code.
function StatusLine({ message, fallback }: { message: StatusMessage | null; fallback: string }): React.ReactElement {
  if (message === null) {
    return <p role="status" className="statusline">{fallback}</p>;
  }
  const human = describeResultCode(message.code);
  const detail = message.request_id === "" ? message.code : `${message.code} (${message.request_id})`;
  return (
    <p role="status" className={message.ok ? "statusline" : "statusline error"}>
      {human ?? message.code}
      <small> {detail}</small>
    </p>
  );
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

// localStorage is best-effort: reads/writes are wrapped so a disabled/quota-exceeded store (private
// mode, storage-partitioning) never crashes the SPA — seat persistence just degrades to in-memory.
// The pure hydrate/serialize helpers live in portalWorkflow.ts; these are the only window touchpoints.
function readStoredSeats(): string | null {
  try {
    return window.localStorage.getItem(SEATS_KEY);
  } catch {
    return null;
  }
}

function writeStoredSeats(json: string): void {
  try {
    window.localStorage.setItem(SEATS_KEY, json);
  } catch {
    // Storage unavailable — persistence is best-effort; the in-memory map is still authoritative.
  }
}

function App(): React.ReactElement {
  // Auth state machine: anonymous -> "request" (enter email) -> "verify" (enter 8-digit code) ->
  // authed (me resolved). A magic-redeem lands the browser authed at "/" so the first me() succeeds.
  const [phase, setPhase] = useState<"loading" | "request" | "verify" | "authed">("loading");
  const [me, setMe] = useState<PortalMe | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [activeTab, setActiveTab] = useState<Tab>("entitlements");
  const [entitlements, setEntitlements] = useState<EntitlementRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  // Hydrate seat sessions from localStorage on mount so a page reload does not orphan a live seat
  // (finding 16): without this the Release/Refresh buttons disable forever and the seat burns until
  // heartbeat-grace or an admin force-release. Leases already past their deadline are dropped.
  const [seatSessions, setSeatSessionsRaw] = useState<Record<string, SeatSession>>(
    () => hydrateSeatSessions(readStoredSeats(), Math.floor(Date.now() / 1000)),
  );
  // Every seat-map mutation rides through this wrapper so the persisted copy stays in lockstep with
  // state. Release/heartbeat handlers already delete/update entries — they inherit persistence here.
  const setSeatSessions = (update: React.SetStateAction<Record<string, SeatSession>>): void => {
    setSeatSessionsRaw((current) => {
      const next = typeof update === "function"
        ? (update as (prev: Record<string, SeatSession>) => Record<string, SeatSession>)(current)
        : update;
      writeStoredSeats(serializeSeatSessions(next));
      return next;
    });
  };
  const [downloadDeviceKeys, setDownloadDeviceKeys] = useState<Record<string, string>>({});
  const [pendingSeatRelease, setPendingSeatRelease] = useState<{ item: EntitlementRow; session: SeatSession } | null>(null);
  const [seatReleaseFocusId, setSeatReleaseFocusId] = useState<string | null>(null);
  const seatReleaseDialogRef = useRef<HTMLDivElement>(null);
  const seatReleaseReturnFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseDeferredFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseConfirmingRef = useRef(false);
  const seatStartButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seatCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

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
    if (failed) setMessage(resultMessage(failed));
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

  async function submitVerify(event: FormEvent): Promise<void> {
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
        // The server set the HttpOnly cookie; me() now succeeds and lands the dashboard.
        setCode("");
        await loadMe();
      }
    });
  }

  async function logout(): Promise<void> {
    await runOnce(async () => {
      const result = await api(logoutPath(), { method: "POST", body: "{}" });
      setMessage(resultMessage(result));
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
  ): Promise<boolean> {
    let succeeded = false;
    await runOnce(async () => {
      const existing = seatSessions[item.id];
      if ((operation === "heartbeat" || operation === "release") && existing === undefined) {
        setMessage(localMessage("seat_not_checked_out", false));
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
      setMessage(resultMessage(result));
      const resultData = result.data;
      // The backend checkout/heartbeat body carries `expires_at` (epoch seconds, the lease deadline);
      // capture it so a post-reload hydrate can drop the entry once the seat is actually stale.
      const leaseExpiresAt = typeof resultData?.expires_at === "number" ? resultData.expires_at : 0;
      const seatId = typeof resultData?.seat_id === "string" ? resultData.seat_id : null;
      if (result.ok) {
        if (operation === "checkout" && seatId !== null) {
          setSeatSessions((current) => ({
            ...current,
            [item.id]: { seat_id: seatId, client_instance_id: clientInstanceId, expires_at: leaseExpiresAt },
          }));
        }
        if (operation === "heartbeat" && existing !== undefined) {
          // Refresh the persisted deadline so the extended lease is not pruned on the next reload.
          setSeatSessions((current) => {
            const prior = current[item.id];
            if (prior === undefined) return current;
            return { ...current, [item.id]: { ...prior, expires_at: leaseExpiresAt } };
          });
        }
        if (operation === "release") {
          setSeatSessions((current) => {
            const next = { ...current };
            delete next[item.id];
            return next;
          });
        }
        await refreshData();
        succeeded = true;
      }
    });
    return succeeded;
  }

  function requestSeatRelease(item: EntitlementRow): void {
    if (busyRef.current) return;
    const session = seatSessions[item.id];
    if (session === undefined) {
      setMessage(localMessage("seat_not_checked_out", false));
      return;
    }
    seatReleaseReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingSeatRelease({ item, session });
  }

  function dismissSeatRelease(): void {
    if (seatReleaseConfirmingRef.current) return;
    setPendingSeatRelease(null);
    const returnFocus = seatReleaseReturnFocusRef.current;
    seatReleaseDeferredFocusRef.current = returnFocus;
    seatReleaseReturnFocusRef.current = null;
  }

  async function confirmSeatRelease(): Promise<void> {
    const pending = pendingSeatRelease;
    if (pending === null || seatReleaseConfirmingRef.current || busyRef.current) return;
    const returnFocus = seatReleaseReturnFocusRef.current;
    seatReleaseConfirmingRef.current = true;
    try {
      // Keep the established seatAction path/body/auth and success/error refresh behavior. The
      // captured context only gates the explicit confirmation; it does not add a reason/body field.
      const succeeded = await seatAction(pending.item, "release");
      if (succeeded) {
        setSeatReleaseFocusId(pending.item.id);
      } else {
        seatReleaseDeferredFocusRef.current = returnFocus;
      }
      setPendingSeatRelease(null);
    } finally {
      seatReleaseConfirmingRef.current = false;
      seatReleaseReturnFocusRef.current = null;
    }
  }

  useEffect(() => {
    if (pendingSeatRelease === null) return;
    const dialog = seatReleaseDialogRef.current;
    if (dialog === null) return;
    const focusableSelector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])";
    const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !seatReleaseConfirmingRef.current) {
        event.preventDefault();
        dismissSeatRelease();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingSeatRelease]);

  useEffect(() => {
    if (pendingSeatRelease !== null) return;
    const deferredFocus = seatReleaseDeferredFocusRef.current;
    if (deferredFocus !== null) {
      seatReleaseDeferredFocusRef.current = null;
      deferredFocus.focus();
    }
  }, [pendingSeatRelease]);

  useEffect(() => {
    if (seatReleaseFocusId === null || pendingSeatRelease !== null || seatSessions[seatReleaseFocusId] !== undefined) return;
    const startButton = seatStartButtonRefs.current[seatReleaseFocusId];
    if (startButton !== null && !startButton.disabled) {
      startButton.focus();
    } else {
      seatCardRefs.current[seatReleaseFocusId]?.focus();
    }
    setSeatReleaseFocusId(null);
  }, [entitlements, pendingSeatRelease, seatReleaseFocusId, seatSessions]);

  async function releaseDevice(item: DeviceRow): Promise<void> {
    // Consequence-stating confirm so a device is never released by reflex (the app on it must re-activate).
    if (!window.confirm(DEVICE_RELEASE_CONFIRM_COPY)) return;
    await runOnce(async () => {
      const result = await api<Record<string, unknown>>(deviceReleasePath(), {
        method: "POST",
        body: JSON.stringify({ device_key_id: item.device_key_id }),
      });
      setMessage(resultMessage(result));
      if (result.ok) {
        // The device drops off GET /devices; refresh so the row disappears immediately.
        await refreshData();
      }
    });
  }

  async function download(item: EntitlementRow): Promise<void> {
    await runOnce(async () => {
      const deviceKeyId = (downloadDeviceKeys[item.id] ?? "").trim();
      if (deviceKeyId === "") {
        setMessage(localMessage("device_key_required", false));
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
          setMessage(resultMessage(result));
        } catch {
          setMessage(localMessage(`download_failed_${response.status}`, false));
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
      setMessage(localMessage("download_started", true));
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
            <StatusLine message={message} fallback="sign in to manage your licenses" />
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
              <p className="muted">{OTP_EXPIRY_COPY}</p>
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
                <button disabled={busy} type="button" onClick={() => void resendCode()}>{RESEND_CODE_ACTION_LABEL}</button>
                <button disabled={busy} type="button" onClick={() => { setPhase("request"); setMessage(null); }}>Use a different email</button>
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
    <>
    <main aria-hidden={pendingSeatRelease !== null ? "true" : undefined} inert={pendingSeatRelease !== null ? true : undefined}>
      <header className="topbar">
        <div>
          <h1>licensecc customer portal</h1>
          <StatusLine message={message} fallback="ready" />
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
          {entitlements.length === 0 && <p className="muted">{NO_ENTITLEMENTS_EMPTY_COPY}</p>}
        </section>
      )}

      {activeTab === "devices" && (
        <section className="tablePane full">
          <h2>My devices &amp; seats</h2>
          <table>
            <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Device</th><th>Since</th><th>Actions</th></tr></thead>
            <tbody>
              {devices.map((item, index) => (
                <tr key={`${item.device_key_id}/${index}`}>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{shortHash(item.license_fingerprint)}</code></td>
                  <td><code>{shortHash(item.device_key_id)}</code></td>
                  <td>{formatTimestamp(item.created_at)}</td>
                  <td className="actions">
                    <button disabled={busy} onClick={() => void releaseDevice(item)}>{DEVICE_RELEASE_ACTION_LABEL}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices.length === 0 && <p className="muted">{NO_DEVICES_EMPTY_COPY}</p>}
          {floatingEntitlements.length > 0 && (
            <div className="seatGrid">
              <h2>Seats by entitlement</h2>
              {floatingEntitlements.map((item, index) => (
                <div
                  className="seatCard"
                  key={`seat/${item.id}/${index}`}
                  ref={(element) => { seatCardRefs.current[item.id] = element; }}
                  tabIndex={-1}
                >
                  <div>
                    <strong>{item.project}</strong>
                    <span className="muted"> / {item.feature}</span>
                    <span className="muted"> pool {item.pool_size}</span>
                  </div>
                  <div className="actions">
                    <button
                      ref={(element) => { seatStartButtonRefs.current[item.id] = element; }}
                      disabled={busy || item.status !== "active" || seatSessions[item.id] !== undefined}
                      onClick={() => void seatAction(item, "checkout")}
                    >Start seat</button>
                    <button disabled={busy || item.status !== "active" || seatSessions[item.id] === undefined} onClick={() => void seatAction(item, "heartbeat")}>Refresh</button>
                    <button disabled={busy || seatSessions[item.id] === undefined} onClick={() => requestSeatRelease(item)}>Release</button>
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
            {usage.length === 0 && <p className="muted">{NO_USAGE_EMPTY_COPY}</p>}
          </section>
        </section>
      )}

      {activeTab === "download" && (
        <section className="tablePane full">
          <h2>Download licenses</h2>
          <p className="muted">{ACTIVATION_DOWNLOAD_DISCLOSURE}</p>
          <p className="muted">{DEVICE_KEY_HELP_COPY}</p>
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
          {downloadableEntitlements.length === 0 && <p className="muted">{NO_DOWNLOADS_EMPTY_COPY}</p>}
        </section>
      )}

    </main>
    {pendingSeatRelease !== null && createPortal((
        <div className="modalOverlay" role="presentation">
          <div
            ref={seatReleaseDialogRef}
            className="modal danger"
            role="dialog"
            aria-modal="true"
            aria-labelledby="floatingSeatReleaseTitle"
            aria-describedby="floatingSeatReleaseDescription"
            tabIndex={-1}
          >
            <h2 id="floatingSeatReleaseTitle">{FLOATING_SEAT_RELEASE_CONFIRM_TITLE}</h2>
            <p id="floatingSeatReleaseDescription">{FLOATING_SEAT_RELEASE_CONFIRM_COPY}</p>
            <dl className="releaseContext">
              <div>
                <dt>License</dt>
                <dd>{pendingSeatRelease.item.project} / {pendingSeatRelease.item.feature}</dd>
              </div>
              <div>
                <dt>License fingerprint</dt>
                <dd><code>{pendingSeatRelease.item.license_fingerprint ? shortHash(pendingSeatRelease.item.license_fingerprint) : "-"}</code></dd>
              </div>
              <div>
                <dt>Seat</dt>
                <dd><code>{pendingSeatRelease.session.seat_id}</code></dd>
              </div>
              <div>
                <dt>Device</dt>
                <dd><code>{pendingSeatRelease.session.client_instance_id}</code></dd>
              </div>
            </dl>
            <div className="actions">
              <button type="button" disabled={busy} onClick={dismissSeatRelease}>Cancel</button>
              <button type="button" className="danger" disabled={busy} onClick={() => void confirmSeatRelease()}>Confirm release</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
