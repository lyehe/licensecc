/**
 * Whether any field of a filter object holds an operator-entered value. A blank or whitespace-only
 * string does not count: it reads the same as a field the operator never touched, so the list's
 * empty state stays "nothing here yet" rather than switching to "nothing matches these filters".
 */
export function hasActiveFilter<T extends object>(filter: T): boolean {
  return Object.values(filter).some((value) => typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null);
}
