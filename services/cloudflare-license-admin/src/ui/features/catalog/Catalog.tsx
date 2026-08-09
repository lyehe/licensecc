import React, { FormEvent, useEffect, useMemo, useState } from "react";

import type {
  CatalogFeature,
  CatalogImportManifest,
  CatalogImportResult,
  CatalogPlan,
  CatalogPlanFeature,
  PlanProjectionApplyResult,
  PlanProjectionItem,
  PlanProjectionPreview,
  Policy,
} from "../../../shared/api";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { formatEpoch, shortHash } from "../../shared/format";
import { loadMore } from "../../shared/pagination";
import {
  canRunCatalogAction,
  catalogFeatureFormFromRecord,
  catalogFeaturePath,
  catalogFeaturesPath,
  catalogFeatureTransitionPath,
  catalogImportPath,
  catalogPlanExportPath,
  catalogPlanFeatureTransitionPath,
  catalogPlanFeaturesPath,
  catalogPlanFormFromRecord,
  catalogPlanPath,
  catalogPlansPath,
  catalogPlanTransitionPath,
  CatalogFilter,
  disableCatalogFeatureConfirm,
  disableCatalogPlanConfirm,
  disableCatalogPlanFeatureConfirm,
  emptyCatalogFeatureForm,
  emptyCatalogPlanFeatureForm,
  emptyCatalogPlanForm,
  emptyPlanProjectionForm,
  normalizeCatalogFeatureForm,
  normalizeCatalogFeaturePatch,
  normalizeCatalogPlanFeatureForm,
  normalizeCatalogPlanForm,
  normalizeCatalogPlanPatch,
  normalizePlanProjectionForm,
  planProjectionApplyPath,
  planProjectionPreviewPath,
} from "./workflow";

