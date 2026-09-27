import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { AdminRoute, AdminTab, CatalogView, CustomerAccessRoute, CustomerAccessView, CustomerSection, ManagedGrant, NavigationIntent, NavigationTarget } from "./types";
import { hashForRoute, managesGrant, parseAdminHash, routeForTab, routeForTarget, targetForRoute, withoutManagedGrant } from "./navigationState";
import { useOperatorControls } from "../shared/controls";
import { focusWorkspaceTarget, usableFocusTarget } from "../shared/workspaceFocus";

interface NavigationGuard {
  /** A function is evaluated when the operator tries to leave, so it reads current state rather than the last render's. */
  when: boolean | (() => boolean);
  message?: string;
  onDiscard: () => void;
}

interface NavigationEntry {
  index: number;
  key: number;
  route: AdminRoute;
  target: NavigationTarget | null;
  scrollY: number;
  focus: HTMLElement | null;
  focusRow: string | null;
  /** Set exactly when the route is a Manage access entry; held only in this in-memory map. */
  grant: ManagedGrant | null;
}

interface NavigationContextValue {
  route: AdminRoute;
  selectedCustomerId: string | null;
  customerSection: CustomerSection;
  customerAccess: CustomerAccessRoute | null;
  managedGrant: ManagedGrant | null;
  catalogView: CatalogView;
  catalogPlan: string | null;
  navigationNotice: string | null;
  navigationIntent: NavigationIntent | null;
  navigationVersion: number;
  onNavigationHandled: (intent: NavigationIntent) => void;
  navigate: (target: NavigationTarget) => boolean;
  navigateTab: (tab: AdminTab) => boolean;
  rememberFilters: (tab: AdminTab, filter: Readonly<Record<string, string>>) => void;
  openCustomer: (id: string, section?: CustomerSection) => boolean;
  showCustomerList: () => void;
  setCustomerSection: (section: CustomerSection) => boolean;
  /** Opens one app's records (or all apps, for null) on the selected customer's access section. */
  setCustomerAccess: (access: { app: string; view: CustomerAccessView } | null) => boolean;
  openManagedGrant: (grant: ManagedGrant) => boolean;
  closeManagedGrant: () => boolean;
  setCatalogView: (view: CatalogView) => boolean;
  /** Opens a plan's detail (or the plans list, for null) on the catalog Plans view. */
  setCatalogPlan: (planId: string | null) => boolean;
  /**
   * A deep-linked app or plan that does not exist: replace this entry with its list, once, and say
   * why. It acts only while the current entry still names exactly that customer's app or that plan.
   */
  resolveMissingDrillDown: (missing: MissingDrillDown) => void;
  requestLeave: (action: () => void) => boolean;
  registerGuard: (read: () => NavigationGuard) => () => void;
}

type MissingDrillDown = { kind: "app"; customerId: string; app: string } | { kind: "plan"; planId: string };

const NavigationContext = createContext<NavigationContextValue | null>(null);
const historyKey = "licenseccAdminNavigation";
/** In-memory entries this far from the current one are dropped; the browser keeps their addresses. */
const retainedEntries = 50;
const unrecognizedNotice = "This workspace address is not recognized. Overview is shown.";
const reopenManagedNotice = "Reopen Manage access from the list.";
const missingNotice = { app: "That app was not found for this customer. All apps are shown.", plan: "That plan was not found. The plans list is shown." };

function guardActive(guard: NavigationGuard): boolean {
  return typeof guard.when === "function" ? guard.when() : guard.when;
}

/** A Manage access grant lives only in memory, so an address that names one without it reopens the app's access grants. */
function resolveAddress(hash: string): { parsed: ReturnType<typeof parseAdminHash>; route: AdminRoute; notice: string | null } {
  const parsed = parseAdminHash(hash);
  return { parsed, route: withoutManagedGrant(parsed.route), notice: parsed.invalid ? unrecognizedNotice : managesGrant(parsed.route) ? reopenManagedNotice : null };
}

