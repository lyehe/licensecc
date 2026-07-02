import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  EntitlementRecord,
  ExpiringEntitlement,
  Policy,
  TimeseriesBucket,
  WebhookDelivery,
  WebhookEndpoint,
} from "../shared/api";
import {
  EntitlementAction,
  SearchResult,
  TimeseriesRange,
  TIMESERIES_RANGE_DAYS,
  WebhookAction,
  areaPathScaled,
  barRects,
  batchBody,
  batchPath,
  canEditEntitlement,
  canRunAction,
  canRunCustomerAction,
  canRunPolicyAction,
  canRunWebhookAction,
  csvExportPath,
  customerDetailPath,
  customerTransitionPath,
  customersPath,
  disableCustomerConfirm,
  disablePolicyConfirm,
  disableWebhookConfirm,
  editFormFromEntitlement,
  emptyEntitlementEditForm,
  emptyEntitlementForm,
  emptyPolicyForm,
  emptyWebhookForm,
  entitlementHealth,
  entitlementsPath,
  expiringPath,
  formatEpoch,
  isEmptySeries,
  licensesPath,
  linePath,
  linePathScaled,
  navigationForResult,
  normalizeCreateFromPolicy,
  normalizeEntitlementForm,
  normalizeEntitlementPatch,
  normalizePolicyForm,
  normalizeWebhookForm,
  ordersPath,
  patchPath,
  policiesPath,
  policyTransitionPath,
  releaseSeatsConfirm,
  releaseSeatsPath,
  revokeEntitlementConfirm,
  searchPath,
  shortHash,
  summarizeBatchResults,
  timeseriesPath,
  transitionPath,
  webhookDeliveriesPath,
  webhookRedrivePath,
  webhookTransitionPath,
  webhooksPath,
  withCursor,
} from "./operatorWorkflow";
import type { BatchRowResult, BarRect, EntitlementHealth } from "./operatorWorkflow";
import "./styles.css";

interface Summary {
  entitlements: {
    total: number;
    active: number;
    revoked: number;
    disabled: number;
  };
}

interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
}

interface EventItem {
  id: number;
  event_type: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  source: string;
  actor: string;
  actor_type: string;
  revocation_seq: number;
  created_at: number;
}

interface CustomerListItem {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  external_ref: string;
  created_at: number;
  updated_at: number;
  entitlement_count: number;
  active_entitlement_count: number;
}

interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    email: string;
    status: string;
    external_ref: string;
    metadata_json: string;
    created_at: number;
    updated_at: number;
  };
  entitlements: Array<{
    project: string;
    feature: string;
    license_fingerprint: string;
    status: string;
    valid_from: number | null;
    valid_until: number | null;
    revocation_seq: number;
    updated_at: number;
  }>;
  account_tokens: Array<{
    id: string;
    token_prefix: string;
    name: string;
    status: string;
    scopes_json: string;
    expires_at: number | null;
    last_used_at: number | null;
    created_at: number;
  }>;
  licenses: Array<{
    id: string;
    project: string;
    label: string;
    created_at: number;
    updated_at: number;
  }>;
  orders: Array<{
    subscription_id: string;
    project: string;
    feature: string;
    license_fingerprint: string;
    last_seq: number;
    order_epoch: number;
    updated_at: number;
  }>;
  events: Array<{
    id: number;
    event_type: string;
    prev_status: string;
    next_status: string;
    actor: string;
    actor_type: string;
    reason: string;
    created_at: number;
  }>;
}

interface LicenseListItem {
  id: string;
  customer_id: string;
  project: string;
  label: string;
  created_at: number;
  updated_at: number;
}

interface OrderEventItem {
  event_id: number;
  subscription_id: string;
  project: string;
  feature: string;
  order_epoch: number;
  seq: number;
  intent: string;
  key_id: string;
  status: string;
  received_at: number;
  processed_at: number | null;
  stale: boolean;
}

interface FulfillmentSummary {
  accepted: number;
  processed: number;
  superseded: number;
  rejected: number;
  stale_accepted: number;
}

interface OrdersResponse {
  items: OrderEventItem[];
  summary: FulfillmentSummary;
  stale_secs: number;
  next_cursor: string | null;
}

interface Report {
  generated_at: number;
  entitlements: { total: number; active: number; revoked: number; disabled: number };
  customers: { total: number; active: number; disabled: number };
  account_tokens: { active: number };
  licenses: { total: number };
  fulfillment: {
    accepted: number;
    processed: number;
    superseded: number;
    rejected: number;
    stale_accepted: number;
    events_24h: number;
    events_7d: number;
  };
  customer_suspensions_7d: number;
}

// ── Workstream F: usage-analytics time-series + expiring-soon response shapes ──
interface TimeseriesData {
  from: number;
  to: number;
  bucket_seconds: number;
  buckets: TimeseriesBucket[];
}

interface ExpiringData {
  items: ExpiringEntitlement[];
  next_cursor: string | null;
}

// ── Inline-SVG chart geometry constants (the viewBox the geometry helpers scale into) ──
// The SVGs use a fixed viewBox and scale to the container via CSS (width:100%), so the geometry
// helpers work in a stable coordinate space. CHART_PAD insets the line stroke from the top/bottom edge.
const CHART_WIDTH = 600;
const CHART_HEIGHT = 120;
const CHART_PAD = 6;

// A small line/area chart for two series sharing one y-scale (checkouts area + denials line). The
// SVG carries ONLY geometry + an aria-label; every colour/stroke/fill comes from the CSS classes.
// An empty-or-all-zero `checkouts`+`denials` renders the empty-state instead of a flat chart.
function LineAreaChart({
  checkouts,
  denials,
  label,
}: {
  checkouts: number[];
  denials: number[];
  label: string;
}): React.ReactElement {
  if (isEmptySeries(checkouts) && isEmptySeries(denials)) {
    return <div className="chartEmpty muted">No usage activity in this window.</div>;
  }
  // Both series share ONE scale (the combined min/max) so the denials line reads relative to checkouts.
  const combined = [...checkouts, ...denials];
  const scaleMin = Math.min(...combined);
  const scaleMax = Math.max(...combined);
  // Area + checkouts line on the shared scale; the denials line on the SAME scale so the two lines
  // are directly comparable on one axis.
  const area = areaPathScaled(checkouts, scaleMin, scaleMax, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  const checkoutLine = linePathScaled(checkouts, scaleMin, scaleMax, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  const denialLine = linePathScaled(denials, scaleMin, scaleMax, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  return (
    <svg
      className="chart lineChart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {area !== "" && <path className="chartArea checkoutsArea" d={area} />}
      {checkoutLine !== "" && <path className="chartLine checkoutsLine" d={checkoutLine} fill="none" />}
      {denialLine !== "" && <path className="chartLine denialsLine" d={denialLine} fill="none" />}
    </svg>
  );
}

// A denial-rate trend line (a fraction in [0,1] per bucket). linePath auto-scales to the series'
// own min/max, which is what we want here (the trend's shape matters more than the absolute 0..1).
function DenialRateChart({ rates, label }: { rates: number[]; label: string }): React.ReactElement {
  if (isEmptySeries(rates)) {
    return <div className="chartEmpty muted">No denials in this window.</div>;
  }
  const line = linePath(rates, CHART_WIDTH, CHART_HEIGHT, CHART_PAD);
  return (
    <svg
      className="chart lineChart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path className="chartLine denialRateLine" d={line} fill="none" />
    </svg>
  );
}

// A fulfillment-events-over-time bar spark. barRects scales each bar by the series MAX so a zero
// bucket is a zero-height bar. Empty-or-all-zero renders the empty-state.
function BarSparkChart({ values, label }: { values: number[]; label: string }): React.ReactElement {
  if (isEmptySeries(values)) {
    return <div className="chartEmpty muted">No fulfillment events in this window.</div>;
  }
  const rects: BarRect[] = barRects(values, CHART_WIDTH, CHART_HEIGHT);
  return (
    <svg
      className="chart barChart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {rects.map((rect, i) => (
        <rect key={i} className="chartBar" x={rect.x} y={rect.y} width={rect.w} height={rect.h} />
      ))}
    </svg>
  );
}

// The colored health badge rendered next to an entitlement's status pill. Pure presentational —
// the classification is the unit-tested entitlementHealth helper; the CSS owns the green/amber/red.
function HealthBadge({ status, validUntil, now }: { status: string; validUntil: number | null | undefined; now: number }): React.ReactElement {
  const health: EntitlementHealth = entitlementHealth(status, validUntil, now);
  return <span className={`healthBadge health-${health}`}>{health}</span>;
}

