// One search box, above the devices page's connected-devices section, filters rows by a
// case-insensitive substring match against a per-row set of searchable fields -- always including
// the row's app -- combined with an optional EXACT app filter carried by the route's project
// segment (`#/nodes/{project}`).
export function matchesDeviceSearch(
  fields: readonly (string | null | undefined)[],
  rowProject: string,
  query: string,
  exactProject: string | null,
): boolean {
  if (exactProject !== null && rowProject !== exactProject) return false;
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [...fields, rowProject].some((field) => (field ?? "").toLowerCase().includes(needle));
}