export function Catalog({ active }: { active: boolean }): React.ReactElement | null {
  const [catalogFeatures, setCatalogFeatures] = useState<CatalogFeature[]>([]);
  const [catalogFeatureFilter, setCatalogFeatureFilter] = useState<CatalogFilter>({ project: "", status: "" });
  const [catalogFeaturesCursor, setCatalogFeaturesCursor] = useState<string | null>(null);
  const [catalogFeatureForm, setCatalogFeatureForm] = useState(emptyCatalogFeatureForm);
  const [editingCatalogFeatureId, setEditingCatalogFeatureId] = useState<string | null>(null);
  const [catalogPlans, setCatalogPlans] = useState<CatalogPlan[]>([]);
  const [catalogPlanFilter, setCatalogPlanFilter] = useState<CatalogFilter>({ project: "", status: "" });
  const [catalogPlansCursor, setCatalogPlansCursor] = useState<string | null>(null);
  const [catalogPlanForm, setCatalogPlanForm] = useState(emptyCatalogPlanForm);
  const [editingCatalogPlanId, setEditingCatalogPlanId] = useState<string | null>(null);
  const [selectedCatalogPlanId, setSelectedCatalogPlanId] = useState("");
  const [catalogPlanFeatures, setCatalogPlanFeatures] = useState<CatalogPlanFeature[]>([]);
  const [catalogPlanFeatureForm, setCatalogPlanFeatureForm] = useState(emptyCatalogPlanFeatureForm);
  const [catalogImportText, setCatalogImportText] = useState("");
  const [catalogImportPreview, setCatalogImportPreview] = useState<CatalogImportResult | null>(null);
  const [planForm, setPlanForm] = useState(emptyPlanProjectionForm);
  const [planPreview, setPlanPreview] = useState<PlanProjectionPreview | null>(null);
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);
  const { busy, currentReason, requestConfirm, runMutation, setMessage, setReason } = useOperatorControls();
  const { refreshCore } = useCoreRefresh();
  const catalogFeaturesUrl = useMemo(() => catalogFeaturesPath(catalogFeatureFilter), [catalogFeatureFilter]);
  const catalogPlansUrl = useMemo(() => catalogPlansPath(catalogPlanFilter), [catalogPlanFilter]);

  async function refreshCatalogFeatures(): Promise<void> {
    const response = await api<{ items: CatalogFeature[]; next_cursor: string | null }>(catalogFeaturesUrl);
    if (response.ok && response.data) {
      setCatalogFeatures(response.data.items);
      setCatalogFeaturesCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  async function refreshCatalogPlans(): Promise<void> {
    const response = await api<{ items: CatalogPlan[]; next_cursor: string | null }>(catalogPlansUrl);
    if (response.ok && response.data) {
      setCatalogPlans(response.data.items);
      setCatalogPlansCursor(response.data.next_cursor ?? null);
      if (selectedCatalogPlanId === "" && response.data.items.length > 0) setSelectedCatalogPlanId(response.data.items[0].id);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  async function refreshCatalogPlanFeatures(planId = selectedCatalogPlanId): Promise<void> {
    if (planId === "") {
      setCatalogPlanFeatures([]);
      return;
    }
    const response = await api<{ items: CatalogPlanFeature[] }>(catalogPlanFeaturesPath(planId));
    if (response.ok && response.data) setCatalogPlanFeatures(response.data.items);
    else {
      setCatalogPlanFeatures([]);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (active) void refreshCatalogFeatures();
  }, [active, catalogFeaturesUrl]);
  useEffect(() => {
    if (active) void refreshCatalogPlans();
  }, [active, catalogPlansUrl]);
  useEffect(() => {
    if (active) void refreshCatalogPlanFeatures(selectedCatalogPlanId);
  }, [active, selectedCatalogPlanId]);
  useEffect(() => {
    if (!active) return;
    void (async () => {
      const response = await api<{ items: Policy[]; next_cursor: string | null }>("/api/admin/policies?status=active");
      if (response.ok && response.data) setActivePolicies(response.data.items);
    })();
  }, [active]);

  function selectCatalogPlan(plan: CatalogPlan): void {
    setSelectedCatalogPlanId(plan.id);
    setCatalogPlanFeatureForm((current) => ({ ...current, project: plan.project }));
    setPlanForm((current) => ({ ...current, project: plan.project, plan_id: plan.id, plan_key: plan.plan_key }));
  }

  function beginCatalogFeatureEdit(feature: CatalogFeature): void {
    setEditingCatalogFeatureId(feature.id);
    setCatalogFeatureForm(catalogFeatureFormFromRecord(feature));
  }
  function cancelCatalogFeatureEdit(): void {
    setEditingCatalogFeatureId(null);
    setCatalogFeatureForm(emptyCatalogFeatureForm);
  }
  function beginCatalogPlanEdit(plan: CatalogPlan): void {
    setEditingCatalogPlanId(plan.id);
    setCatalogPlanForm(catalogPlanFormFromRecord(plan));
    selectCatalogPlan(plan);
  }
  function cancelCatalogPlanEdit(): void {
    setEditingCatalogPlanId(null);
    setCatalogPlanForm(emptyCatalogPlanForm);
  }

  async function submitCatalogFeatureCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeCatalogFeatureForm> | ReturnType<typeof normalizeCatalogFeaturePatch>;
      try {
        body = editingCatalogFeatureId === null ? normalizeCatalogFeatureForm(catalogFeatureForm) : normalizeCatalogFeaturePatch(catalogFeatureForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_catalog_feature");
        return;
      }
      const result = await api<CatalogFeature>(editingCatalogFeatureId === null ? "/api/admin/catalog/features" : catalogFeaturePath(editingCatalogFeatureId), {
        method: editingCatalogFeatureId === null ? "POST" : "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        cancelCatalogFeatureEdit();
        await refreshCatalogFeatures();
      }
    });
  }

  async function catalogFeatureTransition(feature: CatalogFeature, action: "disable" | "reenable"): Promise<void> {
    await runMutation(async () => {
      const result = await api<CatalogFeature>(catalogFeatureTransitionPath(feature.id, action), { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        if (action === "disable") setReason("");
        await refreshCatalogFeatures();
      }
    });
  }

  async function submitCatalogPlanCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeCatalogPlanForm> | ReturnType<typeof normalizeCatalogPlanPatch>;
      try {
        body = editingCatalogPlanId === null ? normalizeCatalogPlanForm(catalogPlanForm) : normalizeCatalogPlanPatch(catalogPlanForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_catalog_plan");
        return;
      }
      const result = await api<CatalogPlan>(editingCatalogPlanId === null ? "/api/admin/catalog/plans" : catalogPlanPath(editingCatalogPlanId), {
        method: editingCatalogPlanId === null ? "POST" : "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok && result.data) {
        cancelCatalogPlanEdit();
        selectCatalogPlan(result.data);
        await refreshCatalogPlans();
      }
    });
  }

  async function catalogPlanTransition(plan: CatalogPlan, action: "disable" | "reenable"): Promise<void> {
    await runMutation(async () => {
      const result = await api<CatalogPlan>(catalogPlanTransitionPath(plan.id, action), { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        if (action === "disable") setReason("");
        await refreshCatalogPlans();
      }
    });
  }

  async function catalogPlanFeatureTransition(row: CatalogPlanFeature, action: "disable" | "reenable"): Promise<void> {
    await runMutation(async () => {
      const result = await api<CatalogPlanFeature>(catalogPlanFeatureTransitionPath(row.plan_id, row.feature_key, action), { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        if (action === "disable") setReason("");
        await refreshCatalogPlanFeatures(row.plan_id);
      }
    });
  }

  async function exportCatalogPlan(plan: CatalogPlan): Promise<void> {
    await runMutation(async () => {
      const result = await api<CatalogImportManifest>(catalogPlanExportPath(plan.id));
      setMessage(`${result.code} (${result.request_id})`);
      if (!result.ok || result.data === undefined) return;
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${plan.plan_key}-catalog.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setMessage(`exported ${plan.plan_key}-catalog.json`);
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }

  async function runCatalogImport(dryRun: boolean): Promise<void> {
    await runMutation(async () => {
      let body: unknown;
      try {
        body = JSON.parse(catalogImportText);
      } catch {
        setMessage("invalid_catalog_import_json");
        return;
      }
      const result = await api<CatalogImportResult>(catalogImportPath(dryRun), { method: "POST", headers: dryRun ? undefined : { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setCatalogImportPreview(result.data ?? null);
        await refreshCatalogFeatures();
        await refreshCatalogPlans();
        await refreshCatalogPlanFeatures(selectedCatalogPlanId);
      }
    });
  }

  async function submitCatalogPlanFeatureCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (selectedCatalogPlanId === "") {
      setMessage("catalog_plan_required");
      return;
    }
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeCatalogPlanFeatureForm>;
      try {
        body = normalizeCatalogPlanFeatureForm(catalogPlanFeatureForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_catalog_plan_feature");
        return;
      }
      const result = await api<CatalogPlanFeature>(catalogPlanFeaturesPath(selectedCatalogPlanId), { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setCatalogPlanFeatureForm((current) => ({ ...emptyCatalogPlanFeatureForm, project: current.project }));
        await refreshCatalogPlanFeatures(selectedCatalogPlanId);
      }
    });
  }

  async function submitPlanPreview(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizePlanProjectionForm>;
      try {
        body = normalizePlanProjectionForm(planForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_plan_projection");
        return;
      }
      const result = await api<PlanProjectionPreview>(planProjectionPreviewPath(), { method: "POST", body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      setPlanPreview(result.ok && result.data ? result.data : null);
    });
  }

  async function applyPlanProjectionFromForm(): Promise<void> {
    await runMutation(async () => {
      let body: ReturnType<typeof normalizePlanProjectionForm>;
      try {
        body = normalizePlanProjectionForm(planForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_plan_projection");
        return;
      }
      const result = await api<PlanProjectionApplyResult>(planProjectionApplyPath(), { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok && result.data) {
        setPlanPreview(result.data);
        await refreshCore();
      }
    });
  }

  function projectionRows(title: string, items: PlanProjectionItem[]): React.ReactElement | null {
    if (items.length === 0) return null;
    return <section className="deliveriesPane"><h3>{title}</h3><table><thead><tr><th>Feature</th><th>Mode</th><th>Policy</th><th>Window</th><th>Capacity</th><th>Source</th></tr></thead><tbody>{items.map((item) => <tr key={`${title}:${item.feature}`}><td>{item.feature}</td><td>{item.license_mode}</td><td>{item.policy_id ?? "-"}</td><td>{item.valid_until === null ? "open" : formatEpoch(item.valid_until)}</td><td>{item.pool_size > 0 ? `pool ${item.pool_size}` : `devices ${item.max_active_devices}`}</td><td>{item.addon_key ?? item.source}{item.reason ? ` / ${item.reason}` : ""}</td></tr>)}</tbody></table></section>;
  }

  function catalogOverrideSummary(row: CatalogPlanFeature): string {
    const parts = [row.assertion_ttl_seconds === null ? "" : `TTL ${row.assertion_ttl_seconds}s`, row.pool_size === null ? "" : `pool ${row.pool_size}`, row.max_active_devices === null ? "" : `devices ${row.max_active_devices}`, row.max_borrow_sec === null ? "" : `borrow ${row.max_borrow_sec}s`, row.meter_quota === null ? "" : `meter ${row.meter_quota}`, row.meter_period_sec === null ? "" : `period ${row.meter_period_sec}s`].filter((item) => item !== "");
    return parts.length === 0 ? "-" : parts.join(" / ");
  }

  if (!active) return null;
  const selectedCatalogPlan = catalogPlans.find((plan) => plan.id === selectedCatalogPlanId) ?? null;
  return (
    <section className="workspace">
      <aside>
        <h2>{editingCatalogFeatureId === null ? "Catalog feature" : "Edit feature"}</h2>
        <form aria-label="Catalog feature" onSubmit={(event) => void submitCatalogFeatureCreate(event)}><label>Project<input disabled={editingCatalogFeatureId !== null} value={catalogFeatureForm.project} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, project: event.target.value })} /></label><label>Feature key<input disabled={editingCatalogFeatureId !== null} value={catalogFeatureForm.feature_key} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, feature_key: event.target.value })} /></label><label>Name<input value={catalogFeatureForm.name} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, name: event.target.value })} /></label><label>Category<input value={catalogFeatureForm.category} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, category: event.target.value })} /></label><label>Status<select disabled={editingCatalogFeatureId !== null} value={catalogFeatureForm.status} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, status: event.target.value as CatalogFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label><label>Description<textarea value={catalogFeatureForm.description} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, description: event.target.value })} /></label><div className="actions"><button disabled={busy} type="submit">{editingCatalogFeatureId === null ? "Create feature" : "Update feature"}</button>{editingCatalogFeatureId !== null && <button type="button" disabled={busy} onClick={cancelCatalogFeatureEdit}>Cancel</button>}</div></form>
        <h2>{editingCatalogPlanId === null ? "Catalog plan" : "Edit plan"}</h2>
        <form aria-label="Catalog plan" onSubmit={(event) => void submitCatalogPlanCreate(event)}><label>Project<input disabled={editingCatalogPlanId !== null} value={catalogPlanForm.project} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, project: event.target.value })} /></label><label>Plan key<input disabled={editingCatalogPlanId !== null} value={catalogPlanForm.plan_key} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, plan_key: event.target.value })} /></label><label>Name<input value={catalogPlanForm.name} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, name: event.target.value })} /></label><label>Version<input disabled={editingCatalogPlanId !== null} type="number" value={catalogPlanForm.version} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, version: Number(event.target.value) })} /></label><label>Status<select disabled={editingCatalogPlanId !== null} value={catalogPlanForm.status} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, status: event.target.value as CatalogPlan["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label><label>Description<textarea value={catalogPlanForm.description} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, description: event.target.value })} /></label><div className="actions"><button disabled={busy} type="submit">{editingCatalogPlanId === null ? "Create plan" : "Update plan"}</button>{editingCatalogPlanId !== null && <button type="button" disabled={busy} onClick={cancelCatalogPlanEdit}>Cancel</button>}</div></form>
        <h2>Plan feature</h2>
        <form aria-label="Plan feature" onSubmit={(event) => void submitCatalogPlanFeatureCreate(event)}><label>Selected plan<select value={selectedCatalogPlanId} onChange={(event) => { const plan = catalogPlans.find((item) => item.id === event.target.value); if (plan !== undefined) selectCatalogPlan(plan); else setSelectedCatalogPlanId(event.target.value); }}><option value="">none</option>{catalogPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.plan_key} ({plan.project})</option>)}</select></label><label>Project<input value={catalogPlanFeatureForm.project} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, project: event.target.value })} /></label><label>Feature key<input list="catalog-feature-keys" value={catalogPlanFeatureForm.feature_key} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, feature_key: event.target.value })} /></label><datalist id="catalog-feature-keys">{catalogFeatures.map((feature) => <option key={feature.id} value={feature.feature_key} />)}</datalist><label>Inclusion<select value={catalogPlanFeatureForm.feature_inclusion} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, feature_inclusion: event.target.value as CatalogPlanFeature["feature_inclusion"] })}><option value="included">included</option><option value="addon">addon</option></select></label>{catalogPlanFeatureForm.feature_inclusion === "addon" && <label>Add-on key<input value={catalogPlanFeatureForm.addon_key} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, addon_key: event.target.value })} /></label>}<label>Policy ID<input list="active-policy-ids" value={catalogPlanFeatureForm.policy_id} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, policy_id: event.target.value })} /></label><datalist id="active-policy-ids">{activePolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}</datalist><label>Display order<input type="number" value={catalogPlanFeatureForm.display_order} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, display_order: Number(event.target.value) })} /></label><label>Status<select value={catalogPlanFeatureForm.status} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, status: event.target.value as CatalogPlanFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label><label>Pool size<input type="number" value={catalogPlanFeatureForm.pool_size} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, pool_size: event.target.value })} /></label><label>Max devices<input type="number" value={catalogPlanFeatureForm.max_active_devices} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, max_active_devices: event.target.value })} /></label><label>Max borrow<input type="number" value={catalogPlanFeatureForm.max_borrow_sec} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, max_borrow_sec: event.target.value })} /></label><button disabled={busy || selectedCatalogPlanId === ""} type="submit">Save plan feature</button></form>
        <h2>Plan projection</h2>
        <form aria-label="Plan projection" onSubmit={(event) => void submitPlanPreview(event)}><label>Project<input value={planForm.project} onChange={(event) => setPlanForm({ ...planForm, project: event.target.value })} /></label><label>License ID<input value={planForm.license_id} onChange={(event) => setPlanForm({ ...planForm, license_id: event.target.value })} /></label><label>Fingerprint<input value={planForm.license_fingerprint} onChange={(event) => setPlanForm({ ...planForm, license_fingerprint: event.target.value })} /></label><label>Customer ID<input value={planForm.customer_id} onChange={(event) => setPlanForm({ ...planForm, customer_id: event.target.value })} /></label><label>Plan key<input placeholder="pro" value={planForm.plan_key} onChange={(event) => setPlanForm({ ...planForm, plan_key: event.target.value })} /></label><label>Plan ID<input value={planForm.plan_id} onChange={(event) => setPlanForm({ ...planForm, plan_id: event.target.value })} /></label><label>Support until<input type="date" value={planForm.support_until} onChange={(event) => setPlanForm({ ...planForm, support_until: event.target.value })} /></label><label>Add-ons (csv)<input placeholder="team_seats,priority_support" value={planForm.addons} onChange={(event) => setPlanForm({ ...planForm, addons: event.target.value })} /></label><label>Notes<textarea value={planForm.notes} onChange={(event) => setPlanForm({ ...planForm, notes: event.target.value })} /></label><div className="actions"><button disabled={busy} type="submit">Preview</button><button disabled={busy || planPreview === null || planPreview.blocked.length > 0} type="button" onClick={() => void applyPlanProjectionFromForm()}>Apply</button></div></form>
        <h2>Catalog import</h2>
        <form aria-label="Catalog import" onSubmit={(event) => { event.preventDefault(); void runCatalogImport(true); }}><label>Manifest JSON<textarea value={catalogImportText} onChange={(event) => setCatalogImportText(event.target.value)} /></label><div className="actions"><button type="submit" disabled={busy || catalogImportText.trim() === ""}>Preview import</button><button type="button" disabled={busy || catalogImportText.trim() === ""} onClick={() => void runCatalogImport(false)}>Apply import</button></div>{catalogImportPreview !== null && <div className="details"><span>Features {catalogImportPreview.features.created}/{catalogImportPreview.features.updated}/{catalogImportPreview.features.unchanged}</span><span>Plans {catalogImportPreview.plans.created}/{catalogImportPreview.plans.updated}/{catalogImportPreview.plans.unchanged}</span><span>Rows {catalogImportPreview.plan_features.created}/{catalogImportPreview.plan_features.updated}/{catalogImportPreview.plan_features.unchanged}</span></div>}</form>
      </aside>
      <section className="tablePane">
        <section className="deliveriesPane"><h3>Catalog plans</h3><div className="filters"><input placeholder="project" value={catalogPlanFilter.project} onChange={(event) => setCatalogPlanFilter({ ...catalogPlanFilter, project: event.target.value })} /><select value={catalogPlanFilter.status} onChange={(event) => setCatalogPlanFilter({ ...catalogPlanFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div><table><thead><tr><th>Plan</th><th>Project</th><th>Version</th><th>Status</th><th>Actions</th></tr></thead><tbody>{catalogPlans.map((plan) => <tr key={plan.id} className={plan.id === selectedCatalogPlanId ? "selectedRow" : ""}><td>{plan.name}<div className="muted">{plan.plan_key}</div></td><td>{plan.project}</td><td>{plan.version}</td><td><span className={`status ${plan.status}`}>{plan.status}</span></td><td className="actions"><button type="button" disabled={busy} onClick={() => selectCatalogPlan(plan)}>Use</button><button type="button" disabled={busy} onClick={() => beginCatalogPlanEdit(plan)}>Edit</button><button type="button" disabled={busy} onClick={() => void exportCatalogPlan(plan)}>Export</button><button className="danger" type="button" disabled={busy || !canRunCatalogAction(plan.status, "disable")} onClick={() => requestConfirm({ title: "Disable plan", body: disableCatalogPlanConfirm(plan), requiresReason: true, run: () => catalogPlanTransition(plan, "disable") })}>Disable</button><button type="button" disabled={busy || !canRunCatalogAction(plan.status, "reenable")} onClick={() => void catalogPlanTransition(plan, "reenable")}>Reenable</button></td></tr>)}</tbody></table><div className="tableFooter"><span className="muted">{catalogPlans.length} shown</span>{catalogPlansCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(catalogPlansUrl, catalogPlansCursor, setCatalogPlans, setCatalogPlansCursor, setMessage)}>Load more</button>}</div></section>
        <section className="deliveriesPane"><h3>Catalog features</h3><div className="filters"><input placeholder="project" value={catalogFeatureFilter.project} onChange={(event) => setCatalogFeatureFilter({ ...catalogFeatureFilter, project: event.target.value })} /><select value={catalogFeatureFilter.status} onChange={(event) => setCatalogFeatureFilter({ ...catalogFeatureFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div><table><thead><tr><th>Feature</th><th>Project</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody>{catalogFeatures.map((feature) => <tr key={feature.id}><td>{feature.name}<div className="muted">{feature.feature_key}</div></td><td>{feature.project}</td><td>{feature.category || "-"}</td><td><span className={`status ${feature.status}`}>{feature.status}</span></td><td className="actions"><button type="button" disabled={busy} onClick={() => beginCatalogFeatureEdit(feature)}>Edit</button><button className="danger" type="button" disabled={busy || !canRunCatalogAction(feature.status, "disable")} onClick={() => requestConfirm({ title: "Disable feature", body: disableCatalogFeatureConfirm(feature), requiresReason: true, run: () => catalogFeatureTransition(feature, "disable") })}>Disable</button><button type="button" disabled={busy || !canRunCatalogAction(feature.status, "reenable")} onClick={() => void catalogFeatureTransition(feature, "reenable")}>Reenable</button></td></tr>)}</tbody></table><div className="tableFooter"><span className="muted">{catalogFeatures.length} shown</span>{catalogFeaturesCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(catalogFeaturesUrl, catalogFeaturesCursor, setCatalogFeatures, setCatalogFeaturesCursor, setMessage)}>Load more</button>}</div></section>
        <section className="deliveriesPane"><h3>{selectedCatalogPlan === null ? "Plan features" : `Plan features / ${selectedCatalogPlan.plan_key}`}</h3><table><thead><tr><th>Feature</th><th>Inclusion</th><th>Add-on</th><th>Policy</th><th>Overrides</th><th>Status</th><th>Actions</th></tr></thead><tbody>{catalogPlanFeatures.map((row) => <tr key={`${row.plan_id}:${row.feature_key}`}><td>{row.feature_name}<div className="muted">{row.feature_key}</div></td><td>{row.feature_inclusion}</td><td>{row.addon_key ?? "-"}</td><td>{row.policy_id ?? "-"}</td><td>{catalogOverrideSummary(row)}</td><td><span className={`status ${row.status}`}>{row.status}</span></td><td className="actions"><button className="danger" type="button" disabled={busy || !canRunCatalogAction(row.status, "disable")} onClick={() => requestConfirm({ title: "Disable plan row", body: disableCatalogPlanFeatureConfirm(row), requiresReason: true, run: () => catalogPlanFeatureTransition(row, "disable") })}>Disable</button><button type="button" disabled={busy || !canRunCatalogAction(row.status, "reenable")} onClick={() => void catalogPlanFeatureTransition(row, "reenable")}>Reenable</button></td></tr>)}</tbody></table>{catalogPlanFeatures.length === 0 && <p className="muted">No rows for the selected plan.</p>}</section>
        {planPreview === null ? <section className="deliveriesPane"><h3>Projection</h3><p className="muted">No preview loaded.</p></section> : <><section className="grid metrics"><div><span>Create</span><strong>{planPreview.summary.create}</strong></div><div><span>Update</span><strong>{planPreview.summary.update}</strong></div><div><span>Disable</span><strong>{planPreview.summary.disable}</strong></div><div><span>Blocked</span><strong>{planPreview.summary.blocked}</strong></div></section><section className="deliveriesPane"><h3>{planPreview.assignment.plan_key} / {planPreview.assignment.license_id}</h3><div className="details"><span>Project {planPreview.assignment.project}</span><span>Fingerprint {shortHash(planPreview.assignment.license_fingerprint)}</span><span>Customer {planPreview.assignment.customer_id ?? "-"}</span><span>Add-ons {planPreview.assignment.addons.length === 0 ? "-" : planPreview.assignment.addons.join(", ")}</span></div></section>{projectionRows("Create", planPreview.will_create)}{projectionRows("Update", planPreview.will_update)}{projectionRows("Disable", planPreview.will_disable)}{projectionRows("Blocked", planPreview.blocked)}{projectionRows("Unchanged", planPreview.unchanged)}</>}
      </section>
    </section>
  );
}
