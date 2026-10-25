/** Literal, case-insensitive substring search, with an optional exact app constraint. */
export function matchesDeviceSearch(fields: readonly (string | null | undefined)[], rowProject: string, query: string, exactProject: string | null): boolean {
  if (exactProject !== null && rowProject !== exactProject) return false;
  const needle = query.trim().toLowerCase();
  return needle === "" || [...fields, rowProject].some(field => (field ?? "").toLowerCase().includes(needle));
}
