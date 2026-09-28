import { useEffect, useState } from "react";

export interface PortalLocation { page: "apps" | "nodes" | "account"; project: string | null }

function decodeProject(raw: string | undefined): string | null {
  if (!raw) return null;
  try { return decodeURIComponent(raw); }
  catch { return null; }
}

function readLocation(): PortalLocation {
  const [page, project] = window.location.hash.replace(/^#\/?/, "").split("/");
  if (page === "account") return { page, project: null };
  // nodes carries the same `/{project}` segment apps does, so "View devices" can open the
  // devices page pre-filtered to one app's exact name.
  if (page === "nodes") return { page, project: decodeProject(project) };
  return { page: "apps", project: decodeProject(project) };
}

export function appLocation(project: string): string { return `#/apps/${encodeURIComponent(project)}`; }
// The devices page, filtered to one app, or unfiltered when no app is given.
export function devicesLocation(project?: string): string {
  return project === undefined ? "#/nodes" : `#/nodes/${encodeURIComponent(project)}`;
}

export function usePortalLocation(): PortalLocation {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const changed = (): void => setLocation(readLocation());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return location;
}
