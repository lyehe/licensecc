import type { AdminRoute, AdminTab, CatalogView, CustomerAccessView, CustomerSection, NavigationTarget } from "./types";

const tabs: readonly AdminTab[] = ["overview", "entitlements", "policies", "plans", "webhooks", "events", "customers", "licenses", "fulfillment", "reports"];
const customerSections: readonly CustomerSection[] = ["overview", "access", "licenses", "tokens", "orders", "history"];
const customerAccessViews: readonly CustomerAccessView[] = ["grants", "nodes", "sessions"];
const catalogViews: readonly CatalogView[] = ["plans", "features", "import"];
const filterKeys: Partial<Record<AdminTab, readonly string[]>> = {
  customers: ["status"],
  // id and customer_id are deliberately absent: a search or "Expiring soon" deep link sets them to
  // pin one exact record, but the id encodes the license fingerprint (via project+feature+fingerprint),
  // so it must stay session-only and never reach the URL. license_id is an ordinary browsing filter
  // (like project/feature/status) and is safe to keep on refresh/back.
  entitlements: ["project", "feature", "status", "license_id"],
  licenses: ["project", "customer_id"],
  fulfillment: ["status", "subscription_id"],
  // entitlement_id is deliberately absent: a "History" deep link from an entitlement row sets it to
  // pin one exact record's events, but (like the entitlements id filter) it encodes the license
  // fingerprint, so it must stay session-only and never reach the URL.
  events: ["project", "feature", "event_type", "actor", "since", "until"],
};
const statuses: Partial<Record<AdminTab, readonly string[]>> = {
  customers: ["active", "disabled"],
  entitlements: ["active", "disabled", "revoked"],
  fulfillment: ["accepted", "processed", "superseded", "rejected"],
};

function validValue(value: string, limit = 256): boolean {
  return value.length > 0 && value.length <= limit && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Only approved non-secret navigation state crosses the URL boundary. In
 * particular q, fingerprints, tokens, and draft JSON remain session memory. */
export function urlFilters(tab: AdminTab, filter: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of filterKeys[tab] ?? []) {
    const value = filter[key];
    if (typeof value !== "string" || !validValue(value)) continue;
    if (key === "status" && !statuses[tab]?.includes(value)) continue;
    result[key] = value;
  }
  return result;
}

export function routeForTab(tab: AdminTab): AdminRoute {
  if (tab === "customers") return { tab, customerId: null, section: "overview", filter: {} };
  if (tab === "plans") return { tab, view: "plans", filter: {} };
  return { tab, filter: {} };
}

export function routeForTarget(target: NavigationTarget): AdminRoute {
  const filter = urlFilters(target.tab, target.filter);
  if (target.tab === "customers") {
    const customerId = target.selectCustomerId !== undefined && validValue(target.selectCustomerId, 512) ? target.selectCustomerId : null;
    return { tab: "customers", customerId, section: target.customerSection ?? "overview", filter };
  }
  if (target.tab === "plans") return { tab: "plans", view: target.catalogView ?? "plans", filter };
  return { tab: target.tab, filter };
}

export function targetForRoute(route: AdminRoute): NavigationTarget {
  if (route.tab === "customers") {
    return { tab: route.tab, filter: route.filter, ...(route.customerId === null ? {} : { selectCustomerId: route.customerId }), customerSection: route.section };
  }
  if (route.tab === "plans") return { tab: route.tab, filter: route.filter, catalogView: route.view };
  return { tab: route.tab, filter: route.filter };
}

