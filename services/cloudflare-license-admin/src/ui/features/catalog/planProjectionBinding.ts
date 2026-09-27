/**
 * Whether a confirmed plan-projection preview binding is still the live one: the exact same
 * object, captured at the exact same form revision. A later preview, an invalidated (null)
 * binding, or a form edit that bumped the revision all make it stale, never merely "close enough".
 * Kept in its own module so it stays a plain, directly unit-testable function rather than growing
 * an already-tight hotspot file.
 */
export function planProjectionBindingIsUsable<T>(binding: T, revision: number, currentBinding: T | null, currentRevision: number): boolean {
  return currentRevision === revision && currentBinding === binding;
}
