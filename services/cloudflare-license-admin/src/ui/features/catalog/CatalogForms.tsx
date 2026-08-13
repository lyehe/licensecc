import React, { type FormEvent } from "react";

import type {
  CatalogFeature,
  CatalogImportApplyResult,
  CatalogImportPreviewResponse,
  CatalogPlan,
  CatalogPlanFeature,
  Policy,
} from "../../../shared/api";
import { formatEpoch } from "../../shared/format";
import type {
  CatalogFeatureFormState,
  CatalogPlanFeatureFormState,
  CatalogPlanFormState,
  PlanProjectionFormState,
} from "./workflow";
import type { PlanProjectionPreviewBinding } from "./usePlanProjectionWorkflow";
import { catalogImportEffectSummary, CatalogImportRows } from "./CatalogDetails";

type FormSubmit = (event: FormEvent<HTMLFormElement>) => void;

export function CatalogFeatureEditor({
  form,
  editingId,
  busy,
  actionable,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CatalogFeatureFormState;
  editingId: string | null;
  busy: boolean;
  actionable: boolean;
  onChange: (form: CatalogFeatureFormState) => void;
  onSubmit: FormSubmit;
  onCancel: () => void;
}): React.ReactElement {
  return <>
    <h2>{editingId === null ? "Catalog feature" : "Edit feature"}</h2>
    <form aria-label="Catalog feature" onSubmit={onSubmit}>
      <label>Project<input disabled={editingId !== null} value={form.project} onChange={(event) => onChange({ ...form, project: event.target.value })} /></label>
      <label>Feature key<input disabled={editingId !== null} value={form.feature_key} onChange={(event) => onChange({ ...form, feature_key: event.target.value })} /></label>
      <label>Name<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} /></label>
      <label>Category<input value={form.category} onChange={(event) => onChange({ ...form, category: event.target.value })} /></label>
      <label>Status<select disabled={editingId !== null} value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as CatalogFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      <label>Description<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} /></label>
      <div className="actions">
        <button disabled={busy || !actionable} type="submit">{editingId === null ? "Create feature" : "Update feature"}</button>
        {editingId !== null && <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  </>;
}

export function CatalogPlanEditor({
  form,
  editingId,
  busy,
  actionable,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CatalogPlanFormState;
  editingId: string | null;
  busy: boolean;
  actionable: boolean;
  onChange: (form: CatalogPlanFormState) => void;
  onSubmit: FormSubmit;
  onCancel: () => void;
}): React.ReactElement {
  return <>
    <h2>{editingId === null ? "Catalog plan" : "Edit plan"}</h2>
    <form aria-label="Catalog plan" onSubmit={onSubmit}>
      <label>Project<input disabled={editingId !== null} value={form.project} onChange={(event) => onChange({ ...form, project: event.target.value })} /></label>
      <label>Plan key<input disabled={editingId !== null} value={form.plan_key} onChange={(event) => onChange({ ...form, plan_key: event.target.value })} /></label>
      <label>Name<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} /></label>
      <label>Version<input disabled={editingId !== null} type="number" value={form.version} onChange={(event) => onChange({ ...form, version: Number(event.target.value) })} /></label>
      <label>Status<select disabled={editingId !== null} value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as CatalogPlan["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      <label>Description<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} /></label>
      <div className="actions">
        <button disabled={busy || !actionable} type="submit">{editingId === null ? "Create plan" : "Update plan"}</button>
        {editingId !== null && <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  </>;
}

export function CatalogPlanFeatureEditor({
  form,
  busy,
  plansSettled,
  activePoliciesSettled,
  selectedPlanId,
  plans,
  features,
  policies,
  onChange,
  onSelectPlan,
  onClearPlan,
  onSubmit,
}: {
  form: CatalogPlanFeatureFormState;
  busy: boolean;
  plansSettled: boolean;
  activePoliciesSettled: boolean;
  selectedPlanId: string;
  plans: CatalogPlan[];
  features: CatalogFeature[];
  policies: Policy[];
  onChange: (form: CatalogPlanFeatureFormState) => void;
  onSelectPlan: (plan: CatalogPlan) => void;
  onClearPlan: () => void;
  onSubmit: FormSubmit;
}): React.ReactElement {
  return <>
    <h2>Plan feature</h2>
    <form aria-label="Plan feature" onSubmit={onSubmit}>
      <label>Selected plan<select disabled={!plansSettled} value={selectedPlanId} onChange={(event) => {
        const plan = plans.find((item) => item.id === event.target.value);
        if (plan !== undefined) onSelectPlan(plan);
        else onClearPlan();
      }}><option value="">none</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.plan_key} ({plan.project})</option>)}</select></label>
      <label>Project<input value={form.project} onChange={(event) => onChange({ ...form, project: event.target.value })} /></label>
      <label>Feature key<input list="catalog-feature-keys" value={form.feature_key} onChange={(event) => onChange({ ...form, feature_key: event.target.value })} /></label>
      <datalist id="catalog-feature-keys">{features.map((feature) => <option key={feature.id} value={feature.feature_key} />)}</datalist>
      <label>Inclusion<select value={form.feature_inclusion} onChange={(event) => onChange({ ...form, feature_inclusion: event.target.value as CatalogPlanFeature["feature_inclusion"] })}><option value="included">included</option><option value="addon">addon</option></select></label>
      {form.feature_inclusion === "addon" && <label>Add-on key<input value={form.addon_key} onChange={(event) => onChange({ ...form, addon_key: event.target.value })} /></label>}
      <label>Policy ID<input disabled={!activePoliciesSettled} list="active-policy-ids" value={form.policy_id} onChange={(event) => onChange({ ...form, policy_id: event.target.value })} /></label>
      <datalist id="active-policy-ids">{policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}</datalist>
      <label>Display order<input type="number" value={form.display_order} onChange={(event) => onChange({ ...form, display_order: Number(event.target.value) })} /></label>
      <label>Status<select value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as CatalogPlanFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      <label>Pool size<input type="number" value={form.pool_size} onChange={(event) => onChange({ ...form, pool_size: event.target.value })} /></label>
      <label>Max devices<input type="number" value={form.max_active_devices} onChange={(event) => onChange({ ...form, max_active_devices: event.target.value })} /></label>
      <label>Max borrow<input type="number" value={form.max_borrow_sec} onChange={(event) => onChange({ ...form, max_borrow_sec: event.target.value })} /></label>
      <button disabled={busy || !plansSettled || !activePoliciesSettled || selectedPlanId === ""} type="submit">Save plan feature</button>
    </form>
  </>;
}

