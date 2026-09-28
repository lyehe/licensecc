/**
 * Closed <details> content is unpainted and unfocusable at the browser level, whatever author
 * `display` rules apply to it -- a "More actions" menu's own `.actions { display: grid }` styling,
 * for example, still leaves `getComputedStyle` reporting "grid" for a button inside a closed menu,
 * and `.focus()` on it silently does nothing. Computed style and layout geometry cannot be trusted
 * here, so this walks every ancestor <details>, not just the nearest one: a closed outer disclosure
 * around an open inner one still makes its content unreachable. An element is exempt from a given
 * ancestor's closed state only while it sits inside that same ancestor's own <summary>.
 */
function hasUnreachableClosedAncestor(element: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node !== null) {
    const disclosure: HTMLDetailsElement | null = node.closest("details");
    if (disclosure === null) return false;
    if (!disclosure.open) {
      const summary = disclosure.querySelector(":scope > summary");
      if (summary === null || !summary.contains(element)) return true;
    }
    node = disclosure.parentElement;
  }
  return false;
}

export function usableFocusTarget(element: HTMLElement | null): boolean {
  if (element === null || element === document.body || !element.isConnected || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']") !== null || element.getClientRects().length === 0) return false;
  if (hasUnreachableClosedAncestor(element)) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

/**
 * Reopens every closed <details> ancestor of `candidate` so it can become focusable again after an
 * action closed the disclosure around it (see ActionMenu). Every ancestor is reopened, not just the
 * nearest, to match what usableFocusTarget checks above.
 */
export function reopenAncestorDisclosure(candidate: HTMLElement): void {
  let node: HTMLElement | null = candidate;
  while (node !== null) {
    const disclosure: HTMLDetailsElement | null = node.closest("details");
    if (disclosure === null) return;
    if (!disclosure.open) disclosure.open = true;
    node = disclosure.parentElement;
  }
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
  reopenAncestorDisclosure(candidate);
  return usableFocusTarget(candidate) ? candidate : null;
}
