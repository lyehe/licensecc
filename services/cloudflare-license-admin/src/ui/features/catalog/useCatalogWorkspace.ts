import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useNavigationGuard } from "../../app/navigation";
import type { CatalogView } from "../../app/types";
import { focusWorkspaceTarget, usableFocusTarget } from "../../shared/workspaceFocus";

export type CatalogTask = "planDetail" | "featureEditor" | "planEditor" | "planFeatureEditor" | "projection";
type DraftTask = Exclude<CatalogTask, "planDetail"> | "import";

interface CatalogWorkspaceOptions {
  active: boolean;
  view: CatalogView;
  busy: boolean;
  operationLocked: boolean;
  snapshots: Record<DraftTask, string>;
  importApplied: boolean;
  projectionApplied: boolean;
  onDiscard: (task: DraftTask) => void;
  invalidate: () => void;
}

/** Local editor visibility never owns a request, preview capability, or recovery. */
export function useCatalogWorkspace(options: CatalogWorkspaceOptions): {
  task: CatalogTask | null;
  revision: number;
  open: (task: CatalogTask, setup?: () => void, baseline?: string) => void;
  close: () => void;
  finish: (task: CatalogTask) => void;
  markClean: (task: DraftTask, snapshot: string) => void;
} {
  const [task, setTask] = useState<CatalogTask | null>(null);
  const [revision, setRevision] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const baselines = useRef({ ...options.snapshots, import: "" });
  const draft = options.view === "import" ? "import" : task === "planDetail" ? null : task;
  const dirty = draft !== null && options.snapshots[draft] !== baselines.current[draft];
  const { requestLeave } = useNavigationGuard({
    when: options.active && !options.busy && !options.operationLocked && dirty,
    message: "Discard this unsaved catalog task? Choose Cancel to keep editing.",
    onDiscard: () => {
      if (draft !== null) options.onDiscard(draft);
      options.invalidate();
      setTask(null);
      setRevision((value) => value + 1);
    },
  });

  useEffect(() => {
    latest.current.invalidate();
    setTask(null);
    setRevision((value) => value + 1);
  }, [options.view]);
  useEffect(() => {
    if (options.importApplied) baselines.current.import = latest.current.snapshots.import;
  }, [options.importApplied]);
  useEffect(() => {
    if (options.projectionApplied) baselines.current.projection = latest.current.snapshots.projection;
  }, [options.projectionApplied]);
  useLayoutEffect(() => {
    if (!options.active) return;
    const currentView = options.view;
    const focusAtSchedule = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      if (!latest.current.active || latest.current.view !== currentView) return;
      if (document.activeElement !== focusAtSchedule && document.activeElement instanceof HTMLElement && usableFocusTarget(document.activeElement)) return;
      focusWorkspaceTarget(document.querySelector<HTMLElement>(task === null ? '[data-focus-section="catalog-list"] h3' : '[data-focus-section="catalog-task"] h2'));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [options.active, options.view, task]);

  function open(next: CatalogTask, setup: () => void = () => undefined, baseline?: string): void {
    requestLeave(() => {
      options.invalidate();
      setup();
      if (next !== "planDetail") baselines.current[next] = baseline ?? options.snapshots[next];
      setTask(next);
      setRevision((value) => value + 1);
    });
  }
  function close(): void {
    if (options.busy || options.operationLocked) return;
    requestLeave(() => {
      if (draft !== null) options.onDiscard(draft);
      options.invalidate();
      setTask(null);
      setRevision((value) => value + 1);
    });
  }
  function finish(completed: CatalogTask): void {
    setTask((current) => current === completed ? null : current);
  }
  return { task, revision, open, close, finish, markClean: (kind, snapshot) => { baselines.current[kind] = snapshot; } };
}
