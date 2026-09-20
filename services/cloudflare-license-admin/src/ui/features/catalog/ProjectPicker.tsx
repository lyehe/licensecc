import React, { useRef, useState } from "react";
import { api, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { pageAppendError } from "../../shared/pagination";

type ProjectPage = { items: Array<{ project: string }>; next_cursor: string | null };
export function ProjectPicker({ onSelect }: { onSelect(project: string): void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectPage["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const failedCursor = useRef<string | null>(null);
  async function load(next: string | null): Promise<void> {
    setBusy(true); setError(""); failedCursor.current = next;
    try {
      const response = await api<ProjectPage>(`/api/admin/catalog/projects${next === null ? "" : `?cursor=${encodeURIComponent(next)}`}`);
      const parsed = parseExactApiSuccess<ProjectPage>(response, "projects_listed", value => {
        if (typeof value !== "object" || value === null) return false;
        const page = value as ProjectPage;
        return Array.isArray(page.items) && page.items.every(item => typeof item?.project === "string" && item.project.length > 0)
          && (page.next_cursor === null || (typeof page.next_cursor === "string" && /^\d+$/.test(page.next_cursor) && Number(page.next_cursor) > Number(next ?? 0)));
      });
      if (!parsed) throw new Error(apiFailureMessage(response));
      if (pageAppendError(next === null ? [] : projects, parsed.data.items, item => item.project)) throw new Error("App inventory changed. Refresh the list.");
      setProjects(previous => next === null ? parsed.data.items : [...previous, ...parsed.data.items]); setCursor(parsed.data.next_cursor);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to load apps."); }
    finally { setBusy(false); }
  }
  return <section aria-label="App inventory">
    <button disabled={busy} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(null); }}>Browse apps</button>
    {open && <div aria-busy={busy}>
      {error && <p role="alert">{error} <button disabled={busy} onClick={() => void load(failedCursor.current)}>Retry app list</button></p>}
      <div className="actions">{projects.map(item => <button disabled={busy || !!error} key={item.project} onClick={() => { onSelect(item.project); setOpen(false); }}>{item.project}</button>)}</div>
      <div className="tableFooter"><span>{busy ? "Loading apps…" : `${projects.length} apps loaded`}</span><button disabled={busy} onClick={() => void load(null)}>Refresh app list</button>{cursor !== null && <button disabled={busy} onClick={() => void load(cursor)}>More apps</button>}</div>
    </div>}
  </section>;
}
