import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAdminNavigation, useNavigationGuard } from "../../app/navigation";
import type { CatalogView } from "../../app/types";
import { focusWorkspaceTarget, usableFocusTarget } from "../../shared/workspaceFocus";

export type CatalogTask = "planDetail" | "featureEditor" | "planEditor" | "planFeatureEditor" | "projection";
type EditorTask = Exclude<CatalogTask, "planDetail">;
type DraftTask = EditorTask | "import";

interface CatalogWorkspaceOptions {
  active: boolean;
  view: CatalogView;
  busy: boolean;
  /** A retained recovery owns the operation gate (a notice that only awaits acknowledgement does not). */
  operationRetained: boolean;
  snapshots: Record<DraftTask, string>;
  onDiscard: (task: DraftTask) => void;
  invalidate: () => void;
}

function draftTask(view: CatalogView, editor: EditorTask | null): DraftTask | null {
  return view === "import" ? "import" : editor;
}

/**
 * Local editor visibility never owns a request, preview capability, or recovery. The plan detail is
 * a history entry (`#/plans?plan=…`); editors overlay it and stay session-only.
 */
export function useCatalogWorkspace(options: CatalogWorkspaceOptions): {
  task: CatalogTask | null;
  planId: string | null;
  revision: number;
  open: (task: EditorTask, setup?: () => void, baseline?: string) => void;
  openPlan: (planId: string, setup: () => void) => void;
  close: () => void;
  finish: (task: CatalogTask) => void;
  markClean: (task: DraftTask, snapshot: string) => void;
  markApplied: (task: "import" | "projection") => void;
} {
  const { catalogPlan, setCatalogPlan } = useAdminNavigation();
  const [editor, setEditor] = useState<EditorTask | null>(null);
  // Mirrors `editor` synchronously, so a leave check later in the same event sees a closed editor.
  const editorRef = useRef<EditorTask | null>(null);
  const [revision, setRevision] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const baselines = useRef({ ...options.snapshots, import: "" });
  const planId = options.view === "plans" ? catalogPlan : null;
  const task: CatalogTask | null = editor ?? (planId !== null ? "planDetail" : null);
  const draft = draftTask(options.view, editor);

  function showEditor(next: EditorTask | null): void {
    editorRef.current = next;
    setEditor(next);
  }
  // Evaluated when the operator leaves, against the latest snapshots and baselines, so an apply
  // that reset its baseline a moment ago never prompts from a stale render.
  function dirtyNow(): boolean {
    const { active, busy, operationRetained, view, snapshots } = latest.current;
    const current = draftTask(view, editorRef.current);
    return active && !busy && !operationRetained && current !== null && snapshots[current] !== baselines.current[current];
  }
  const { requestLeave } = useNavigationGuard({
    when: dirtyNow,
    // A save in flight owns its editor: no route step may happen until it settles, so the editor
    // never outlives its address and a draft the save did not take is never discarded unasked.
    blocks: () => latest.current.active && latest.current.busy && editorRef.current !== null,
    message: "Discard this unsaved catalog task? Choose Cancel to keep editing.",
    onDiscard: () => {
      const current = draftTask(latest.current.view, editorRef.current);
      if (current !== null) latest.current.onDiscard(current);
      latest.current.invalidate();
      showEditor(null);
      setRevision((value) => value + 1);
    },
  });

  // Every route step (catalog view, plan detail, Back or Forward) closes an open editor. A step
  // happens only once leaving was allowed: an unsaved draft was confirmed and discarded, and a
  // save in flight refuses the step (`blocks`), so nothing unsaved is closed here.
  useEffect(() => {
    latest.current.invalidate();
    showEditor(null);
    setRevision((value) => value + 1);
  }, [options.view, catalogPlan]);
  const shownPlan = useRef(planId);
  // The plan an in-page "Back to plans" just left, whose row takes focus as browser Back gives it.
  const returnToRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const left = shownPlan.current;
    shownPlan.current = planId;
    const rowPlan = returnToRow.current;
    returnToRow.current = null;
    // Leaving a plan detail through browser history is the navigation provider's to restore.
    if (!options.active || (left !== null && planId === null && rowPlan !== left)) return;
    const currentView = options.view;
    const focusAtSchedule = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      if (!latest.current.active || latest.current.view !== currentView) return;
      if (document.activeElement !== focusAtSchedule && document.activeElement instanceof HTMLElement && usableFocusTarget(document.activeElement)) return;
      const row = rowPlan === null ? undefined : [...document.querySelectorAll<HTMLElement>("[data-focus-row]")].find((candidate) => candidate.dataset.focusRow === `catalog-plan:${rowPlan}` && usableFocusTarget(candidate));
      const rowAction = row?.querySelector<HTMLElement>("button:not([disabled])") ?? null;
      if (rowAction !== null) {
        focusWorkspaceTarget(rowAction);
        rowAction.scrollIntoView({ block: "nearest" });
        return;
      }
      focusWorkspaceTarget(document.querySelector<HTMLElement>(task === null ? '[data-focus-section="catalog-list"] h3' : '[data-focus-section="catalog-task"] h2'));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [options.active, options.view, task]);

  function open(next: EditorTask, setup: () => void = () => undefined, baseline?: string): void {
    requestLeave(() => {
      options.invalidate();
      setup();
      baselines.current[next] = baseline ?? options.snapshots[next];
      showEditor(next);
      setRevision((value) => value + 1);
    });
  }
  function openPlan(id: string, setup: () => void): void {
    if (setCatalogPlan(id)) setup();
  }
  function close(): void {
    if (options.busy || options.operationRetained) return;
    requestLeave(() => {
      if (draft !== null) options.onDiscard(draft);
      options.invalidate();
      showEditor(null);
      setRevision((value) => value + 1);
      // Closing a plan detail, or an editor opened on one, returns to the plans list.
      if (planId !== null && setCatalogPlan(null)) returnToRow.current = planId;
    });
  }
  function finish(completed: CatalogTask): void {
    if (editorRef.current === completed) showEditor(null);
  }
  return {
    task,
    planId,
    revision,
    open,
    openPlan,
    close,
    finish,
    markClean: (kind, snapshot) => { baselines.current[kind] = snapshot; },
    // Runs in the apply-success path itself, so a navigation right after Apply sees a clean draft.
    markApplied: (kind) => { baselines.current[kind] = latest.current.snapshots[kind]; },
  };
}
