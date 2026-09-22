import React, { useLayoutEffect, useRef, useState } from "react";
import { localMessage, StatusLine } from "../shared/api";
import { useSingleFlight } from "../shared/useSingleFlight";
import { AuthFeature, usePortalAuth } from "../features/auth/AuthFeature";
import { PasswordAction, capturePasswordAction } from "../features/auth/PasswordAction";
import { usePortalData } from "../features/data/usePortalData";
import { DEVICES_REFRESH_ACTION_LABEL, DEVICES_REFRESH_FAILURE_CODE, DevicesFeature, SeatReleaseDialog, useDevicesController } from "../features/devices/DevicesFeature";
import { useLicenseDownloads } from "../features/downloads/DownloadsFeature";
import { AppsFeature } from "../features/apps/AppsFeature";
import { AccountFeature } from "../features/account/AccountFeature";
import { ConsentFeature } from "../features/consent/ConsentFeature";
import { ProtectedNodes } from "../features/devices/ProtectedNodes";
import { captureEnrollment, clearEnrollment } from "../features/consent/pending";
import { usePortalLocation } from "../shared/navigation";
import type { StatusMessage } from "../types";
import "../styles.css";

export function App(): React.ReactElement {
  const [passwordAction, setPasswordAction] = useState(capturePasswordAction);
  const [enrollment,setEnrollment] = useState(captureEnrollment);
  useLayoutEffect(() => {
    const capture = ():void => {
      const url = new URL(window.location.href);
      if (new URLSearchParams(url.hash.slice(1)).has("attempt_handle") || (url.pathname === "/connect" && url.hash !== "")) {
        const captured=captureEnrollment();setEnrollment(captured);
        if(captured && typeof captured!=="string")void auth.retrySession();
      }
    };
    window.addEventListener("hashchange",capture);
    return () => window.removeEventListener("hashchange",capture);
  },[]);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const { busy, busyRef, runOnce } = useSingleFlight();
  const auth = usePortalAuth({ setMessage, runOnce });

  const location = usePortalLocation();
  const { entitlements, devices, usage, usageAvailable, readState, stale, refreshData, clear: clearPortalData } = usePortalData({
    active: auth.phase === "authed" && enrollment === null && passwordAction === null,
    setMessage,
  });
  const downloads = useLicenseDownloads({ runOnce, setMessage });
  const deviceController = useDevicesController({
    busy: busy || stale,
    busyRef,
    devices,
    entitlements,
    refreshData,
    runOnce,
    setMessage,
  });
  const refreshFocusRef = useRef<HTMLElement | null>(null);
  const activeTabButtonRef = useRef<HTMLAnchorElement | null>(null);

  useLayoutEffect(() => {
    document.getElementById("content")?.focus();
  }, [location.page, location.project]);

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
      clearEnrollment();setEnrollment(null);
      window.history.replaceState(null,"","/#/apps");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  function finishEnrollment():void {
    clearEnrollment();setEnrollment(null);window.history.replaceState(null,"","/#/apps");
  }
  if (passwordAction !== null) return <PasswordAction token={passwordAction} onDone={async () => {
    window.history.replaceState(null, "", "/#/apps");
    clearPortalData();
    await auth.retrySession();
    setPasswordAction(null);
  }} />;
  if (typeof enrollment === "string" || (enrollment && auth.phase === "authed")) return <ConsentFeature key={typeof enrollment==="string"?enrollment:`${enrollment.handle}:${enrollment.createdAt}`} entry={enrollment} customerId={auth.customerId??""} onDone={finishEnrollment} onSignOut={logout} onSessionExpired={auth.retrySession} feedback={<StatusLine message={message} fallback="" />} />;
  if (auth.phase !== "authed") return <AuthFeature auth={auth} busy={busy} message={message} connecting={enrollment!==null} />;

  return (
    <>
    <main aria-hidden={deviceController.pendingSeatRelease !== null ? "true" : undefined} inert={deviceController.pendingSeatRelease !== null ? true : undefined}>
      <a className="skipLink" href="#content" onClick={(event) => { event.preventDefault(); document.getElementById("content")?.focus(); }}>Skip to content</a>
      <header className="topbar">
        <div className="headerInner">
        <a className="brand" href="#/apps"><span aria-hidden="true">L</span>Licensecc</a>
        <nav aria-label="Main navigation">
          {(["apps", "nodes", "account"] as const).map((page) => <a key={page} ref={location.page === page ? activeTabButtonRef : undefined} href={`#/${page}`} aria-current={location.page === page ? "page" : undefined}>{page === "nodes" ? "Devices" : page[0].toUpperCase() + page.slice(1)}</a>)}
        </nav>
        <div className="signOutControl"><button disabled={busy} onClick={() => void logout()}>Sign out</button>{location.page==="account" && <p>Your apps and devices stay connected.</p>}</div>
        </div>
      </header>
      <div id="content" className="workspaceContent" tabIndex={-1}>
        {stale && readState === "ready" && <div className="readNotice"><p>Displayed data may be out of date. Refresh before making another change.</p>{message?.code !== DEVICES_REFRESH_FAILURE_CODE && <button disabled={busy} onClick={() => void refreshPortalData()}>Refresh account</button>}</div>}
        <div className="feedback">
          <StatusLine message={message} fallback="" />
          {message?.code === DEVICES_REFRESH_FAILURE_CODE && (
            <button disabled={busy} onClick={() => void refreshPortalData()}>{DEVICES_REFRESH_ACTION_LABEL}</button>
          )}
        </div>
        {location.page === "nodes" && <><div className="pageHeading"><div><h1>Devices</h1><p>Manage the devices using your licenses.</p></div></div><ProtectedNodes key={auth.customerId} customer={auth.customerId??""} busy={busy} runOnce={runOnce} onSessionExpired={auth.retrySession} /></>}
        {location.page === "account" ? <AccountFeature customerId={auth.customerId} /> : readState !== "ready" ? <section className="emptyState"><h2>{location.page==="nodes"?"Registered machines unavailable":readState === "loading" ? "Loading your account…" : "Account data unavailable"}</h2><p>{readState === "loading" ? "Fetching your licenses and devices." : "We could not refresh your account. Retry to see current access."}</p>{readState === "error" && <button disabled={busy} onClick={() => void refreshPortalData()}>Retry</button>}</section> : <>
          {location.page === "apps" && <AppsFeature entitlements={entitlements} usage={usage} usageAvailable={usageAvailable} retry={refreshPortalData} downloads={downloads} busy={busy || stale} project={location.project} />}
          {location.page === "nodes" && <DevicesFeature controller={deviceController} />}
        </>}
      </div>
    </main>
    <SeatReleaseDialog controller={deviceController} />
    </>
  );
}
