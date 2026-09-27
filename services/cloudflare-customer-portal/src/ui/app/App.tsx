import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { localMessage, setOnUnauthorized, StatusLine } from "../shared/api";
import { useSingleFlight } from "../shared/useSingleFlight";
import { AuthFeature, usePortalAuth } from "../features/auth/AuthFeature";
import { PasswordAction, capturePasswordAction } from "../features/auth/PasswordAction";
import { ProvidersScope } from "../features/auth/ProviderSignIn";
import { usePortalData } from "../features/data/usePortalData";
import { DEVICES_REFRESH_ACTION_LABEL, DEVICES_REFRESH_FAILURE_CODE, DevicesFeature, useDevicesController } from "../features/devices/DevicesFeature";
import { SeatReleaseDialog } from "../features/devices/BrowserSeats";
import { useLicenseDownloads } from "../features/downloads/DownloadsFeature";
import { AppsFeature } from "../features/apps/AppsFeature";
import { AccountFeature } from "../features/account/AccountFeature";
import { ConsentFeature } from "../features/consent/ConsentFeature";
import { captureEnrollment, clearEnrollment } from "../features/consent/pending";
import { usePortalLocation } from "../shared/navigation";
import type { StatusMessage } from "../types";
import "../styles.css";

// The sign-in options are fetched once for every screen; they carry the support contact that
// signed-in screens (Connect) show too.
export function App(): React.ReactElement {
  return <ProvidersScope><PortalShell /></ProvidersScope>;
}