async function api<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return response.json() as Promise<ApiEnvelope<T>>;
}

function App(): React.ReactElement {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementRecord[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [activeTab, setActiveTab] = useState<
    "overview" | "entitlements" | "policies" | "webhooks" | "events" | "customers" | "licenses" | "fulfillment" | "reports"
  >("overview");
  const [form, setForm] = useState(emptyEntitlementForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyEntitlementEditForm);
  const [reason, setReason] = useState("");
  // A ref mirroring `reason` so a mutation invoked from the typed-confirm modal reads the LATEST reason
  // (the modal lets the operator type the reason AFTER opening, which would otherwise be a stale-closure
  // capture). currentReason() is the single read point for every reason-carrying mutation.
  const reasonRef = useRef("");
  reasonRef.current = reason;
  const currentReason = (): string => reasonRef.current;
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState({ project: "", feature: "", status: "" });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Pagination cursors: the API returns next_cursor for each list; null = no more pages.
  const [entitlementsCursor, setEntitlementsCursor] = useState<string | null>(null);
  const [customersCursor, setCustomersCursor] = useState<string | null>(null);
  const [licensesCursor, setLicensesCursor] = useState<string | null>(null);

  // Typed-confirm modal for irreversible / broad-blast actions (Revoke entitlement, Disable customer).
  const [confirmAction, setConfirmAction] = useState<
    { title: string; body: string; requiresReason: boolean; run: () => Promise<void> } | null
  >(null);

  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [customerFilter, setCustomerFilter] = useState({ status: "", q: "" });
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);

  const [licenses, setLicenses] = useState<LicenseListItem[]>([]);
  const [licenseFilter, setLicenseFilter] = useState({ project: "", customer_id: "", q: "" });

  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [orderFilter, setOrderFilter] = useState({ status: "", subscription_id: "" });

  const [report, setReport] = useState<Report | null>(null);

  // Workstream F — usage-analytics time-series (Reports + Fulfillment charts). `range` is the
  // last-N-days look-back; the data is the bucketed [from,to] response. `now` is captured once per
  // load so the from/to window is stable across the render. The Fulfillment bar spark reuses the
  // SAME data (no second fetch — the timeseries carries fulfillment_events per bucket).
  const [timeseriesRange, setTimeseriesRange] = useState<TimeseriesRange>(7);
  const [timeseries, setTimeseries] = useState<TimeseriesData | null>(null);

  // Workstream F — expiring-soon panel (Reports tab). `withinDays` is the 7/30/90 horizon.
  const [expiringWithinDays, setExpiringWithinDays] = useState(30);
  const [expiring, setExpiring] = useState<ExpiringEntitlement[]>([]);
  const [expiringCursor, setExpiringCursor] = useState<string | null>(null);

  // Policies tab: list + editor + the active-policy options that feed the entitlement create <select>.
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyFilter, setPolicyFilter] = useState({ project: "", type: "", status: "" });
  const [policiesCursor, setPoliciesCursor] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState(emptyPolicyForm);
  // Active policies offered in the entitlement create form's policy <select> (loaded on demand).
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);

  // Webhooks tab (audit R6.5): endpoint list + editor + a recent-deliveries pane. The delivery
  // filter can pin to one endpoint (set when the operator clicks "Deliveries" on a row).
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookFilter, setWebhookFilter] = useState({ status: "" });
  const [webhooksCursor, setWebhooksCursor] = useState<string | null>(null);
  const [webhookForm, setWebhookForm] = useState(emptyWebhookForm);
  const [webhookDeliveries, setWebhookDeliveries] = useState<WebhookDelivery[]>([]);
  const [webhookDeliveryFilter, setWebhookDeliveryFilter] = useState({ endpoint_id: "", status: "" });

  // Workstream C — BULK: the ids of the entitlement rows the operator has checked. A bulk-action bar
  // appears when >=1 is selected; clicking a bulk action routes through the typed-confirm modal.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Workstream C — GLOBAL SEARCH: the header search box query, its results, and whether the dropdown
  // is open. Results are mixed-type; clicking one deep-links via navigationForResult.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

  const entitlementsUrl = useMemo(() => {
    return entitlementsPath(filter);
  }, [filter]);

  const customersUrl = useMemo(() => customersPath(customerFilter), [customerFilter]);
  const licensesUrl = useMemo(() => licensesPath(licenseFilter), [licenseFilter]);
  const ordersUrl = useMemo(() => ordersPath(orderFilter), [orderFilter]);
  const policiesUrl = useMemo(() => policiesPath(policyFilter), [policyFilter]);
  const webhooksUrl = useMemo(() => webhooksPath(webhookFilter), [webhookFilter]);
  const webhookDeliveriesUrl = useMemo(() => webhookDeliveriesPath(webhookDeliveryFilter), [webhookDeliveryFilter]);

  async function refresh(): Promise<void> {
    const [summaryResponse, entitlementResponse, eventResponse] = await Promise.all([
      api<Summary>("/api/admin/summary"),
      api<{ items: EntitlementRecord[]; next_cursor: string | null }>(entitlementsUrl),
      api<{ items: EventItem[] }>("/api/admin/events"),
    ]);
    if (summaryResponse.ok && summaryResponse.data) setSummary(summaryResponse.data);
    if (entitlementResponse.ok && entitlementResponse.data) {
      setEntitlements(entitlementResponse.data.items);
      setEntitlementsCursor(entitlementResponse.data.next_cursor ?? null);
    }
    if (eventResponse.ok && eventResponse.data) setEvents(eventResponse.data.items);
    const failed = [summaryResponse, entitlementResponse, eventResponse].find((item) => !item.ok);
    if (failed) setMessage(`${failed.code} (${failed.request_id})`);
  }

  // Fetch the next page (cursor != null) for a flat-list resource and APPEND it. The API returns
  // next_cursor; this consumes it so operators can page past the first 50/100 rows (without it,
  // every list was silently first-page-only).
  async function loadMore<T>(
    url: string,
    cursor: string | null,
    setItems: React.Dispatch<React.SetStateAction<T[]>>,
    setCursor: React.Dispatch<React.SetStateAction<string | null>>,
  ): Promise<void> {
    if (cursor === null) {
      return;
    }
    const response = await api<{ items: T[]; next_cursor: string | null }>(withCursor(url, cursor));
    if (response.ok && response.data) {
      const data = response.data;
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  // Orders carry their cursor inside the OrdersResponse (alongside the summary), so they page separately.
  async function loadMoreOrders(): Promise<void> {
    if (orders === null || orders.next_cursor === null) {
      return;
    }
    const response = await api<OrdersResponse>(withCursor(ordersUrl, orders.next_cursor));
    if (response.ok && response.data) {
      const data = response.data;
      setOrders((prev) => (prev === null ? data : { ...data, items: [...prev.items, ...data.items] }));
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    void refresh();
  }, [entitlementsUrl]);

  async function loadCustomerDetail(id: string): Promise<void> {
    const response = await api<CustomerDetail>(customerDetailPath(id));
    if (response.ok && response.data) {
      setCustomerDetail(response.data);
    } else {
      setCustomerDetail(null);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (activeTab !== "customers") {
      return;
    }
    void (async () => {
      const response = await api<{ items: CustomerListItem[]; next_cursor: string | null }>(customersUrl);
      if (response.ok && response.data) {
        setCustomers(response.data.items);
        setCustomersCursor(response.data.next_cursor ?? null);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, customersUrl]);

  useEffect(() => {
    if (activeTab !== "customers" || selectedCustomerId === null) {
      return;
    }
    void loadCustomerDetail(selectedCustomerId);
  }, [activeTab, selectedCustomerId]);

  useEffect(() => {
    if (activeTab !== "licenses") {
      return;
    }
    void (async () => {
      const response = await api<{ items: LicenseListItem[]; next_cursor: string | null }>(licensesUrl);
      if (response.ok && response.data) {
        setLicenses(response.data.items);
        setLicensesCursor(response.data.next_cursor ?? null);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, licensesUrl]);

  useEffect(() => {
    if (activeTab !== "fulfillment") {
      return;
    }
    void (async () => {
      const response = await api<OrdersResponse>(ordersUrl);
      if (response.ok && response.data) {
        setOrders(response.data);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, ordersUrl]);

  useEffect(() => {
    if (activeTab !== "reports") {
      return;
    }
    void (async () => {
      const response = await api<Report>("/api/admin/report");
      if (response.ok && response.data) {
        setReport(response.data);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab]);

  // Workstream F — load the bucketed usage time-series for the Reports + Fulfillment charts whenever
  // either tab is open and the range changes. ONE fetch feeds both tabs' charts (the Fulfillment bar
  // spark reads fulfillment_events from the same buckets), so the data is shared, not re-fetched.
  useEffect(() => {
    if (activeTab !== "reports" && activeTab !== "fulfillment") {
      return;
    }
    void (async () => {
      const response = await api<TimeseriesData>(timeseriesPath(timeseriesRange));
      if (response.ok && response.data) {
        setTimeseries(response.data);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, timeseriesRange]);

  // Workstream F — load the expiring-soon list when the Reports tab opens or the horizon changes.
  async function refreshExpiring(): Promise<void> {
    const response = await api<ExpiringData>(expiringPath(expiringWithinDays));
    if (response.ok && response.data) {
      setExpiring(response.data.items);
      setExpiringCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (activeTab !== "reports") {
      return;
    }
    void refreshExpiring();
  }, [activeTab, expiringWithinDays]);

  // Page the next slice of the expiring-soon list (cursor != null) and APPEND it, like the other lists.
  async function loadMoreExpiring(): Promise<void> {
    if (expiringCursor === null) {
      return;
    }
    const response = await api<ExpiringData>(withCursor(expiringPath(expiringWithinDays), expiringCursor));
    if (response.ok && response.data) {
      const data = response.data;
      setExpiring((prev) => [...prev, ...data.items]);
      setExpiringCursor(data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  // Deep-link an expiring-soon row to the Entitlements tab filtered to its exact project + feature
  // (the same destination a global-search entitlement result uses). The operator lands on the grid
  // row to act on it (renew/disable/release).
  function deepLinkToEntitlement(row: ExpiringEntitlement): void {
    setFilter({ project: row.project, feature: row.feature, status: "" });
    setActiveTab("entitlements");
  }

  async function refreshPolicies(): Promise<void> {
    const response = await api<{ items: Policy[]; next_cursor: string | null }>(policiesUrl);
    if (response.ok && response.data) {
      setPolicies(response.data.items);
      setPoliciesCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (activeTab !== "policies") {
      return;
    }
    void refreshPolicies();
  }, [activeTab, policiesUrl]);

  // Load the active policies for the entitlement create <select> when the Entitlements tab opens.
  // Filtered to status=active so disabled templates can't be picked for a new stamp.
  useEffect(() => {
    if (activeTab !== "entitlements") {
      return;
    }
    void (async () => {
      const response = await api<{ items: Policy[]; next_cursor: string | null }>(
        policiesPath({ project: "", type: "", status: "active" }),
      );
      if (response.ok && response.data) {
        setActivePolicies(response.data.items);
      }
    })();
  }, [activeTab]);

  function selectCustomer(id: string): void {
    setSelectedCustomerId(id);
    if (id === selectedCustomerId) {
      void loadCustomerDetail(id);
    }
  }

  async function customerTransition(action: "disable" | "reenable"): Promise<void> {
    if (selectedCustomerId === null) {
      return;
    }
    const id = selectedCustomerId;
    await runMutation(async () => {
      const result = await api<CustomerListItem>(customerTransitionPath(id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await loadCustomerDetail(id);
        const listResponse = await api<{ items: CustomerListItem[]; next_cursor: string | null }>(customersUrl);
        if (listResponse.ok && listResponse.data) {
          setCustomers(listResponse.data.items);
          setCustomersCursor(listResponse.data.next_cursor ?? null);
        }
      }
    });
  }

  // Typed-confirm gate for irreversible / broad-blast actions. The action only fires from the modal's
  // Confirm, which (for reason-required actions) stays disabled until a reason is entered.
  function requestConfirm(action: { title: string; body: string; requiresReason: boolean; run: () => Promise<void> }): void {
    setConfirmAction(action);
  }

  async function confirmProceed(): Promise<void> {
    const action = confirmAction;
    if (action === null || (action.requiresReason && currentReason().trim() === "")) {
      return;
    }
    setConfirmAction(null);
    await action.run();
  }

  useEffect(() => {
    if (confirmAction === null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setConfirmAction(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmAction]);

  async function runMutation(work: () => Promise<void>): Promise<void> {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      // A non-empty policy_id stamps from a policy (normalizeCreateFromPolicy attaches policy_id);
      // empty is a plain direct create. Both share the same EntitlementInput validation/conversion.
      let body: ReturnType<typeof normalizeEntitlementForm> | ReturnType<typeof normalizeCreateFromPolicy>;
      try {
        body = form.policy_id !== "" ? normalizeCreateFromPolicy(form) : normalizeEntitlementForm(form);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_form");
        return;
      }
      const result = await api<EntitlementRecord>("/api/admin/entitlements", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setForm(emptyEntitlementForm);
        await refresh();
      }
    });
  }

  async function submitPolicyCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizePolicyForm>;
      try {
        body = normalizePolicyForm(policyForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_form");
        return;
      }
      const result = await api<Policy>("/api/admin/policies", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setPolicyForm(emptyPolicyForm);
        await refreshPolicies();
      }
    });
  }

  async function policyTransition(policy: Policy, action: "disable" | "reenable"): Promise<void> {
    await runMutation(async () => {
      const result = await api<Policy>(policyTransitionPath(policy.id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await refreshPolicies();
      }
    });
  }

  // ── Webhooks (audit R6.5) ────────────────────────────────────────────────────
  async function refreshWebhooks(): Promise<void> {
    const response = await api<{ items: WebhookEndpoint[]; next_cursor: string | null }>(webhooksUrl);
    if (response.ok && response.data) {
      setWebhooks(response.data.items);
      setWebhooksCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  async function refreshWebhookDeliveries(): Promise<void> {
    const response = await api<{ items: WebhookDelivery[]; next_cursor: string | null }>(webhookDeliveriesUrl);
    if (response.ok && response.data) {
      setWebhookDeliveries(response.data.items);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (activeTab !== "webhooks") {
      return;
    }
    void refreshWebhooks();
  }, [activeTab, webhooksUrl]);

  useEffect(() => {
    if (activeTab !== "webhooks") {
      return;
    }
    void refreshWebhookDeliveries();
  }, [activeTab, webhookDeliveriesUrl]);

  async function submitWebhookCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeWebhookForm>;
      try {
        body = normalizeWebhookForm(webhookForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_form");
        return;
      }
      const result = await api<WebhookEndpoint>("/api/admin/webhooks", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setWebhookForm(emptyWebhookForm);
        await refreshWebhooks();
      }
    });
  }

  async function webhookTransition(endpoint: WebhookEndpoint, action: WebhookAction): Promise<void> {
    await runMutation(async () => {
      const result = await api<WebhookEndpoint>(webhookTransitionPath(endpoint.id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        await refreshWebhooks();
      }
    });
  }

  async function redriveDelivery(delivery: WebhookDelivery): Promise<void> {
    await runMutation(async () => {
      const result = await api<WebhookDelivery>(webhookRedrivePath(String(delivery.id)), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        await refreshWebhookDeliveries();
      }
    });
  }

  // Pin the deliveries pane to one endpoint (the operator clicked "Deliveries" on that row).
  function showDeliveriesForEndpoint(endpointId: string): void {
    setWebhookDeliveryFilter({ endpoint_id: endpointId, status: "" });
  }

  function beginEdit(item: EntitlementRecord): void {
    setEditingId(item.id);
    setEditForm(editFormFromEntitlement(item));
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditForm(emptyEntitlementEditForm);
  }

  async function submitPatch(event: FormEvent, item: EntitlementRecord): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeEntitlementPatch>;
      try {
        body = normalizeEntitlementPatch(editForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_patch");
        return;
      }
      const result = await api<EntitlementRecord>(patchPath(item), {
        method: "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        cancelEdit();
        await refresh();
      }
    });
  }

  async function transition(item: EntitlementRecord, action: "disable" | "reenable" | "revoke"): Promise<void> {
    await runMutation(async () => {
      const result = await api<EntitlementRecord>(transitionPath(item, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason: currentReason() }),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await refresh();
      }
    });
  }

  // ── Workstream F — force-release the live seats stuck on a dead machine ───────
  // Admin-affecting WRITE routed through the typed-confirm modal (reason required). One POST to
  // /entitlements/:id/release-seats reclaims ALL live seats; the status line reports "released N
  // seats" and the lists refresh. Reuses runMutation/busy + the idempotency-key header exactly like
  // the single transitions.
  async function releaseSeats(item: EntitlementRecord): Promise<void> {
    await runMutation(async () => {
      const result = await api<{ released: number; seat_ids: string[] }>(releaseSeatsPath(item.id), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason: currentReason() }),
      });
      if (result.ok && result.data) {
        const n = result.data.released;
        setMessage(`released ${n} seat${n === 1 ? "" : "s"} (${result.request_id})`);
        setReason("");
        await refresh();
      } else {
        setMessage(`${result.code} (${result.request_id})`);
      }
    });
  }

  // ── Workstream C — BULK selection ────────────────────────────────────────────
  // Whenever the entitlement list reloads (filter change OR Load-more append), drop any selection of
  // rows that are no longer present so the bulk bar never acts on a stale/off-page id.
  useEffect(() => {
    setSelectedIds((prev) => {
      const present = new Set(entitlements.map((item) => item.id));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entitlements]);

  function toggleSelected(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Select-all toggles the LOADED rows (the page in view). Checked when every loaded row is selected.
  const allSelected = entitlements.length > 0 && entitlements.every((item) => selectedIds.has(item.id));
  function toggleSelectAll(): void {
    setSelectedIds(allSelected ? new Set() : new Set(entitlements.map((item) => item.id)));
  }

  // Confirm copy for a bulk transition, echoing the action + selected count so the typed-confirm modal
  // names exactly what it will blast (revoke notes the terminal/irreversible nature).
  function bulkConfirmBody(action: EntitlementAction): string {
    const count = selectedIds.size;
    const noun = `${count} selected entitlement${count === 1 ? "" : "s"}`;
    if (action === "revoke") {
      return `Revoke ${noun}. Revocation is TERMINAL and cannot be undone; already-revoked rows are reported as revoked-terminal and skipped.`;
    }
    return `Disable ${noun}. Disabled entitlements stop verifying until re-enabled.`;
  }

  // Run a bulk transition over the selected ids: ONE POST to /entitlements/batch (the backend composes
  // the shared transitionEntitlement per row). Renders the per-row roll-up and refreshes. Reuses the
  // runMutation/busy gate + the idempotency-key header, exactly like the single transitions.
  async function runBatch(action: EntitlementAction): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    await runMutation(async () => {
      const result = await api<{ results: BatchRowResult[] }>(batchPath(), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(batchBody(action, ids, currentReason())),
      });
      if (result.ok && result.data) {
        setMessage(`${action}: ${summarizeBatchResults(result.data.results)} (${result.request_id})`);
        setReason("");
        setSelectedIds(new Set());
        await refresh();
      } else {
        setMessage(`${result.code} (${result.request_id})`);
      }
    });
  }

  // ── Workstream C — GLOBAL SEARCH ─────────────────────────────────────────────
  async function submitSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = searchQuery.trim();
    if (q === "") {
      setSearchResults(null);
      return;
    }
    const response = await api<{ results: SearchResult[] }>(searchPath(q));
    if (response.ok && response.data) {
      setSearchResults(response.data.results);
    } else {
      setSearchResults([]);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  // Deep-link a clicked search result: apply its destination tab's filter, switch tabs, and (for a
  // customer) select it so the detail pane opens. Closes the dropdown. Filters are pure (navigationForResult).
  function navigateToResult(result: SearchResult): void {
    const nav = navigationForResult(result);
    if (nav.tab === "customers") {
      setCustomerFilter({ status: nav.filter.status ?? "", q: nav.filter.q ?? "" });
      if (nav.selectCustomerId !== undefined) {
        setSelectedCustomerId(nav.selectCustomerId);
      }
    } else if (nav.tab === "entitlements") {
      setFilter({ project: nav.filter.project ?? "", feature: nav.filter.feature ?? "", status: nav.filter.status ?? "" });
    } else if (nav.tab === "licenses") {
      setLicenseFilter({ project: nav.filter.project ?? "", customer_id: nav.filter.customer_id ?? "", q: nav.filter.q ?? "" });
    } else {
      setOrderFilter({ status: nav.filter.status ?? "", subscription_id: nav.filter.subscription_id ?? "" });
    }
    setActiveTab(nav.tab);
    setSearchResults(null);
    setSearchQuery("");
  }

  // ── Workstream C — CSV EXPORT ────────────────────────────────────────────────
  // Download the current-filter CSV: fetch the ?format=csv variant of the active list URL and trigger
  // a browser download via an <a download> + object URL. The SAME filters as the on-screen list (the
  // export URL is built from the list URL by the pure csvExportPath helper).
  async function downloadCsv(listUrl: string, filename: string): Promise<void> {
    await runMutation(async () => {
      try {
        const response = await fetch(csvExportPath(listUrl));
        if (!response.ok) {
          setMessage(`csv_export_failed (${response.status})`);
          return;
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        setMessage(`exported ${filename}`);
      } catch {
        setMessage("csv_export_failed");
      }
    });
  }

  // Current epoch seconds, captured once per render for the health badge classification. (The badge
  // is presentational; a per-render snapshot is precise enough and keeps the classifier pure/testable.)
  const nowSeconds = Math.floor(Date.now() / 1000);

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>licensecc admin</h1>
          <p>{message || "ready"}</p>
        </div>
        <form className="globalSearch" onSubmit={(event) => void submitSearch(event)}>
          <input
            type="search"
            placeholder="Search customers, licenses, entitlements, orders"
            aria-label="Global search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button type="submit">Search</button>
          {searchResults !== null && (
            <div className="searchResults" role="listbox" aria-label="Search results">
              <div className="searchResultsHead">
                <span className="muted">{searchResults.length} result{searchResults.length === 1 ? "" : "s"}</span>
                <button type="button" onClick={() => { setSearchResults(null); setSearchQuery(""); }}>Close</button>
              </div>
              {searchResults.length === 0 ? (
                <p className="muted searchEmpty">No matches.</p>
              ) : (
                (["customer", "license", "entitlement", "order"] as const)
                  .filter((type) => searchResults.some((result) => result.type === type))
                  .map((type) => (
                    <div className="searchGroup" key={type}>
                      <h3>{type}s</h3>
                      {searchResults.filter((result) => result.type === type).map((result) => (
                        <button
                          type="button"
                          className="searchResult"
                          role="option"
                          key={`${result.type}:${result.id}`}
                          onClick={() => navigateToResult(result)}
                        >
                          <span className="searchResultLabel">{result.type === "entitlement" || result.type === "license" ? shortHash(result.label) : result.label}</span>
                          <span className="muted searchResultMeta">
                            {result.type === "customer" && (result.email ?? "")}
                            {result.type === "entitlement" && `${result.project ?? ""} / ${result.feature ?? ""}`}
                            {result.type === "license" && `${result.project ?? ""} · ${result.id}`}
                            {result.type === "order" && (result.project ?? "")}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))
              )}
            </div>
          )}
        </form>
        <nav>
          <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Overview</button>
          <button className={activeTab === "entitlements" ? "active" : ""} onClick={() => setActiveTab("entitlements")}>Entitlements</button>
          <button className={activeTab === "policies" ? "active" : ""} onClick={() => setActiveTab("policies")}>Policies</button>
          <button className={activeTab === "webhooks" ? "active" : ""} onClick={() => setActiveTab("webhooks")}>Webhooks</button>
          <button className={activeTab === "events" ? "active" : ""} onClick={() => setActiveTab("events")}>Events</button>
          <button className={activeTab === "customers" ? "active" : ""} onClick={() => setActiveTab("customers")}>Customers</button>
          <button className={activeTab === "licenses" ? "active" : ""} onClick={() => setActiveTab("licenses")}>Licenses</button>
          <button className={activeTab === "fulfillment" ? "active" : ""} onClick={() => setActiveTab("fulfillment")}>Fulfillment</button>
          <button className={activeTab === "reports" ? "active" : ""} onClick={() => setActiveTab("reports")}>Reports</button>
        </nav>
      </header>

      {activeTab === "overview" && (
        <section className="grid metrics">
          <div><span>Total</span><strong>{summary?.entitlements.total ?? 0}</strong></div>
          <div><span>Active</span><strong>{summary?.entitlements.active ?? 0}</strong></div>
          <div><span>Disabled</span><strong>{summary?.entitlements.disabled ?? 0}</strong></div>
          <div><span>Revoked</span><strong>{summary?.entitlements.revoked ?? 0}</strong></div>
        </section>
      )}

      {activeTab === "entitlements" && (
        <section className="workspace">
          <aside>
            <h2>Create</h2>
            <form onSubmit={(event) => void submitCreate(event)}>
              <label>Policy (optional)
                <select value={form.policy_id} onChange={(event) => setForm({ ...form, policy_id: event.target.value })}>
                  <option value="">none (direct create)</option>
                  {activePolicies.map((policy) => (
                    <option key={policy.id} value={policy.id}>{policy.name} ({policy.type})</option>
                  ))}
                </select>
              </label>
              {form.policy_id !== "" && <p className="muted">Stamping from a policy. The fields below override the policy defaults; leave blank to inherit. Requires POLICY_STAMP_MODE=on.</p>}
              <label>Project<input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} /></label>
              <label>Feature<input value={form.feature} onChange={(event) => setForm({ ...form, feature: event.target.value })} /></label>
              <label>Fingerprint<input value={form.license_fingerprint} onChange={(event) => setForm({ ...form, license_fingerprint: event.target.value })} /></label>
              <label>Device hash<input value={form.device_hash} onChange={(event) => setForm({ ...form, device_hash: event.target.value })} /></label>
              <label>Assertion TTL<input type="number" value={form.assertion_ttl_seconds} onChange={(event) => setForm({ ...form, assertion_ttl_seconds: Number(event.target.value) })} /></label>
              <label>Valid from<input type="date" value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} /></label>
              <label>Valid until<input type="date" value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label>
              <label>Customer ID<input value={form.customer_id} onChange={(event) => setForm({ ...form, customer_id: event.target.value })} /></label>
              <label>License ID<input value={form.license_id} onChange={(event) => setForm({ ...form, license_id: event.target.value })} /></label>
              <label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <button disabled={busy} type="submit">Save</button>
            </form>
          </aside>
          <section className="tablePane">
            <div className="filters">
              <input placeholder="project" value={filter.project} onChange={(event) => setFilter({ ...filter, project: event.target.value })} />
              <input placeholder="feature" value={filter.feature} onChange={(event) => setFilter({ ...filter, feature: event.target.value })} />
              <select value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })}>
                <option value="">all</option>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
                <option value="revoked">revoked</option>
              </select>
              <button type="button" disabled={busy} onClick={() => void downloadCsv(entitlementsUrl, "entitlements.csv")}>Export CSV</button>
            </div>
            {selectedIds.size > 0 && (
              <div className="bulkBar">
                <span>{selectedIds.size} selected</span>
                <button type="button" disabled={busy} onClick={() => requestConfirm({ title: "Disable selected entitlements", body: bulkConfirmBody("disable"), requiresReason: true, run: () => runBatch("disable") })}>Disable</button>
                <button type="button" disabled={busy} onClick={() => void runBatch("reenable")}>Reenable</button>
                <button type="button" className="danger" disabled={busy} onClick={() => requestConfirm({ title: "Revoke selected entitlements", body: bulkConfirmBody("revoke"), requiresReason: true, run: () => runBatch("revoke") })}>Revoke selected</button>
                <button type="button" disabled={busy} onClick={() => setSelectedIds(new Set())}>Clear</button>
              </div>
            )}
            <table>
              <thead><tr><th className="checkCol"><input type="checkbox" aria-label="Select all loaded rows" checked={allSelected} onChange={toggleSelectAll} /></th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Details</th><th>Status</th><th>Seq</th><th>Actions</th></tr></thead>
              <tbody>
                {entitlements.map((item) => (
                  <React.Fragment key={item.id}>
                    <tr>
                      <td className="checkCol"><input type="checkbox" aria-label={`Select ${item.project}/${item.feature}`} checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} /></td>
                      <td>{item.project}</td>
                      <td>{item.feature}</td>
                      <td><code>{shortHash(item.license_fingerprint)}</code></td>
                      <td>
                        <div className="details">
                          <span>TTL {item.assertion_ttl_seconds}s</span>
                          <span>Valid {item.valid_from ?? "any"} to {item.valid_until ?? "any"}</span>
                          <span>Customer {item.customer_id ?? "-"}</span>
                          <span>License {item.license_id ?? "-"}</span>
                          {item.notes !== "" && <span>Notes {item.notes}</span>}
                        </div>
                      </td>
                      <td>
                        <span className={`status ${item.status}`}>{item.status}</span>
                        <HealthBadge status={item.status} validUntil={item.valid_until} now={nowSeconds} />
                      </td>
                      <td>{item.revocation_seq}</td>
                      <td className="actions">
                        <button disabled={busy || !canEditEntitlement(item.status)} onClick={() => beginEdit(item)}>Edit</button>
                        <button disabled={busy || !canRunAction(item.status, "disable")} onClick={() => void transition(item, "disable")}>Disable</button>
                        <button disabled={busy || !canRunAction(item.status, "reenable")} onClick={() => void transition(item, "reenable")}>Reenable</button>
                        <button className="danger" disabled={busy || !canRunAction(item.status, "revoke")} onClick={() => requestConfirm({ title: "Revoke entitlement", body: revokeEntitlementConfirm(item), requiresReason: true, run: () => transition(item, "revoke") })}>Revoke</button>
                        <button className="danger" disabled={busy} onClick={() => requestConfirm({ title: "Release seats", body: releaseSeatsConfirm(item), requiresReason: true, run: () => releaseSeats(item) })}>Release seats</button>
                      </td>
                    </tr>
                    {editingId === item.id && (
                      <tr className="editRow">
                        <td colSpan={8}>
                          <form className="editForm" onSubmit={(event) => void submitPatch(event, item)}>
                            <label>Device hash<input value={editForm.device_hash} onChange={(event) => setEditForm({ ...editForm, device_hash: event.target.value })} /></label>
                            <label>Assertion TTL<input type="number" value={editForm.assertion_ttl_seconds} onChange={(event) => setEditForm({ ...editForm, assertion_ttl_seconds: Number(event.target.value) })} /></label>
                            <label>Valid from<input type="date" value={editForm.valid_from} onChange={(event) => setEditForm({ ...editForm, valid_from: event.target.value })} /></label>
                            <label>Valid until<input type="date" value={editForm.valid_until} onChange={(event) => setEditForm({ ...editForm, valid_until: event.target.value })} /></label>
                            <label>Customer ID<input value={editForm.customer_id} onChange={(event) => setEditForm({ ...editForm, customer_id: event.target.value })} /></label>
                            <label>License ID<input value={editForm.license_id} onChange={(event) => setEditForm({ ...editForm, license_id: event.target.value })} /></label>
                            <label className="wide">Notes<textarea value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} /></label>
                            <div className="actions wide">
                              <button disabled={busy} type="submit">Update</button>
                              <button disabled={busy} type="button" onClick={cancelEdit}>Cancel</button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            <div className="tableFooter">
              <span className="muted">{entitlements.length} shown</span>
              {entitlementsCursor !== null && (
                <button type="button" disabled={busy} onClick={() => void loadMore(entitlementsUrl, entitlementsCursor, setEntitlements, setEntitlementsCursor)}>Load more</button>
              )}
            </div>
            <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          </section>
        </section>
      )}

      {activeTab === "policies" && (
        <section className="workspace">
          <aside>
            <h2>Policy editor</h2>
            <form onSubmit={(event) => void submitPolicyCreate(event)}>
              <label>Project<input value={policyForm.project} onChange={(event) => setPolicyForm({ ...policyForm, project: event.target.value })} /></label>
              <label>Name<input value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })} /></label>
              <label>Type
                <select value={policyForm.type} onChange={(event) => setPolicyForm({ ...policyForm, type: event.target.value as Policy["type"] })}>
                  <option value="trial">trial</option>
                  <option value="node_locked">node_locked</option>
                  <option value="floating">floating</option>
                  <option value="subscription">subscription</option>
                </select>
              </label>
              <label>Valid from offset (sec)<input type="number" value={policyForm.valid_from_offset_sec} onChange={(event) => setPolicyForm({ ...policyForm, valid_from_offset_sec: event.target.value })} /></label>
              <label>Duration (sec)<input type="number" value={policyForm.duration_sec} onChange={(event) => setPolicyForm({ ...policyForm, duration_sec: event.target.value })} /></label>
              <label>Assertion TTL<input type="number" value={policyForm.assertion_ttl_seconds} onChange={(event) => setPolicyForm({ ...policyForm, assertion_ttl_seconds: Number(event.target.value) })} /></label>
              <label>Pool size<input type="number" value={policyForm.pool_size} onChange={(event) => setPolicyForm({ ...policyForm, pool_size: Number(event.target.value) })} /></label>
              <label>Max active devices<input type="number" value={policyForm.max_active_devices} onChange={(event) => setPolicyForm({ ...policyForm, max_active_devices: Number(event.target.value) })} /></label>
              <label>Max borrow (sec)<input type="number" value={policyForm.max_borrow_sec} onChange={(event) => setPolicyForm({ ...policyForm, max_borrow_sec: Number(event.target.value) })} /></label>
              <label>Expiry strategy
                <select value={policyForm.expiry_strategy} onChange={(event) => setPolicyForm({ ...policyForm, expiry_strategy: event.target.value as Policy["expiry_strategy"] })}>
                  <option value="fixed_window">fixed_window</option>
                  <option value="non_expiring">non_expiring</option>
                </select>
              </label>
              {policyForm.type === "trial" && (
                <fieldset className="trialPanel">
                  <legend>Trial</legend>
                  <label>Expiration basis
                    <select value={policyForm.trial_expiration_basis} onChange={(event) => setPolicyForm({ ...policyForm, trial_expiration_basis: event.target.value as Policy["trial_expiration_basis"] })}>
                      <option value="from_issue">from_issue</option>
                      <option value="from_first_activation">from_first_activation</option>
                      <option value="from_first_use">from_first_use</option>
                    </select>
                  </label>
                  <label>Trial duration (sec)<input type="number" value={policyForm.trial_duration_sec} onChange={(event) => setPolicyForm({ ...policyForm, trial_duration_sec: Number(event.target.value) })} /></label>
                  <label className="checkboxRow"><input type="checkbox" checked={policyForm.trial_one_per_device} onChange={(event) => setPolicyForm({ ...policyForm, trial_one_per_device: event.target.checked })} />One trial per device</label>
                  <label className="checkboxRow"><input type="checkbox" checked={policyForm.trial_require_device_proof} onChange={(event) => setPolicyForm({ ...policyForm, trial_require_device_proof: event.target.checked })} />Require device proof</label>
                </fieldset>
              )}
              <label>Notes<textarea value={policyForm.notes} onChange={(event) => setPolicyForm({ ...policyForm, notes: event.target.value })} /></label>
              <button disabled={busy} type="submit">Create policy</button>
            </form>
          </aside>
          <section className="tablePane">
            <div className="filters">
              <input placeholder="project" value={policyFilter.project} onChange={(event) => setPolicyFilter({ ...policyFilter, project: event.target.value })} />
              <select value={policyFilter.type} onChange={(event) => setPolicyFilter({ ...policyFilter, type: event.target.value })}>
                <option value="">all types</option>
                <option value="trial">trial</option>
                <option value="node_locked">node_locked</option>
                <option value="floating">floating</option>
                <option value="subscription">subscription</option>
              </select>
              <select value={policyFilter.status} onChange={(event) => setPolicyFilter({ ...policyFilter, status: event.target.value })}>
                <option value="">all</option>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </div>
            <table>
              <thead><tr><th>Name</th><th>Project</th><th>Type</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td>{policy.name}</td>
                    <td>{policy.project}</td>
                    <td>{policy.type}</td>
                    <td>
                      <div className="details">
                        <span>TTL {policy.assertion_ttl_seconds}s</span>
                        <span>Expiry {policy.expiry_strategy}</span>
                        <span>Offset {policy.valid_from_offset_sec ?? "-"} / Duration {policy.duration_sec ?? "-"}</span>
                        <span>Pool {policy.pool_size} / Max devices {policy.max_active_devices} / Borrow {policy.max_borrow_sec}s</span>
                        {policy.type === "trial" && (
                          <span>Trial {policy.trial_expiration_basis} {policy.trial_duration_sec}s {policy.trial_one_per_device === 1 ? "one-per-device" : ""} {policy.trial_require_device_proof === 1 ? "proof-required" : ""}</span>
                        )}
                        {policy.notes !== "" && <span>Notes {policy.notes}</span>}
                      </div>
                    </td>
                    <td><span className={`status ${policy.status}`}>{policy.status}</span></td>
                    <td className="actions">
                      <button className="danger" disabled={busy || !canRunPolicyAction(policy.status, "disable")} onClick={() => requestConfirm({ title: "Disable policy", body: disablePolicyConfirm(policy), requiresReason: true, run: () => policyTransition(policy, "disable") })}>Disable</button>
                      <button disabled={busy || !canRunPolicyAction(policy.status, "reenable")} onClick={() => void policyTransition(policy, "reenable")}>Reenable</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tableFooter">
              <span className="muted">{policies.length} shown</span>
              {policiesCursor !== null && (
                <button type="button" disabled={busy} onClick={() => void loadMore(policiesUrl, policiesCursor, setPolicies, setPoliciesCursor)}>Load more</button>
              )}
            </div>
          </section>
        </section>
      )}

      {activeTab === "webhooks" && (
        <section className="workspace">
          <aside>
            <h2>Webhook endpoint</h2>
            <form onSubmit={(event) => void submitWebhookCreate(event)}>
              <label>URL<input type="url" placeholder="https://hooks.example.com/lcc" value={webhookForm.url} onChange={(event) => setWebhookForm({ ...webhookForm, url: event.target.value })} /></label>
              <label>Event types (csv; blank = all)<input placeholder="entitlement.revoked,customer.disabled" value={webhookForm.event_types} onChange={(event) => setWebhookForm({ ...webhookForm, event_types: event.target.value })} /></label>
              <label>Description<input value={webhookForm.description} onChange={(event) => setWebhookForm({ ...webhookForm, description: event.target.value })} /></label>
              <label>Scope: project (blank = all)<input placeholder="DEFAULT" value={webhookForm.scope_project} onChange={(event) => setWebhookForm({ ...webhookForm, scope_project: event.target.value })} /></label>
              <label>Scope: customer id (blank = all)<input placeholder="cus_..." value={webhookForm.scope_customer_id} onChange={(event) => setWebhookForm({ ...webhookForm, scope_customer_id: event.target.value })} /></label>
              <p className="muted">Set at most one scope dimension. A scoped endpoint receives only matching events; blank = every event.</p>
              <button disabled={busy} type="submit">Create endpoint</button>
            </form>
          </aside>
          <section className="tablePane">
            <div className="filters">
              <select aria-label="Filter endpoints by status" value={webhookFilter.status} onChange={(event) => setWebhookFilter({ status: event.target.value })}>
                <option value="">all</option>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </div>
            <table>
              <caption className="srOnly">Webhook endpoints</caption>
              <thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {webhooks.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td className="mono">{endpoint.url}</td>
                    <td>{endpoint.event_types === "" ? "(all)" : endpoint.event_types}</td>
                    <td>
                      {endpoint.scope_project !== null && endpoint.scope_project !== ""
                        ? `project:${endpoint.scope_project}`
                        : endpoint.scope_customer_id !== null && endpoint.scope_customer_id !== ""
                          ? `customer:${endpoint.scope_customer_id}`
                          : "(global)"}
                    </td>
                    <td><span className={`status ${endpoint.status}`}>{endpoint.status}</span></td>
                    <td>{formatEpoch(endpoint.created_at)}</td>
                    <td className="actions">
                      <button type="button" disabled={busy} onClick={() => showDeliveriesForEndpoint(endpoint.id)}>Deliveries</button>
                      <button className="danger" disabled={busy || !canRunWebhookAction(endpoint.status, "disable")} onClick={() => requestConfirm({ title: "Disable webhook", body: disableWebhookConfirm(endpoint), requiresReason: false, run: () => webhookTransition(endpoint, "disable") })}>Disable</button>
                      <button disabled={busy || !canRunWebhookAction(endpoint.status, "reenable")} onClick={() => void webhookTransition(endpoint, "reenable")}>Reenable</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tableFooter">
              <span className="muted">{webhooks.length} shown</span>
              {webhooksCursor !== null && (
                <button type="button" disabled={busy} onClick={() => void loadMore(webhooksUrl, webhooksCursor, setWebhooks, setWebhooksCursor)}>Load more</button>
              )}
            </div>

            <section className="deliveriesPane" aria-label="Recent webhook deliveries">
              <h3>Recent deliveries{webhookDeliveryFilter.endpoint_id !== "" ? ` for ${shortHash(webhookDeliveryFilter.endpoint_id)}` : ""}</h3>
              <div className="filters">
                {webhookDeliveryFilter.endpoint_id !== "" && (
                  <button type="button" disabled={busy} onClick={() => setWebhookDeliveryFilter({ endpoint_id: "", status: "" })}>Clear endpoint filter</button>
                )}
                <select aria-label="Filter deliveries by status" value={webhookDeliveryFilter.status} onChange={(event) => setWebhookDeliveryFilter({ ...webhookDeliveryFilter, status: event.target.value })}>
                  <option value="">all</option>
                  <option value="pending">pending</option>
                  <option value="delivered">delivered</option>
                  <option value="failed">failed</option>
                </select>
              </div>
              <table>
                <caption className="srOnly">Recent webhook deliveries</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">Endpoint</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {webhookDeliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>{formatEpoch(delivery.created_at)}</td>
                      <td className="mono">{shortHash(delivery.endpoint_id)}</td>
                      <td>{delivery.event_source}.{delivery.event_type}</td>
                      <td><span className={`status ${delivery.status}`}>{delivery.status}</span></td>
                      <td>{delivery.attempts}</td>
                      <td>{delivery.last_status !== 0 ? delivery.last_status : delivery.last_error !== "" ? delivery.last_error : "-"}</td>
                      <td className="actions">
                        <button type="button" disabled={busy || delivery.status !== "failed"} onClick={() => void redriveDelivery(delivery)}>Redrive</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {webhookDeliveries.length === 0 && <p className="muted">No deliveries recorded.</p>}
            </section>
          </section>
        </section>
      )}

      {activeTab === "events" && (
        <section className="tablePane full">
          <div className="filters eventsToolbar">
            <button type="button" disabled={busy} onClick={() => void downloadCsv("/api/admin/events", "events.csv")}>Export CSV</button>
          </div>
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Source</th><th>Actor</th><th>Seq</th></tr></thead>
            <tbody>
              {events.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.created_at * 1000).toLocaleString()}</td>
                  <td>{item.event_type}</td>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{shortHash(item.license_fingerprint)}</code></td>
                  <td>{item.source}</td>
                  <td>{item.actor} <span className="muted">({item.actor_type})</span></td>
                  <td>{item.revocation_seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tableFooter"><span className="muted">{events.length} shown (most recent)</span></div>
        </section>
      )}

      {activeTab === "customers" && (
        <section className="workspace">
          <section className="tablePane">
            <div className="filters">
              <select value={customerFilter.status} onChange={(event) => setCustomerFilter({ ...customerFilter, status: event.target.value })}>
                <option value="">all</option>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
              <input placeholder="search id / email / name" value={customerFilter.q} onChange={(event) => setCustomerFilter({ ...customerFilter, q: event.target.value })} />
              <button type="button" disabled={busy} onClick={() => void downloadCsv(customersUrl, "customers.csv")}>Export CSV</button>
            </div>
            <table>
              <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Status</th><th>Entitlements</th><th>Active</th></tr></thead>
              <tbody>
                {customers.map((item) => (
                  <tr key={item.id} className={selectedCustomerId === item.id ? "selectedRow" : ""}>
                    <td><button type="button" disabled={busy} onClick={() => selectCustomer(item.id)}>{item.id}</button></td>
                    <td>{item.name}</td>
                    <td>{item.email}</td>
                    <td><span className={`status ${item.status}`}>{item.status}</span></td>
                    <td>{item.entitlement_count}</td>
                    <td>{item.active_entitlement_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tableFooter">
              <span className="muted">{customers.length} shown</span>
              {customersCursor !== null && (
                <button type="button" disabled={busy} onClick={() => void loadMore(customersUrl, customersCursor, setCustomers, setCustomersCursor)}>Load more</button>
              )}
            </div>
          </section>
          <aside>
            {customerDetail === null ? (
              <p className="muted">Select a customer to view details.</p>
            ) : (
              <div className="details">
                <h2>{customerDetail.customer.name}</h2>
                <span>{customerDetail.customer.email}</span>
                <span>Status <span className={`status ${customerDetail.customer.status}`}>{customerDetail.customer.status}</span></span>
                <span>External ref {customerDetail.customer.external_ref || "-"}</span>
                <span>Created {formatEpoch(customerDetail.customer.created_at)}</span>
                <span>Updated {formatEpoch(customerDetail.customer.updated_at)}</span>

                <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                <div className="actions">
                  <button className="danger" disabled={busy || !canRunCustomerAction(customerDetail.customer.status, "disable")} onClick={() => requestConfirm({ title: "Disable customer", body: disableCustomerConfirm(customerDetail.customer), requiresReason: true, run: () => customerTransition("disable") })}>Disable</button>
                  <button disabled={busy || !canRunCustomerAction(customerDetail.customer.status, "reenable")} onClick={() => void customerTransition("reenable")}>Reenable</button>
                </div>

                <h2>Entitlements</h2>
                <table>
                  <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Status</th><th>Seq</th><th>Until</th></tr></thead>
                  <tbody>
                    {customerDetail.entitlements.map((ent) => (
                      <tr key={`${ent.project}/${ent.feature}/${ent.license_fingerprint}`}>
                        <td>{ent.project}</td>
                        <td>{ent.feature}</td>
                        <td><code>{shortHash(ent.license_fingerprint)}</code></td>
                        <td>
                          <span className={`status ${ent.status}`}>{ent.status}</span>
                          <HealthBadge status={ent.status} validUntil={ent.valid_until} now={nowSeconds} />
                        </td>
                        <td>{ent.revocation_seq}</td>
                        <td>{formatEpoch(ent.valid_until)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>Account tokens</h2>
                <table>
                  <thead><tr><th>Prefix</th><th>Name</th><th>Status</th><th>Scopes</th><th>Expires</th><th>Last used</th></tr></thead>
                  <tbody>
                    {customerDetail.account_tokens.map((token) => (
                      <tr key={token.id}>
                        <td><code>{token.token_prefix}</code></td>
                        <td>{token.name}</td>
                        <td><span className={`status ${token.status}`}>{token.status}</span></td>
                        <td>{token.scopes_json}</td>
                        <td>{formatEpoch(token.expires_at)}</td>
                        <td>{formatEpoch(token.last_used_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>Licenses</h2>
                <table>
                  <thead><tr><th>ID</th><th>Project</th><th>Label</th><th>Created</th></tr></thead>
                  <tbody>
                    {customerDetail.licenses.map((license) => (
                      <tr key={license.id}>
                        <td>{license.id}</td>
                        <td>{license.project}</td>
                        <td>{license.label}</td>
                        <td>{formatEpoch(license.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>Orders</h2>
                <table>
                  <thead><tr><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Epoch</th><th>Updated</th></tr></thead>
                  <tbody>
                    {customerDetail.orders.map((order) => (
                      <tr key={`${order.subscription_id}/${order.project}/${order.feature}`}>
                        <td>{order.subscription_id}</td>
                        <td>{order.project}</td>
                        <td>{order.feature}</td>
                        <td>{order.last_seq}</td>
                        <td>{order.order_epoch}</td>
                        <td>{formatEpoch(order.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>History</h2>
                <table>
                  <thead><tr><th>Time</th><th>Event</th><th>From</th><th>To</th><th>Actor</th><th>Reason</th></tr></thead>
                  <tbody>
                    {customerDetail.events.map((event) => (
                      <tr key={event.id}>
                        <td>{formatEpoch(event.created_at)}</td>
                        <td>{event.event_type}</td>
                        <td>{event.prev_status}</td>
                        <td>{event.next_status}</td>
                        <td>{event.actor} <span className="muted">({event.actor_type})</span></td>
                        <td className="reason">{event.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </aside>
        </section>
      )}

      {activeTab === "licenses" && (
        <section className="tablePane full">
          <div className="filters">
            <input placeholder="project" value={licenseFilter.project} onChange={(event) => setLicenseFilter({ ...licenseFilter, project: event.target.value })} />
            <input placeholder="customer_id" value={licenseFilter.customer_id} onChange={(event) => setLicenseFilter({ ...licenseFilter, customer_id: event.target.value })} />
            <input placeholder="search id / label" value={licenseFilter.q} onChange={(event) => setLicenseFilter({ ...licenseFilter, q: event.target.value })} />
          </div>
          <table>
            <thead><tr><th>ID</th><th>Customer</th><th>Project</th><th>Label</th><th>Created</th></tr></thead>
            <tbody>
              {licenses.map((item) => (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td><code>{shortHash(item.customer_id)}</code></td>
                  <td>{item.project}</td>
                  <td>{item.label}</td>
                  <td>{formatEpoch(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tableFooter">
            <span className="muted">{licenses.length} shown</span>
            {licensesCursor !== null && (
              <button type="button" disabled={busy} onClick={() => void loadMore(licensesUrl, licensesCursor, setLicenses, setLicensesCursor)}>Load more</button>
            )}
          </div>
        </section>
      )}

      {activeTab === "fulfillment" && (
        <section className="tablePane full">
          <section className="grid metrics reportCards">
            <div><span>Accepted</span><strong>{orders?.summary.accepted ?? 0}</strong></div>
            <div><span>Processed</span><strong>{orders?.summary.processed ?? 0}</strong></div>
            <div><span>Superseded</span><strong>{orders?.summary.superseded ?? 0}</strong></div>
            <div><span>Rejected</span><strong>{orders?.summary.rejected ?? 0}</strong></div>
            <div><span>Stale</span><strong>{orders?.summary.stale_accepted ?? 0}</strong></div>
          </section>
          <div className="chartCard fulfillmentSpark">
            <div className="expiringHead">
              <h3>Fulfillment events over time</h3>
              <div className="rangeSelector" role="group" aria-label="Fulfillment spark range">
                <span className="muted">Window</span>
                {TIMESERIES_RANGE_DAYS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={timeseriesRange === days ? "active" : ""}
                    onClick={() => setTimeseriesRange(days)}
                  >last {days}d</button>
                ))}
              </div>
            </div>
            <BarSparkChart
              values={(timeseries?.buckets ?? []).map((b) => b.fulfillment_events)}
              label={`Fulfillment (order) events over the last ${timeseriesRange} days`}
            />
          </div>
          <div className="filters">
            <select value={orderFilter.status} onChange={(event) => setOrderFilter({ ...orderFilter, status: event.target.value })}>
              <option value="">all</option>
              <option value="accepted">accepted</option>
              <option value="processed">processed</option>
              <option value="superseded">superseded</option>
              <option value="rejected">rejected</option>
            </select>
            <input placeholder="subscription_id" value={orderFilter.subscription_id} onChange={(event) => setOrderFilter({ ...orderFilter, subscription_id: event.target.value })} />
          </div>
          <table>
            <thead><tr><th>Received</th><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Intent</th><th>Status</th><th>Processed</th></tr></thead>
            <tbody>
              {(orders?.items ?? []).map((item) => (
                <tr key={item.event_id} className={item.stale ? "staleRow" : ""}>
                  <td>{formatEpoch(item.received_at)}</td>
                  <td>{item.subscription_id}</td>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td>{item.seq}</td>
                  <td>{item.intent}</td>
                  <td><span className={`status ${item.status}`}>{item.status}</span>{item.stale && <span className="staleFlag">STALE</span>}</td>
                  <td>{formatEpoch(item.processed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tableFooter">
            <span className="muted">{(orders?.items ?? []).length} shown</span>
            {orders?.next_cursor != null && (
              <button type="button" disabled={busy} onClick={() => void loadMoreOrders()}>Load more</button>
            )}
          </div>
        </section>
      )}

      {activeTab === "reports" && (
        <section className="reportsTab">
          <section className="grid metrics reportCards">
            <div><span>Entitlements total</span><strong>{report?.entitlements.total ?? 0}</strong></div>
            <div><span>Entitlements active</span><strong>{report?.entitlements.active ?? 0}</strong></div>
            <div><span>Entitlements revoked</span><strong>{report?.entitlements.revoked ?? 0}</strong></div>
            <div><span>Entitlements disabled</span><strong>{report?.entitlements.disabled ?? 0}</strong></div>
            <div><span>Customers total</span><strong>{report?.customers.total ?? 0}</strong></div>
            <div><span>Customers active</span><strong>{report?.customers.active ?? 0}</strong></div>
            <div><span>Customers disabled</span><strong>{report?.customers.disabled ?? 0}</strong></div>
            <div><span>Active account tokens</span><strong>{report?.account_tokens.active ?? 0}</strong></div>
            <div><span>Licenses total</span><strong>{report?.licenses.total ?? 0}</strong></div>
            <div><span>Fulfillment processed</span><strong>{report?.fulfillment.processed ?? 0}</strong></div>
            <div><span>Fulfillment stale accepted</span><strong>{report?.fulfillment.stale_accepted ?? 0}</strong></div>
            <div><span>Order events 24h</span><strong>{report?.fulfillment.events_24h ?? 0}</strong></div>
            <div><span>Order events 7d</span><strong>{report?.fulfillment.events_7d ?? 0}</strong></div>
            <div><span>Customer suspensions 7d</span><strong>{report?.customer_suspensions_7d ?? 0}</strong></div>
          </section>

          <section className="chartPanels">
            <div className="rangeSelector" role="group" aria-label="Time-series range">
              <span className="muted">Window</span>
              {TIMESERIES_RANGE_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className={timeseriesRange === days ? "active" : ""}
                  onClick={() => setTimeseriesRange(days)}
                >last {days}d</button>
              ))}
            </div>
            <div className="chartGrid">
              <div className="chartCard">
                <h3>Checkouts vs denials</h3>
                <LineAreaChart
                  checkouts={(timeseries?.buckets ?? []).map((b) => b.checkouts)}
                  denials={(timeseries?.buckets ?? []).map((b) => b.denials)}
                  label={`Checkouts (filled) versus denials over the last ${timeseriesRange} days`}
                />
                <div className="chartLegend">
                  <span className="legend checkoutsLegend">checkouts</span>
                  <span className="legend denialsLegend">denials</span>
                </div>
              </div>
              <div className="chartCard">
                <h3>Denial-rate trend</h3>
                <DenialRateChart
                  rates={(timeseries?.buckets ?? []).map((b) => b.denial_rate)}
                  label={`Denial rate (denials over checkout attempts) over the last ${timeseriesRange} days`}
                />
                <p className="muted chartHint">Rising denial rate is the seat-pool upsell signal.</p>
              </div>
            </div>
          </section>

          <section className="tablePane full expiringPanel">
            <div className="expiringHead">
              <h2>Expiring soon</h2>
              <div className="rangeSelector" role="group" aria-label="Expiring horizon">
                {[7, 30, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={expiringWithinDays === days ? "active" : ""}
                    onClick={() => setExpiringWithinDays(days)}
                  >{days}d</button>
                ))}
              </div>
            </div>
            {expiring.length === 0 ? (
              <p className="muted">No active entitlements expire within {expiringWithinDays} days.</p>
            ) : (
              <table>
                <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Customer</th><th>Expires</th><th>Days left</th><th></th></tr></thead>
                <tbody>
                  {expiring.map((row) => (
                    <tr key={`${row.project}/${row.feature}/${row.license_fingerprint}`} className={row.days_left <= 7 ? "expiringSoonRow" : ""}>
                      <td>{row.project}</td>
                      <td>{row.feature}</td>
                      <td><code>{shortHash(row.license_fingerprint)}</code></td>
                      <td>{row.customer_id ?? "-"}</td>
                      <td>{formatEpoch(row.valid_until)}</td>
                      <td><span className={`daysLeft ${row.days_left <= 7 ? "urgent" : ""}`}>{row.days_left}</span></td>
                      <td className="actions">
                        <button type="button" disabled={busy} onClick={() => deepLinkToEntitlement(row)}>View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="tableFooter">
              <span className="muted">{expiring.length} shown</span>
              {expiringCursor !== null && (
                <button type="button" disabled={busy} onClick={() => void loadMoreExpiring()}>Load more</button>
              )}
            </div>
          </section>
        </section>
      )}

      {confirmAction !== null && (
        <div className="modalOverlay" role="presentation" onClick={() => setConfirmAction(null)}>
          <div className="modal danger" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" onClick={(event) => event.stopPropagation()}>
            <h2 id="confirmTitle">{confirmAction.title}</h2>
            <p>{confirmAction.body}</p>
            {confirmAction.requiresReason && (
              <label className="reason">Reason (required)<input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            )}
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                type="button"
                className="danger"
                disabled={busy || (confirmAction.requiresReason && reason.trim() === "")}
                onClick={() => void confirmProceed()}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
