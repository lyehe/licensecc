// Cross-cutting, request-context helpers only. Domain validation stays with its route group.
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

export function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
