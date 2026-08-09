export function withCursor(path: string, cursor: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

export function csvExportPath(base: string): string {
  return `${base}${base.includes("?") ? "&" : "?"}format=csv`;
}