export function PlanProjectionEditor({
  form,
  previewBinding,
  busy,
  onUpdate,
  onSubmit,
  onApply,
}: {
  form: PlanProjectionFormState;
  previewBinding: PlanProjectionPreviewBinding | null;
  busy: boolean;
  onUpdate: (updater: (current: PlanProjectionFormState) => PlanProjectionFormState) => void;
  onSubmit: FormSubmit;
  onApply: () => void;
}): React.ReactElement {
  return <>
    <h2>Plan projection</h2>
    <form aria-label="Plan projection" onSubmit={onSubmit}>
      <label>Project<input value={form.project} onChange={(event) => onUpdate((current) => ({ ...current, project: event.target.value }))} /></label>
      <label>License ID<input value={form.license_id} onChange={(event) => onUpdate((current) => ({ ...current, license_id: event.target.value }))} /></label>
      <label>Fingerprint<input value={form.license_fingerprint} onChange={(event) => onUpdate((current) => ({ ...current, license_fingerprint: event.target.value }))} /></label>
      <label>Customer ID<input value={form.customer_id} onChange={(event) => onUpdate((current) => ({ ...current, customer_id: event.target.value }))} /></label>
      <label>Plan key<input placeholder="pro" value={form.plan_key} onChange={(event) => onUpdate((current) => ({ ...current, plan_key: event.target.value }))} /></label>
      <label>Plan ID<input value={form.plan_id} onChange={(event) => onUpdate((current) => ({ ...current, plan_id: event.target.value }))} /></label>
      <label>Support until<input type="date" value={form.support_until} onChange={(event) => onUpdate((current) => ({ ...current, support_until: event.target.value }))} /></label>
      <label>Add-ons (csv)<input placeholder="team_seats,priority_support" value={form.addons} onChange={(event) => onUpdate((current) => ({ ...current, addons: event.target.value }))} /></label>
      <label>Notes<textarea value={form.notes} onChange={(event) => onUpdate((current) => ({ ...current, notes: event.target.value }))} /></label>
      <div className="actions"><button disabled={busy} type="submit">Preview</button><button disabled={busy || previewBinding === null || previewBinding.preview.blocked.length > 0} type="button" onClick={onApply}>Apply</button></div>
    </form>
  </>;
}

export function CatalogImportEditor({
  text,
  previewBinding,
  preview,
  busy,
  onUpdate,
  onPreview,
  onApply,
}: {
  text: string;
  previewBinding: { digest: string; preview: CatalogImportPreviewResponse } | null;
  preview: CatalogImportPreviewResponse | CatalogImportApplyResult | null;
  busy: boolean;
  onUpdate: (value: string) => void;
  onPreview: () => void;
  onApply: () => void;
}): React.ReactElement {
  return <section data-focus-section="catalog-import">
    <h2>Catalog import</h2>
    <form aria-label="Catalog import" onSubmit={(event) => { event.preventDefault(); onPreview(); }}>
      <label>Manifest JSON<textarea value={text} onChange={(event) => onUpdate(event.target.value)} /></label>
      <div className="actions"><button type="submit" disabled={busy || text.trim() === ""}>Preview import</button><button type="button" disabled={busy || previewBinding === null} onClick={onApply}>Apply import</button></div>
      {preview !== null && <div className="details">
        <span>{catalogImportEffectSummary("Features", preview.effects.summary.features)}</span>
        <span>{catalogImportEffectSummary("Plans", preview.effects.summary.plans)}</span>
        <span>{catalogImportEffectSummary("Plan rows", preview.effects.summary.plan_features)}</span>
        {previewBinding === null
          ? <span>Applied; preview again before another Apply</span>
          : <><span>Server preview {previewBinding.preview.preview_id}</span><span>Server digest {previewBinding.preview.manifest_digest}</span><span>Local manifest digest {previewBinding.digest}</span><span>Effective {formatEpoch(previewBinding.preview.effective_at)}</span></>}
      </div>}
    </form>
    {preview !== null && <>
      <p className="muted">Each target and transition is server-derived from the persisted preview snapshot.</p>
      <CatalogImportRows title="Imported features" effects={preview.effects.features} />
      <CatalogImportRows title="Imported plans" effects={preview.effects.plans} />
      <CatalogImportRows title="Imported plan rows" effects={preview.effects.plan_features} />
    </>}
  </section>;
}
