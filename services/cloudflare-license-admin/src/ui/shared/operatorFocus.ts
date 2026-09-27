import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ConfirmAction, ConfirmFocusTarget } from "./operatorActions";
import { equivalentRowAction, currentContextStableFocusTarget, usableFocusTarget } from "./workspaceFocus";

/*
 * Focus capture and restoration shared by the confirmation dialog, the action
 * notice and keyed mutations: where focus goes after an operation settles.
 */

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(usableFocusTarget);
}

function focusElement(element: HTMLElement | null): boolean {
  if (element === null || element === document.body || !element.isConnected || element.hasAttribute("disabled")) {
    return false;
  }
  if (!element.matches(FOCUSABLE_SELECTOR) && !element.hasAttribute("tabindex")) {
    element.tabIndex = -1;
  }
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function resolveFocusTarget(target: ConfirmFocusTarget | undefined): HTMLElement | null {
  if (target === undefined || target === null) {
    return null;
  }
  return typeof target === "function" ? target() : target;
}

function dataAttributeSelector(attribute: string, value: string): string {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${attribute}="${escaped}"]`;
}

function stableFocusTarget(
  invokingElement: HTMLElement | null,
  rowKey: string | null,
  sectionKey: string | null,
): HTMLElement | null {
  if (usableFocusTarget(invokingElement)) {
    return invokingElement;
  }

  const row = rowKey === null
    ? invokingElement?.closest<HTMLElement>("[data-focus-row], tr, [role='row']") ?? null
    : Array.from(document.querySelectorAll<HTMLElement>(dataAttributeSelector("data-focus-row", rowKey))).find(usableFocusTarget) ?? null;
  if (row !== null) {
    const equivalent = equivalentRowAction(row, invokingElement);
    if (equivalent) return equivalent;
    const transition = Array.from(row.querySelectorAll<HTMLElement>("[data-focus-action]")).find(usableFocusTarget);
    if (transition !== undefined) {
      return transition;
    }
    const statusOrHeading = row.querySelector<HTMLElement>(".status, [role='heading'], h1, h2, h3");
    if (usableFocusTarget(statusOrHeading)) {
      return statusOrHeading;
    }
    if (usableFocusTarget(row)) {
      return row;
    }
    const fallbackButton = Array.from(row.querySelectorAll<HTMLElement>("button")).find(usableFocusTarget);
    if (fallbackButton !== undefined) {
      return fallbackButton;
    }
  }

  const section = sectionKey === null
    ? invokingElement?.closest<HTMLElement>("[data-focus-section], section, aside") ?? null
    : document.querySelector<HTMLElement>(dataAttributeSelector("data-focus-section", sectionKey));
  if (section !== null) {
    const heading = section.querySelector<HTMLElement>("[role='heading'], h1, h2, h3, .status");
    if (usableFocusTarget(heading)) {
      return heading;
    }
    if (usableFocusTarget(section)) {
      return section;
    }
  }

  const globalHeading = currentContextStableFocusTarget() ?? document.querySelector<HTMLElement>("main h1, main h2, main h3, [role='main'] h1, [role='main'] h2, [role='main'] h3, h1, h2, h3");
  return usableFocusTarget(globalHeading) ? globalHeading : document.documentElement;
}

export function focusTargetInRow(rowKey: string, selectors: readonly string[]): ConfirmFocusTarget {
  return () => {
    const row = Array.from(document.querySelectorAll<HTMLElement>(dataAttributeSelector("data-focus-row", rowKey))).find(usableFocusTarget);
    if (row === undefined) {
      return null;
    }
    for (const selector of selectors) {
      const candidate = row.querySelector<HTMLElement>(selector);
      // A candidate otherwise fit to focus can still sit inside a "More actions" menu that a
      // choice already closed (see ActionMenu); reopen that disclosure before ruling it out, the
      // same way equivalentRowAction does for a same-key row swap.
      if (candidate !== null && !candidate.hasAttribute("disabled") && candidate.getAttribute("aria-disabled") !== "true") {
        const disclosure = candidate.closest("details");
        if (disclosure !== null && !disclosure.open) disclosure.open = true;
      }
      if (usableFocusTarget(candidate)) {
        return candidate;
      }
    }
    const statusOrHeading = row.querySelector<HTMLElement>(".status, [role='heading'], h1, h2, h3");
    return usableFocusTarget(statusOrHeading) ? statusOrHeading : row;
  };
}

export function focusTargetInSection(sectionKey: string): ConfirmFocusTarget {
  return () => {
    const section = document.querySelector<HTMLElement>(dataAttributeSelector("data-focus-section", sectionKey));
    if (section === null) {
      return null;
    }
    const heading = section.querySelector<HTMLElement>("[role='heading'], h1, h2, h3");
    return usableFocusTarget(heading) ? heading : section;
  };
}

export interface PendingFocus {
  actionTarget?: ConfirmFocusTarget;
  invokingElement: HTMLElement | null;
  rowKey: string | null;
  sectionKey: string | null;
}

export function resolvePendingFocus(pending: PendingFocus): HTMLElement | null {
  let actionTarget: HTMLElement | null = null;
  try {
    actionTarget = resolveFocusTarget(pending.actionTarget);
  } catch {
    actionTarget = null;
  }
  if (usableFocusTarget(actionTarget)) {
    return actionTarget;
  }
  return stableFocusTarget(pending.invokingElement, pending.rowKey, pending.sectionKey);
}

export interface OperatorFocus {
  /** Bumped to request a post-render focus pass once an operation settles. */
  focusGeneration: number;
  setFocusGeneration: Dispatch<SetStateAction<number>>;
  pendingRestoreFocusRef: RefObject<PendingFocus | null>;
  pendingSuccessFocusRef: RefObject<PendingFocus | null>;
  pendingShellFocusRef: RefObject<boolean>;
  focusSoon: (element: HTMLElement | null) => void;
  capturePendingFocus: (actionTarget?: ConfirmFocusTarget) => PendingFocus;
}

export function useOperatorFocus(): OperatorFocus {
  const [focusGeneration, setFocusGeneration] = useState(0);
  const pendingRestoreFocusRef = useRef<PendingFocus | null>(null);
  const pendingSuccessFocusRef = useRef<PendingFocus | null>(null);
  const pendingShellFocusRef = useRef(false);
  const focusSoon = useCallback((element: HTMLElement | null): void => {
    if (focusElement(element)) {
      return;
    }
    if (element !== null && element.isConnected) {
      window.requestAnimationFrame(() => {
        focusElement(element);
      });
    }
  }, []);
  const capturePendingFocus = useCallback((actionTarget?: ConfirmFocusTarget): PendingFocus => {
    const activeElement = document.activeElement;
    const invokingElement = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null;
    const row = invokingElement?.closest<HTMLElement>("[data-focus-row], tr, [role='row']") ?? null;
    const section = invokingElement?.closest<HTMLElement>("[data-focus-section], section, aside") ?? null;
    return {
      actionTarget,
      invokingElement,
      rowKey: row?.getAttribute("data-focus-row") ?? null,
      sectionKey: section?.getAttribute("data-focus-section") ?? null,
    };
  }, []);
  return { focusGeneration, setFocusGeneration, pendingRestoreFocusRef, pendingSuccessFocusRef, pendingShellFocusRef, focusSoon, capturePendingFocus };
}

/**
 * The post-render focus pass. Once no confirmation is open, it focuses the
 * pending success or restore target, or the current shell after a stale
 * recovery; bumping `focusGeneration` requests another pass.
 */
export function useFocusRestoration(focus: OperatorFocus, confirmAction: ConfirmAction | null): void {
  const { focusGeneration, pendingRestoreFocusRef, pendingSuccessFocusRef, pendingShellFocusRef, focusSoon } = focus;
  useLayoutEffect(() => {
    if (confirmAction !== null) {
      return;
    }
    if (pendingShellFocusRef.current) {
      pendingShellFocusRef.current = false;
      const focusCurrentShell = (): void => {
        focusSoon(currentContextStableFocusTarget());
      };
      focusCurrentShell();
      window.requestAnimationFrame(focusCurrentShell);
      return;
    }
    const pendingFocus = pendingSuccessFocusRef.current ?? pendingRestoreFocusRef.current;
    pendingSuccessFocusRef.current = null;
    pendingRestoreFocusRef.current = null;
    if (pendingFocus === null) {
      return;
    }
    const focusAfterRefresh = (): void => {
      focusSoon(resolvePendingFocus(pendingFocus));
    };
    // Native <dialog> returns focus to <body> as it closes.  Restore a stable
    // in-app target in this layout pass, then refine after any row refresh has
    // rendered.  Deferring both attempts leaves a visible/body-focus gap when
    // an unknown outcome disables the invoking destructive control.
    focusAfterRefresh();
    window.requestAnimationFrame(focusAfterRefresh);
  }, [confirmAction, focusGeneration, focusSoon]);
}