function PortalShell(): React.ReactElement {
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
  // D2: download results now show next to their own control (LicenseDownloadAction), not the
  // page-level line, so setMessage is no longer passed through here.
  const downloads = useLicenseDownloads({ runOnce });
  const deviceController = useDevicesController({
    busy: busy || stale,
    busyRef,
    devices,
    entitlements,
    refreshData,
    runOnce,
    setMessage,
  });

  // Fix round 1 (CRITICAL): PortalShell stays mounted across a session-ended transition, so a
  // DIFFERENT customer signing in next in the same tab must never see the previous customer's
  // entitlements, devices, usage, seat state (including its localStorage-backed cache) or a typed
  // device key -- the same reset logout() already performs below. Read through a ref (updated on
  // every render, just below) rather than closed over directly, because deviceController.clear is a
  // plain function recreated every render; depending on it directly would force the effect after it
  // to re-run on every unrelated render too, tearing down and rebuilding the re-entrancy guard the
  // onUnauthorized hook needs to stay stable across the whole app lifetime.
  const clearAllPortalStateRef = useRef<() => void>(() => {});
  clearAllPortalStateRef.current = () => {
    clearPortalData();
    deviceController.clear();
    downloads.clear();
  };

  // Task C3: a mid-session 401 (the server's `unauthorized` code, never a credential failure) must
  // return the customer to sign-in no matter which api() call -- or the download's raw fetch, via
  // reportUnauthorized() -- surfaced it. Registered exactly once here; `retrying` is a re-entrancy
  // guard so several api() calls failing at once (e.g. usePortalData's concurrent reads) collapse into
  // one retrySession() call rather than one each. retrySession() itself (AuthFeature's loadMe) makes
  // its own /me check with skipUnauthorizedHook, so that check can never re-enter this handler. Never
  // touches consent/enrollment state -- a saved consent mutation must survive and resume.
  useEffect(() => {
    let retrying = false;
    const handleUnauthorized = (): void => {
      if (retrying) return;
      retrying = true;
      void auth.retrySession()
        .then((stillAuthed) => {
          if (!stillAuthed) {
            clearAllPortalStateRef.current();
            setMessage(localMessage("session_ended", false));
          }
        })
        .finally(() => {
          retrying = false;
        });
    };
    setOnUnauthorized(handleUnauthorized);
    return () => setOnUnauthorized(null);
  }, [auth.retrySession, setMessage]);

  const refreshFocusRef = useRef<HTMLElement | null>(null);
  const activeTabButtonRef = useRef<HTMLAnchorElement | null>(null);

  useLayoutEffect(() => {
    document.getElementById("content")?.focus();
  }, [location.page, location.project]);

  // Fix round 1 (Important): DevicesFeature/LicenseDownloadAction only render while location.page is
  // "nodes"/"apps", but seatMessages/deviceMessages/downloads.messages live one level up, in the
  // controllers below, so they otherwise outlive a single visit -- a stale "Seat started." or
  // "Download started." would reappear in a freshly mounted role="status" node on a later visit, and
  // (for seats) keep the panel expanded forever since hasBrowserSession reads seatMessages too. Clear
  // each page's own results the moment that page is left. Read through refs (updated every render,
  // like clearAllPortalStateRef above) so these effects depend on nothing but location.page itself --
  // deviceController/downloads are plain objects recreated every render, and depending on them
  // directly would fire the cleanup (clearing a result that was just set) on every unrelated render.
  const clearDeviceMessagesRef = useRef<() => void>(() => {});
  clearDeviceMessagesRef.current = () => deviceController.clearMessages();
  useEffect(() => {
    if (location.page !== "nodes") return undefined;
    return () => clearDeviceMessagesRef.current();
  }, [location.page]);

  const clearDownloadMessagesRef = useRef<() => void>(() => {});
  clearDownloadMessagesRef.current = () => downloads.clearMessages();
  useEffect(() => {
    if (location.page !== "apps") return undefined;
    return () => clearDownloadMessagesRef.current();
  }, [location.page]);

  // Each view sets document.title (task C6): the SAME branches PortalShell's own return below uses
  // to pick which screen renders, read here instead of duplicated per screen component, so this one
  // effect can never drift from what is actually on screen. Apps/Devices/Account, Sign in/Check your
  // email (AuthFeature's own two step headings), Set a password (PasswordAction) and Connect a
  // device (ConsentFeature) are the only views a customer can distinguish by tab title; a password
  // sub-mode (register/reset) or the auth loading/error interstitial are still "Sign in" for title
  // purposes -- they are not separately navigable screens.
  useEffect(() => {
    const view = passwordAction !== null ? "Set a password"
      : (typeof enrollment === "string" || (enrollment && auth.phase === "authed")) ? "Connect a device"
      : auth.phase === "verify" ? "Check your email"
      : auth.phase !== "authed" ? "Sign in"
      : location.page === "nodes" ? "Devices"
      : location.page === "account" ? "Account"
      : "Apps";
    document.title = `${view} · Licensecc`;
  }, [passwordAction, enrollment, auth.phase, location.page]);

  // A signed-in auth_error/auth_result (e.g. an already-used magic link, or an OAuth start/callback
  // failure that targets #/account) only has somewhere to render on Account, via AccountFeature's
  // own <ProviderResult/>, which reads and then strips it itself. Every other page has nowhere to
  // show it, so strip it here instead of letting it linger in the address bar until a later visit to
  // Account resurfaces it out of context.
  useLayoutEffect(() => {
    if (auth.phase !== "authed" || location.page === "account") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("auth_error") && !url.searchParams.has("auth_result")) return;
    url.searchParams.delete("auth_error"); url.searchParams.delete("auth_result");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [auth.phase, location.page]);

  async function refreshPortalData(): Promise<void> {
    if (busyRef.current) return;
    refreshFocusRef.current = activeTabButtonRef.current;
    await runOnce(async () => {
      try {
        if (await refreshData()) {
          setMessage(null);
        } else {
          setMessage(localMessage("account_refresh_failed", false));
        }
      } catch {
        setMessage(localMessage("account_refresh_failed", false));
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
  if (typeof enrollment === "string" || (enrollment && auth.phase === "authed")) return <ConsentFeature key={typeof enrollment==="string"?enrollment:`${enrollment.handle}:${enrollment.createdAt}`} entry={enrollment} customerId={auth.customerId??""} email={auth.email} onDone={finishEnrollment} onSignOut={logout} onSessionExpired={auth.retrySession} feedback={<StatusLine message={message} fallback="" />} />;
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
        {auth.email !== null && <p className="signedInAs">Signed in as {auth.email}</p>}
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
        {location.page === "nodes" && <DevicesFeature key={auth.customerId} controller={deviceController} customer={auth.customerId??""} busy={busy} runOnce={runOnce} onSessionExpired={auth.retrySession} project={location.project} accountDataState={readState} onRetryAccountData={refreshPortalData} />}
        {location.page === "account" && <AccountFeature customerId={auth.customerId} />}
        {location.page === "apps" && (readState !== "ready" ? <section className="emptyState"><h2>{readState === "loading" ? "Loading your account…" : "Account data unavailable"}</h2><p>{readState === "loading" ? "Fetching your licenses and devices." : "We could not refresh your account. Retry to see current access."}</p>{readState === "error" && <button disabled={busy} onClick={() => void refreshPortalData()}>Retry</button>}</section> : <AppsFeature entitlements={entitlements} usage={usage} usageAvailable={usageAvailable} retry={refreshPortalData} downloads={downloads} busy={busy || stale} project={location.project} email={auth.email} />)}
      </div>
    </main>
    <SeatReleaseDialog controller={deviceController} />
    </>
  );
}
