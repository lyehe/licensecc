import React from "react";
import { appLocation } from "../../shared/navigation";
import { EntitlementsFeature } from "../entitlements/EntitlementsFeature";
import { type LicenseDownloads } from "../downloads/DownloadsFeature";
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
      <div className="pageHeading"><div><h1>{project}</h1></div><a className="button" href="#/nodes">View devices</a></div>
      {access.length === 0 ? <div className="emptyState"><h2>App not found</h2><p>This app is not in the access returned for your account.</p></div> : <>
        <EntitlementsFeature entitlements={access} downloads={downloads} busy={busy} />
        <UsageFeature available={usageAvailable} busy={busy} retry={retry} usage={usage.filter((item) => item.project === project)} />
      </>}
    </div>;
  }
  return <>
    <div className="pageHeading"><div><h1>Apps</h1></div></div>
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
