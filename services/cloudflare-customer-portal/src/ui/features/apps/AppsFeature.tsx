import React from "react";
import { canDownloadLicense } from "../../portalWorkflow";
import { appLocation } from "../../shared/navigation";
import { EntitlementsFeature } from "../entitlements/EntitlementsFeature";
import { DownloadsFeature, type LicenseDownloads } from "../downloads/DownloadsFeature";
import { UsageFeature } from "../usage/UsageFeature";
import type { EntitlementRow, UsageRow } from "../../types";

export function AppsFeature({ entitlements, usage, usageAvailable, retry, downloads, busy, project }: {
  usageAvailable: boolean; retry(): Promise<void>;
  entitlements: EntitlementRow[]; usage: UsageRow[]; downloads: LicenseDownloads;
  busy: boolean; project: string | null;
}): React.ReactElement {
  const projects = [...new Set(entitlements.map((item) => item.project))].sort();
  if (project !== null) {
    const access = entitlements.filter((item) => item.project === project);
    return <div className="appDetail">
      <a className="backLink" href="#/apps">← Back to apps</a>
      <div className="pageHeading"><div><h1>{project}</h1><p>License access and activity for this app.</p></div><a className="button" href="#/nodes">View devices</a></div>
      {access.length === 0 ? <div className="emptyState"><h2>App not found</h2><p>This app is not in the access returned for your account.</p></div> : <>
        <EntitlementsFeature entitlements={access} />
        {access.some((item) => item.license_mode === "floating") && <section className="tablePane full"><h2>Floating access</h2><p>Use the installed application to acquire a floating session. Each license has its own seat pool.</p></section>}
        {access.some((item) => item.enforcement_mode === "device_bound_v1") && <section className="tablePane full"><h2>Connect your app</h2><p>Open the app on your device and choose Connect. Sign in, compare the codes, and approve the connection. No license file or device key entry is needed here.</p><a href="#/nodes">Manage connected devices</a></section>}
        {access.some(canDownloadLicense) && <DownloadsFeature busy={busy} downloads={downloads} entitlements={access} />}
        <UsageFeature available={usageAvailable} busy={busy} retry={retry} entitlements={access} usage={usage.filter((item) => item.project === project)} />
      </>}
    </div>;
  }
  return <>
    <div className="pageHeading"><div><h1>Apps</h1><p>Your licenses and app access.</p></div></div>
    {projects.length === 0 ? <div className="emptyState"><h2>No apps assigned yet</h2><p>Apps appear here when a license is assigned to your account.</p></div> : <div className="appList">
      {projects.map((name) => {
        const access = entitlements.filter((item) => item.project === name);
        return <article className="appRow" key={name}>
          <div className="appMark" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</div>
          <div className="appIdentity"><h2>{name}</h2><p>{access.length} {access.length === 1 ? "license" : "licenses"} · {new Set(access.map((item) => item.feature)).size} {new Set(access.map((item) => item.feature)).size === 1 ? "feature" : "features"}</p></div>

          <a className="button" href={appLocation(name)} aria-label={`View app ${name}`}>View licenses</a>
        </article>;
      })}
    </div>}
  </>;
}