export function AdminNavigationProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [initial] = useState(() => resolveAddress(window.location.hash));
  const [route, setRoute] = useState(initial.route);
  const [managedGrant, setManagedGrant] = useState<ManagedGrant | null>(null);
  const [navigationNotice, setNavigationNotice] = useState<string | null>(initial.notice);
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent | null>({ ...targetForRoute(initial.route), id: 1 });
  const [navigationVersion, setNavigationVersion] = useState(0);
  const nextKey = useRef(1);
  const intentId = useRef(1);
  const session = useRef(crypto.randomUUID());
  const entry = useRef<NavigationEntry>({ index: 0, key: 1, route: initial.route, target: targetForRoute(initial.route), scrollY: 0, focus: null, focusRow: null, grant: null });
  const entries = useRef(new Map<number, NavigationEntry>());
  const guards = useRef(new Set<() => NavigationGuard>());
  const pendingFocus = useRef<NavigationEntry | "heading" | null>(null);
  const restoringKey = useRef<number | null>(null);
  const seenBrowserEntry = useRef("");
  const { modalActive } = useOperatorControls();
  const modalActiveRef = useRef(modalActive);
  modalActiveRef.current = modalActive;

  const writeHistory = useCallback((next: NavigationEntry, replace: boolean): void => {
    const existing = window.history.state;
    const state = {
      ...(existing !== null && typeof existing === "object" ? existing : {}),
      [historyKey]: { session: session.current, key: next.key, index: next.index },
    };
    // Session-only queries and drafts never enter the URL or history.state.
    window.history[replace ? "replaceState" : "pushState"](state, "", hashForRoute(next.route));
    seenBrowserEntry.current = `${next.key}:${window.location.hash}`;
  }, []);

  const savePosition = useCallback((): void => {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    entry.current.scrollY = window.scrollY;
    entry.current.focus = focus;
    entry.current.focusRow = focus?.closest<HTMLElement>("[data-focus-row]")?.dataset.focusRow ?? null;
    entries.current.set(entry.current.key, entry.current);
  }, []);

  // True while a requestLeave action runs. That leave is already settled (nothing was unsaved, or
  // the operator chose to discard), and guards read again in the same event would still see the
  // render from before the discard, so a navigation inside the action is not asked twice.
  const leaveApproved = useRef(false);
  const allowLeave = useCallback((): boolean => {
    if (leaveApproved.current) return true;
    if (modalActiveRef.current) return false;
    const dirty = [...guards.current].map((read) => read()).filter(guardActive);
    if (dirty.length === 0) return true;
    const message = dirty[0].message ?? "Discard your unsaved changes? Choose Cancel to keep editing.";
    if (!window.confirm(message)) return false;
    for (const guard of dirty) guard.onDiscard();
    return true;
  }, []);

  const applyEntry = useCallback((next: NavigationEntry, notice: string | null, restore: boolean): void => {
    entry.current = next;
    entries.current.set(next.key, next);
    // Bound the in-memory map (and the elements its saved focus holds); a dropped entry is resolved
    // again from its address if the operator ever travels that far.
    for (const [key, value] of entries.current) if (Math.abs(value.index - next.index) > retainedEntries) entries.current.delete(key);
    intentId.current += 1;
    setRoute(next.route);
    setManagedGrant(next.grant);
    setNavigationNotice(notice);
    setNavigationIntent(next.target === null ? null : { ...next.target, id: intentId.current });
    pendingFocus.current = restore ? next : "heading";
    setNavigationVersion((version) => version + 1);
  }, []);

  const transition = useCallback((nextRoute: AdminRoute, target: NavigationTarget | null = null, grant: ManagedGrant | null = null): boolean => {
    const same = hashForRoute(nextRoute) === hashForRoute(entry.current.route);
    if (same && target === null) {
      pendingFocus.current = "heading";
      setNavigationVersion((version) => version + 1);
      return true;
    }
    if (!allowLeave()) return false;
    savePosition();
    const next: NavigationEntry = { index: entry.current.index + 1, key: ++nextKey.current, route: nextRoute, target, scrollY: 0, focus: null, focusRow: null, grant };
    // A new branch discards only our in-memory forward navigation entries.
    for (const [key, value] of entries.current) if (value.index >= next.index) entries.current.delete(key);
    writeHistory(next, false);
    applyEntry(next, null, false);
    return true;
  }, [allowLeave, applyEntry, savePosition, writeHistory]);

  useLayoutEffect(() => {
    entries.current.set(entry.current.key, entry.current);
    writeHistory(entry.current, true);
    const oldScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const changed = (): void => {
      const marker = window.history.state?.[historyKey] as { session?: string; key?: number; index?: number } | undefined;
      const known = marker?.session === session.current && marker.key !== undefined ? entries.current.get(marker.key) : undefined;
      // A same-session entry whose memory was dropped still knows its place in this history.
      const index = known?.index ?? (marker?.session === session.current && typeof marker.index === "number" ? marker.index : undefined);
      const observed = `${known?.key ?? "external"}:${window.location.hash}`;
      if (observed === seenBrowserEntry.current) return;
      seenBrowserEntry.current = observed;
      if (restoringKey.current !== null) {
        if (known?.key === restoringKey.current) restoringKey.current = null;
        return;
      }
      const address = resolveAddress(window.location.hash);
      // A known entry restores with its in-memory grant; any other Manage access address has lost it.
      const sameKnownRoute = known !== undefined && hashForRoute(known.route) === hashForRoute(address.parsed.route);
      if (!allowLeave()) {
        restoringKey.current = entry.current.key;
        const distance = index === undefined ? -1 : entry.current.index - index;
        if (distance === 0) {
          writeHistory(entry.current, true);
          restoringKey.current = null;
        } else window.history.go(distance);
        return;
      }
      savePosition();
      const next: NavigationEntry = sameKnownRoute ? known : {
        index: index ?? entry.current.index + 1,
        key: ++nextKey.current,
        route: address.route,
        target: targetForRoute(address.route),
        scrollY: 0,
        focus: null,
        focusRow: null,
        grant: null,
      };
      writeHistory(next, true);
      applyEntry(next, sameKnownRoute && !address.parsed.invalid ? null : address.notice, sameKnownRoute);
    };
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (![...guards.current].some((read) => guardActive(read()))) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("beforeunload", beforeUnload);
      window.history.scrollRestoration = oldScrollRestoration;
    };
  }, [allowLeave, applyEntry, savePosition, writeHistory]);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === null) return;
    const key = entry.current.key;
    const focusAtSchedule = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement !== focusAtSchedule && document.activeElement instanceof HTMLElement && usableFocusTarget(document.activeElement)) return;
      if (key !== entry.current.key || modalActiveRef.current) return;
      let focus = target === "heading" ? null : target.focus;
      if (target !== "heading" && !usableFocusTarget(focus) && target.focusRow !== null) {
        const row = [...document.querySelectorAll<HTMLElement>("[data-focus-row]")].find((candidate) => candidate.dataset.focusRow === target.focusRow && usableFocusTarget(candidate));
        focus = Array.from(row?.querySelectorAll<HTMLElement>("[data-navigation-focus], button:not([disabled]), a[href]") ?? []).find(usableFocusTarget) ?? null;
      }
      focusWorkspaceTarget(usableFocusTarget(focus) ? focus : undefined);
      window.scrollTo({ top: target === "heading" ? 0 : target.scrollY, behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationVersion]);

  const navigate = useCallback((target: NavigationTarget): boolean => transition(routeForTarget(target), target), [transition]);
  const navigateTab = useCallback((tab: AdminTab): boolean => transition(routeForTab(tab)), [transition]);
  const rememberFilters = useCallback((tab: AdminTab, filter: Readonly<Record<string, string>>): void => {
    const current = entry.current;
    if (current.route.tab !== tab) return;
    const remembered = current.target?.filter;
    if (remembered !== undefined && Object.keys(remembered).length === Object.keys(filter).length && Object.entries(filter).every(([key, value]) => remembered[key] === value)) return;
    const target = { ...targetForRoute(current.route), filter: { ...filter } };
    const next: NavigationEntry = { ...current, route: routeForTarget(target), target };
    entry.current = next;
    entries.current.set(next.key, next);
    // Editing list filters updates this entry without navigation, focus changes,
    // or a new intent. Private query text stays in the in-memory target only.
    writeHistory(next, true);
    if (hashForRoute(next.route) !== hashForRoute(current.route)) setRoute(next.route);
  }, [writeHistory]);
  const openCustomer = useCallback((id: string, section: CustomerSection = "overview"): boolean => transition(routeForTarget({ tab: "customers", filter: entry.current.route.tab === "customers" ? entry.current.route.filter : {}, selectCustomerId: id, customerSection: section })), [transition]);
  const showCustomerList = useCallback((): void => {
    const previous = [...entries.current.values()].filter((candidate) => candidate.index < entry.current.index && candidate.route.tab === "customers" && candidate.route.customerId === null).sort((a, b) => b.index - a.index)[0];
    if (previous !== undefined) window.history.go(previous.index - entry.current.index);
    else transition(routeForTab("customers"));
  }, [transition]);
  const setCustomerSection = useCallback((section: CustomerSection): boolean => {
    const current = entry.current.route;
    return current.tab === "customers" && current.customerId !== null ? transition({ tab: "customers", customerId: current.customerId, section, filter: current.filter }) : false;
  }, [transition]);
  const setCustomerAccess = useCallback((access: { app: string; view: CustomerAccessView } | null): boolean => {
    const current = entry.current.route;
    if (current.tab !== "customers" || current.customerId === null) return false;
    const section = { tab: "customers" as const, customerId: current.customerId, section: "access" as const, filter: current.filter };
    return transition(access === null ? section : { ...section, access: { ...access, manage: false } });
  }, [transition]);
  const openManagedGrant = useCallback((grant: ManagedGrant): boolean => {
    const current = entry.current.route;
    if (current.tab !== "customers" || current.access === undefined || current.customerId !== grant.customer_id || current.access.app !== grant.project) return false;
    return transition({ ...current, section: "access", access: { app: grant.project, view: "grants", manage: true } }, null, grant);
  }, [transition]);
  const closeManagedGrant = useCallback((): boolean => transition(withoutManagedGrant(entry.current.route)), [transition]);
  const setCatalogView = useCallback((view: CatalogView): boolean => transition({ tab: "plans", view, filter: {} }), [transition]);
  const setCatalogPlan = useCallback((planId: string | null): boolean => {
    const current = entry.current.route;
    const filter = current.tab === "plans" ? current.filter : {};
    return transition(planId === null ? { tab: "plans", view: "plans", filter } : { tab: "plans", view: "plans", filter, plan: planId });
  }, [transition]);
  const resolveMissingDrillDown = useCallback((missing: MissingDrillDown): void => {
    const current = entry.current;
    const { route: at } = current;
    const parent: AdminRoute | null = missing.kind === "app" && at.tab === "customers" && at.customerId === missing.customerId && at.access?.app === missing.app
      ? { tab: "customers", customerId: at.customerId, section: at.section, filter: at.filter }
      : missing.kind === "plan" && at.tab === "plans" && at.plan === missing.planId ? { tab: "plans", view: at.view, filter: at.filter } : null;
    if (parent === null) return;
    // Resolution, not navigation: one replaceState and no guard, focus move, or new entry.
    const next: NavigationEntry = { ...current, route: parent, grant: null };
    entry.current = next;
    entries.current.set(next.key, next);
    writeHistory(next, true);
    setRoute(parent);
    setManagedGrant(null);
    setNavigationNotice(missingNotice[missing.kind]);
  }, [writeHistory]);
  const onNavigationHandled = useCallback((intent: NavigationIntent): void => setNavigationIntent((current) => current?.id === intent.id ? null : current), []);
  const requestLeave = useCallback((action: () => void): boolean => {
    if (!allowLeave()) return false;
    const outer = leaveApproved.current;
    leaveApproved.current = true;
    try {
      action();
    } finally {
      leaveApproved.current = outer;
    }
    return true;
  }, [allowLeave]);
  const registerGuard = useCallback((read: () => NavigationGuard): (() => void) => {
    guards.current.add(read);
    return () => { guards.current.delete(read); };
  }, []);

  const customerAccess = route.tab === "customers" && route.section === "access" ? route.access ?? null : null;
  return <NavigationContext.Provider value={{
    route, selectedCustomerId: route.tab === "customers" ? route.customerId : null, customerSection: route.tab === "customers" ? route.section : "overview",
    customerAccess, managedGrant: customerAccess?.manage === true ? managedGrant : null,
    catalogView: route.tab === "plans" ? route.view : "plans", catalogPlan: route.tab === "plans" ? route.plan ?? null : null,
    navigationNotice, navigationIntent, navigationVersion, onNavigationHandled, navigate, navigateTab, rememberFilters, openCustomer, showCustomerList, setCustomerSection,
    setCustomerAccess, openManagedGrant, closeManagedGrant, setCatalogView, setCatalogPlan, resolveMissingDrillDown, requestLeave, registerGuard,
  }}>{children}</NavigationContext.Provider>;
}

export function useAdminNavigation(): NavigationContextValue {
  const value = useContext(NavigationContext);
  if (value === null) throw new Error("admin_navigation_provider_required");
  return value;
}

export function useNavigationGuard(guard: NavigationGuard): { requestLeave: (action: () => void) => boolean } {
  const current = useRef(guard);
  current.current = guard;
  const { registerGuard, requestLeave } = useAdminNavigation();
  useEffect(() => registerGuard(() => current.current), [registerGuard]);
  return { requestLeave };
}
