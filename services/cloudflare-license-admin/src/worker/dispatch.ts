import { ALL_ROUTES, pathToPattern } from "./routes.js";
import type { RouteDescriptor } from "./route-descriptor.js";
import { metaRoutes } from "./groups/meta.js";
import { summaryReportsRoutes } from "./groups/summary-reports.js";
import { customerRoutes } from "./groups/customers.js";
import { catalogRoutes } from "./groups/catalog.js";
import { policyRoutes } from "./groups/policies.js";
import { entitlementRoutes } from "./groups/entitlements.js";
import { deviceRoutes } from "./groups/devices.js";
import { webhookRoutes } from "./groups/webhooks.js";
import { syncRoutes } from "./groups/sync.js";

export const ROUTE_DESCRIPTORS: readonly RouteDescriptor[] = [
  ...metaRoutes,
  ...summaryReportsRoutes,
  ...customerRoutes,
  ...catalogRoutes,
  ...policyRoutes,
  ...entitlementRoutes,
  ...deviceRoutes,
  ...webhookRoutes,
  ...syncRoutes,
];

interface CompiledDescriptor {
  readonly descriptor: RouteDescriptor;
  readonly pattern: RegExp | null;
}

const UNSAFE_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMutationMethod(method: string): boolean {
  return UNSAFE_MUTATION_METHODS.has(method.toUpperCase());
}

function canonicalOrigin(value: string): string | null {
  if (value === "null" || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+$/.test(value)) return null;
  try {
    const origin = new URL(value);
    if (
      origin.origin === "null"
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== ""
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

export function rejectsCrossSiteMutation(request: Request): boolean {
  if (!isUnsafeMutationMethod(request.method)) return false;

  const origin = request.headers.get("origin");
  if (origin !== null && canonicalOrigin(origin) !== new URL(request.url).origin) return true;
  return request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site";
}

const compiled: readonly CompiledDescriptor[] = ROUTE_DESCRIPTORS.map((descriptor) => ({
  descriptor,
  pattern: descriptor.path.includes("{") ? pathToPattern(descriptor.path) : null,
}));

const descriptorKeys = ROUTE_DESCRIPTORS.map((descriptor) => `${descriptor.method} ${descriptor.path}`).sort();
const canonicalKeys = ALL_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
if (new Set(descriptorKeys).size !== descriptorKeys.length || descriptorKeys.join("\n") !== canonicalKeys.join("\n")) {
  throw new Error("route descriptor inventory must equal ALL_ROUTES exactly");
}

export interface RouteMatch {
  readonly descriptor: RouteDescriptor;
  readonly params: Readonly<Record<string, string>>;
}

export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const candidate of compiled) {
    const { descriptor } = candidate;
    if (descriptor.method !== method) continue;
    if (candidate.pattern === null) {
      if (descriptor.path === pathname) return { descriptor, params: {} };
      continue;
    }
    const captures = pathname.match(candidate.pattern);
    if (captures === null) continue;
    const params: Record<string, string> = {};
    for (let index = 0; index < descriptor.paramNames.length; index += 1) {
      params[descriptor.paramNames[index]!] = captures[index + 1] ?? "";
    }
    return { descriptor, params };
  }
  return null;
}
