import React, { useLayoutEffect, useRef, useState } from "react";
import { localMessage, StatusLine } from "../shared/api";
import { useSingleFlight } from "../shared/useSingleFlight";
import { AuthFeature, usePortalAuth } from "../features/auth/AuthFeature";
import { usePortalData } from "../features/data/usePortalData";
import { DEVICES_REFRESH_ACTION_LABEL, DEVICES_REFRESH_FAILURE_CODE, DevicesFeature, SeatReleaseDialog, useDevicesController } from "../features/devices/DevicesFeature";
import { DownloadsFeature, useLicenseDownloads } from "../features/downloads/DownloadsFeature";
import { EntitlementsFeature } from "../features/entitlements/EntitlementsFeature";
import { UsageFeature } from "../features/usage/UsageFeature";
import type { PortalTab as Tab, StatusMessage } from "../types";
import "../styles.css";

export function App(): React.ReactElement {
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const { busy, busyRef, runOnce } = useSingleFlight();
  const auth = usePortalAuth({ setMessage, runOnce });

  const [activeTab, setActiveTab] = useState<Tab>("entitlements");
  const { entitlements, devices, usage, refreshData, clear: clearPortalData } = usePortalData({
    active: auth.phase === "authed",
    setMessage,
  });
  const downloads = useLicenseDownloads({ runOnce, setMessage });
  const deviceController = useDevicesController({
    busy,
    busyRef,
    devices,
    entitlements,
    refreshData,
    runOnce,
    setMessage,
  });
  const refreshFocusRef = useRef<HTMLElement | null>(null);
  const activeTabButtonRef = useRef<HTMLButtonElement | null>(null);

  async function refreshPortalData(): Promise<void> {
    if (busyRef.current) return;
    refreshFocusRef.current = activeTabButtonRef.current;
    await runOnce(async () => {
      try {
        if (await refreshData()) {
          setMessage(null);
        } else {
          setMessage(localMessage(DEVICES_REFRESH_FAILURE_CODE, false));
        }
      } catch {
        setMessage(localMessage(DEVICES_REFRESH_FAILURE_CODE, false));
      }
    });
  }

  useLayoutEffect(() => {
    if (busy || refreshFocusRef.current === null) return;
    const target = refreshFocusRef.current;
    refreshFocusRef.current = null;
    if (document.contains(target) && !target.hasAttribute("disabled")) target.focus();
  }, [busy, message]);

  async function logout(): Promise<void> {
    await auth.logout(() => {
      clearPortalData();
      deviceController.clear();
      downloads.clear();
    });
  }

  if (auth.phase !== "authed") return <AuthFeature auth={auth} busy={busy} message={message} />;

  return (
    <>
    <main aria-hidden={deviceController.pendingSeatRelease !== null ? "true" : undefined} inert={deviceController.pendingSeatRelease !== null ? true : undefined}>
      <header className="topbar">
        <div>
          <h1>licensecc customer portal</h1>
          <StatusLine message={message} fallback="ready" />
        </div>
        <nav>
          {message?.code === DEVICES_REFRESH_FAILURE_CODE && (
            <button disabled={busy} onClick={() => void refreshPortalData()}>{DEVICES_REFRESH_ACTION_LABEL}</button>
          )}
          <button ref={activeTab === "entitlements" ? activeTabButtonRef : undefined} className={activeTab === "entitlements" ? "active" : ""} onClick={() => setActiveTab("entitlements")}>My entitlements</button>
          <button ref={activeTab === "devices" ? activeTabButtonRef : undefined} className={activeTab === "devices" ? "active" : ""} onClick={() => setActiveTab("devices")}>My devices</button>
          <button ref={activeTab === "usage" ? activeTabButtonRef : undefined} className={activeTab === "usage" ? "active" : ""} onClick={() => setActiveTab("usage")}>Usage</button>
          <button ref={activeTab === "download" ? activeTabButtonRef : undefined} className={activeTab === "download" ? "active" : ""} onClick={() => setActiveTab("download")}>Download</button>
          <button disabled={busy} onClick={() => void logout()}>Log out</button>
        </nav>
      </header>

      {activeTab === "entitlements" && (
        <EntitlementsFeature entitlements={entitlements} />
      )}

      {activeTab === "devices" && (
        <DevicesFeature controller={deviceController} />
      )}

      {activeTab === "usage" && (
        <UsageFeature entitlements={entitlements} usage={usage} />
      )}

      {activeTab === "download" && (
        <DownloadsFeature busy={busy} downloads={downloads} entitlements={entitlements} />
      )}

    </main>
    <SeatReleaseDialog controller={deviceController} />
    </>
  );
}
