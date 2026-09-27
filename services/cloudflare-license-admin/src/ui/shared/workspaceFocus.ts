export function usableFocusTarget(element: HTMLElement | null): boolean {
  if (element === null || element === document.body || !element.isConnected || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']") !== null || element.getClientRects().length === 0) return false;
  // A closed <details>' own content stays unfocusable at the browser level no matter what an
  // author stylesheet declares for it (for example a "More actions" menu's own `.actions { display:
  // grid }` styling one of these buttons still leaves it laid out, so this cannot be read off computed
  // style or layout geometry alone) -- everything but its <summary> is out of reach until reopened.
  const disclosure = element.closest("details");
  if (disclosure !== null && !disclosure.open) {
    const summary = disclosure.querySelector(":scope > summary");
    if (summary === null || !summary.contains(element)) return false;
  }
  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

/** The current heading survives closed mobile navigation and stale recovery. */
export function currentContextStableFocusTarget(): HTMLElement | null {
  for (const selector of ["[data-workspace-heading]", "[data-workspace-menu]", 'nav[aria-label="Main navigation"] [aria-current="page"]', "#workspace-content"]) {
    const target = document.querySelector<HTMLElement>(selector);
    if (usableFocusTarget(target)) return target;
  }
  return null;
}

export function focusWorkspaceTarget(target: HTMLElement | null = currentContextStableFocusTarget()): void {
  if (!usableFocusTarget(target) || target === null) return;
  if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** Restore the same action when responsive markup swaps its rendered row. */
export function equivalentRowAction(row: HTMLElement, invoking: HTMLElement | null): HTMLElement | null {
  const action = invoking?.getAttribute("data-focus-action");
  if (!action) return null;
  const candidate = Array.from(row.querySelectorAll<HTMLElement>("[data-focus-action]")).find((item) => item.getAttribute("data-focus-action") === action);
  if (!candidate || candidate.hasAttribute("disabled") || candidate.getAttribute("aria-disabled") === "true") return null;
  const disclosure = candidate.closest("details");
  if (disclosure) disclosure.open = true;
  return usableFocusTarget(candidate) ? candidate : null;
}