export function hashForRoute(route: AdminRoute): string {
  let path = `#/${route.tab}`;
  const params = new URLSearchParams(urlFilters(route.tab, route.filter));
  if (route.tab === "customers" && route.customerId !== null) {
    path += `/${encodeURIComponent(route.customerId)}`;
    if (route.section !== "overview") params.set("section", route.section);
    // An app drill-down is addressable only on the access section, so nothing else is ever written.
    if (route.section === "access" && route.access !== undefined) {
      params.set("app", route.access.app);
      if (route.access.view !== "grants") params.set("view", route.access.view);
      // Manage access writes a marker only: the grant (whose id encodes the license fingerprint)
      // stays in the in-memory history entry, like the entitlement id filters above.
      else if (route.access.manage) params.set("manage", "1");
    }
  }
  if (route.tab === "plans") {
    if (route.view !== "plans") params.set("view", route.view);
    // Plan ids are non-secret catalog keys; a plan detail exists only on the Plans view.
    else if (route.plan !== undefined) params.set("plan", route.plan);
  }
  return `${path}${params.size === 0 ? "" : `?${params.toString()}`}`;
}

/** Whether a route is a Manage access entry, whose grant exists only in memory. */
export function managesGrant(route: AdminRoute): boolean {
  return route.tab === "customers" && route.access?.manage === true;
}

/** The app's access grants beneath a Manage access entry; any other route is returned unchanged. */
export function withoutManagedGrant(route: AdminRoute): AdminRoute {
  return route.tab === "customers" && route.access?.manage === true ? { ...route, access: { ...route.access, manage: false } } : route;
}

export function hashForTarget(target: NavigationTarget): string {
  return hashForRoute(routeForTarget(target));
}

export interface ParsedAdminRoute {
  route: AdminRoute;
  invalid: boolean;
}

export function parseAdminHash(hash: string): ParsedAdminRoute {
  const fallback = (): ParsedAdminRoute => ({ route: routeForTab("overview"), invalid: true });
  if (hash === "" || hash === "#" || hash === "#/") return { route: routeForTab("overview"), invalid: false };
  if (!hash.startsWith("#/") || /%(?![\da-f]{2})/iu.test(hash)) return fallback();
  const [path, query = "", extra] = hash.slice(2).split("?");
  if (extra !== undefined) return fallback();
  const parts = path.split("/");
  const tab = parts[0] as AdminTab;
  if (!tabs.includes(tab) || parts.length > (tab === "customers" ? 2 : 1)) return fallback();
  const params = new URLSearchParams(query);
  // Duplicate keys have no unambiguous navigation meaning.
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return fallback();
  const filter = urlFilters(tab, Object.fromEntries(params));
  if (tab === "customers") {
    let customerId: string | null = null;
    if (parts.length === 2) {
      try { customerId = decodeURIComponent(parts[1]); } catch { return fallback(); }
      if (!validValue(customerId, 512)) return fallback();
    }
    const section = params.get("section") ?? "overview";
    if (!customerSections.includes(section as CustomerSection) || (customerId === null && section !== "overview")) return fallback();
    const route = { tab, customerId, section: section as CustomerSection, filter };
    const app = params.get("app");
    const view = params.get("view");
    const manage = params.get("manage");
    // A record view or the Manage access marker without an app has no meaning.
    if (app === null) return view === null && manage === null ? { route, invalid: false } : fallback();
    const accessView = view ?? "grants";
    if (section !== "access" || !validValue(app) || !customerAccessViews.includes(accessView as CustomerAccessView)) return fallback();
    // Manage access is opened only from an app's access grants.
    if (manage !== null && (manage !== "1" || accessView !== "grants")) return fallback();
    return { route: { ...route, access: { app, view: accessView as CustomerAccessView, manage: manage !== null } }, invalid: false };
  }
  if (tab === "plans") {
    const view = params.get("view") ?? "plans";
    if (!catalogViews.includes(view as CatalogView)) return fallback();
    const plan = params.get("plan");
    if (plan === null) return { route: { tab, view: view as CatalogView, filter }, invalid: false };
    if (view !== "plans" || !validValue(plan)) return fallback();
    return { route: { tab, view, filter, plan }, invalid: false };
  }
  return { route: { tab, filter }, invalid: false };
}
