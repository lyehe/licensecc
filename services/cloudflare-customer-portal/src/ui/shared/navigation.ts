import { useEffect, useState } from "react";

export interface PortalLocation { page: "apps" | "nodes" | "account"; project: string | null }

function readLocation(): PortalLocation {
  const [page, project] = window.location.hash.replace(/^#\/?/, "").split("/");
  if (page === "nodes" || page === "account") return { page, project: null };
  try { return { page: "apps", project: project ? decodeURIComponent(project) : null }; }
  catch { return { page: "apps", project: null }; }
}

export function appLocation(project: string): string { return `#/apps/${encodeURIComponent(project)}`; }

export function usePortalLocation(): PortalLocation {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const changed = (): void => setLocation(readLocation());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return location;
}
