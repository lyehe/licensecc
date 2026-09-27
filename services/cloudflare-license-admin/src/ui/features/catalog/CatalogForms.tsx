import React, { type FormEvent } from "react";

import type {
  CatalogFeature,
  CatalogImportApplyResult,
  CatalogImportPreviewResponse,
  CatalogPlan,
  CatalogPlanFeature,
  Policy,
} from "../../../shared/api";
import { FormStatus } from "../../shared/FeedbackText";
import { FieldDetails, FieldError, fieldProps, type FormFeedback } from "../../shared/fieldErrors";
import { formatEpoch } from "../../shared/format";
import type {
  CatalogFeatureFormState,
  CatalogPlanFeatureFormState,
  CatalogPlanFormState,
  PlanProjectionFormState,
} from "./workflow";
import type { PlanProjectionPreviewBinding } from "./usePlanProjectionWorkflow";
import { catalogImportEffectSummary, CatalogImportRows } from "./CatalogDetails";
import { CATALOG_FEATURE_FORM, CATALOG_IMPORT_FORM, CATALOG_PLAN_FEATURE_FORM, CATALOG_PLAN_FORM, PLAN_PROJECTION_FORM } from "./fieldErrors";

type FormSubmit = (event: FormEvent<HTMLFormElement>) => void;

/** Inline errors for one catalog form: input props, the error beside it, and clearing on edit. */
function inline(form: string, feedback: FormFeedback) {
  return {
    field: (name: string, label?: string) => fieldProps(form, feedback.errors, name, label),
    error: (name: string) => <FieldError form={form} field={name} errors={feedback.errors} />,
    details: (name: string) => <FieldDetails field={name} feedback={feedback} />,
  };
}

export function CatalogFeatureEditor({
  form,
  editingId,
  busy,
  actionable,
  feedback,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CatalogFeatureFormState;
  editingId: string | null;
  busy: boolean;
  actionable: boolean;
  feedback: FormFeedback;
  onChange: (form: CatalogFeatureFormState) => void;
  onSubmit: FormSubmit;
  onCancel: () => void;
}): React.ReactElement {
  const { field, error, details } = inline(CATALOG_FEATURE_FORM, feedback);
  const set = (name: keyof CatalogFeatureFormState, value: string): void => { feedback.clearField(name); onChange({ ...form, [name]: value }); };
  return <>
    <h2>{editingId === null ? "New feature" : "Edit feature"}</h2>
    <form id={CATALOG_FEATURE_FORM} aria-label="Catalog feature" onSubmit={onSubmit}>
      <label>Project<input disabled={editingId !== null} {...field("project", "Project")} value={form.project} onChange={(event) => set("project", event.target.value)} />{error("project")}</label>{details("project")}
      <label>Feature key<input disabled={editingId !== null} {...field("feature_key", "Feature key")} value={form.feature_key} onChange={(event) => set("feature_key", event.target.value)} />{error("feature_key")}</label>{details("feature_key")}
      <label>Name<input {...field("name", "Name")} value={form.name} onChange={(event) => set("name", event.target.value)} />{error("name")}</label>{details("name")}
      <label>Category<input {...field("category", "Category")} value={form.category} onChange={(event) => set("category", event.target.value)} />{error("category")}</label>{details("category")}
      <label>Status<select disabled={editingId !== null} value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as CatalogFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      <label>Description<textarea {...field("description", "Description")} value={form.description} onChange={(event) => set("description", event.target.value)} />{error("description")}</label>{details("description")}
      <FormStatus feedback={feedback.status} />
      <div className="actions">
        <button disabled={busy || !actionable} type="submit">{editingId === null ? "Create feature" : "Update feature"}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  </>;
}

export function CatalogPlanEditor({
  form,
  editingId,
  busy,
  actionable,
  feedback,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CatalogPlanFormState;
  editingId: string | null;
  busy: boolean;
  actionable: boolean;
  feedback: FormFeedback;
  onChange: (form: CatalogPlanFormState) => void;
  onSubmit: FormSubmit;
  onCancel: () => void;
}): React.ReactElement {
  const { field, error, details } = inline(CATALOG_PLAN_FORM, feedback);
  const set = (name: keyof CatalogPlanFormState, value: string | number): void => { feedback.clearField(name); onChange({ ...form, [name]: value }); };
  return <>
    <h2>{editingId === null ? "New plan" : "Edit plan"}</h2>
    <form id={CATALOG_PLAN_FORM} aria-label="Catalog plan" onSubmit={onSubmit}>
      <label>Project<input disabled={editingId !== null} {...field("project", "Project")} value={form.project} onChange={(event) => set("project", event.target.value)} />{error("project")}</label>{details("project")}
      <label>Plan key<input disabled={editingId !== null} {...field("plan_key", "Plan key")} value={form.plan_key} onChange={(event) => set("plan_key", event.target.value)} />{error("plan_key")}</label>{details("plan_key")}
      <label>Name<input {...field("name", "Name")} value={form.name} onChange={(event) => set("name", event.target.value)} />{error("name")}</label>{details("name")}
      <label>Version<input disabled={editingId !== null} type="number" {...field("version", "Version")} value={form.version} onChange={(event) => set("version", Number(event.target.value))} />{error("version")}</label>{details("version")}
      <label>Status<select disabled={editingId !== null} value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as CatalogPlan["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      <label>Description<textarea {...field("description", "Description")} value={form.description} onChange={(event) => set("description", event.target.value)} />{error("description")}</label>{details("description")}
      <FormStatus feedback={feedback.status} />
      <div className="actions">
        <button disabled={busy || !actionable} type="submit">{editingId === null ? "Create plan" : "Update plan"}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
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
  feedback,
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
  feedback: FormFeedback;
  onChange: (form: CatalogPlanFeatureFormState) => void;
  onSelectPlan: (plan: CatalogPlan) => void;
  onClearPlan: () => void;
  onSubmit: FormSubmit;
}): React.ReactElement {
  const { field, error, details } = inline(CATALOG_PLAN_FEATURE_FORM, feedback);
  const set = (name: keyof CatalogPlanFeatureFormState, value: string | number): void => { feedback.clearField(name); onChange({ ...form, [name]: value }); };
  return <>
    <h2>Plan feature</h2>
    <form id={CATALOG_PLAN_FEATURE_FORM} aria-label="Plan feature" onSubmit={onSubmit}>
      <label>Selected plan<select disabled={!plansSettled} value={selectedPlanId} onChange={(event) => {
        const plan = plans.find((item) => item.id === event.target.value);
        if (plan !== undefined) onSelectPlan(plan);
        else onClearPlan();
      }}><option value="">none</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.plan_key} ({plan.project})</option>)}</select></label>
      <label>Project<input {...field("project", "Project")} value={form.project} onChange={(event) => set("project", event.target.value)} />{error("project")}</label>{details("project")}
      <label>Feature key<input list="catalog-feature-keys" {...field("feature_key", "Feature key")} value={form.feature_key} onChange={(event) => set("feature_key", event.target.value)} />{error("feature_key")}</label>{details("feature_key")}
      <datalist id="catalog-feature-keys">{features.map((feature) => <option key={feature.id} value={feature.feature_key} />)}</datalist>
      <label>Inclusion<select value={form.feature_inclusion} onChange={(event) => onChange({ ...form, feature_inclusion: event.target.value as CatalogPlanFeature["feature_inclusion"] })}><option value="included">included</option><option value="addon">addon</option></select></label>
      {form.feature_inclusion === "addon" && <><label>Add-on key<input {...field("addon_key", "Add-on key")} value={form.addon_key} onChange={(event) => set("addon_key", event.target.value)} />{error("addon_key")}</label>{details("addon_key")}</>}
      <label>Policy<select aria-label="Policy" disabled={!activePoliciesSettled} {...field("policy_id", "Policy")} value={form.policy_id} onChange={(event) => set("policy_id", event.target.value)}><option value="">No policy</option>{form.policy_id && !policies.some(policy=>policy.id===form.policy_id) && <option value={form.policy_id}>Unavailable policy — choose another</option>}{policies.map(policy=><option key={policy.id} value={policy.id}>{policy.name} · {policy.project}</option>)}</select>{error("policy_id")}</label>{details("policy_id")}
      {form.policy_id && <details><summary>Policy details</summary><code>{form.policy_id}</code></details>}
      <label>Display order<input type="number" {...field("display_order", "Display order")} value={form.display_order} onChange={(event) => set("display_order", Number(event.target.value))} />{error("display_order")}</label>{details("display_order")}
      <label>Status<select value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as CatalogPlanFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      <label>Pool size<input type="number" {...field("pool_size", "Pool size")} value={form.pool_size} onChange={(event) => set("pool_size", event.target.value)} />{error("pool_size")}</label>{details("pool_size")}
      <label>Device limit<input type="number" {...field("max_active_devices", "Device limit")} value={form.max_active_devices} onChange={(event) => set("max_active_devices", event.target.value)} />{error("max_active_devices")}</label>{details("max_active_devices")}
      <label>Max borrow (seconds)<input type="number" {...field("max_borrow_sec", "Max borrow (seconds)")} value={form.max_borrow_sec} onChange={(event) => set("max_borrow_sec", event.target.value)} />{error("max_borrow_sec")}</label>{details("max_borrow_sec")}
      <FormStatus feedback={feedback.status} />
      <button disabled={busy || !plansSettled || !activePoliciesSettled || !selectedPlanId || !plans.some((plan) => plan.id === selectedPlanId)} type="submit">Save plan feature</button>
    </form>
  </>;
}

export function PlanProjectionEditor({
  form,
  previewBinding,
  busy,
  feedback,
  onUpdate,
  onSubmit,
  onApply,
}: {
  form: PlanProjectionFormState;
  previewBinding: PlanProjectionPreviewBinding | null;
  busy: boolean;
  feedback: FormFeedback;
  onUpdate: (updater: (current: PlanProjectionFormState) => PlanProjectionFormState) => void;
  onSubmit: FormSubmit;
  onApply: () => void;
}): React.ReactElement {
  const { field, error, details } = inline(PLAN_PROJECTION_FORM, feedback);
  const set = (name: keyof PlanProjectionFormState, value: string): void => { feedback.clearField(name); onUpdate((current) => ({ ...current, [name]: value })); };
  return <>
    <h2>Plan projection</h2>
    <p>Preview the access records this plan will create, update, or disable for a license, then apply the reviewed result.</p>
    <form id={PLAN_PROJECTION_FORM} aria-label="Plan projection" onSubmit={onSubmit}>
      <label>Project<input {...field("project", "Project")} value={form.project} onChange={(event) => set("project", event.target.value)} />{error("project")}</label>{details("project")}
      <label>License ID<input {...field("license_id", "License ID")} value={form.license_id} onChange={(event) => set("license_id", event.target.value)} />{error("license_id")}</label>{details("license_id")}
      <label>Fingerprint<input {...field("license_fingerprint", "Fingerprint")} value={form.license_fingerprint} onChange={(event) => set("license_fingerprint", event.target.value)} />{error("license_fingerprint")}</label>{details("license_fingerprint")}
      <label>Customer ID<input {...field("customer_id", "Customer ID")} value={form.customer_id} onChange={(event) => set("customer_id", event.target.value)} />{error("customer_id")}</label>{details("customer_id")}
      <label>Plan key<input placeholder="pro" {...field("plan_key", "Plan key")} value={form.plan_key} onChange={(event) => set("plan_key", event.target.value)} />{error("plan_key")}</label>{details("plan_key")}
      <label>Plan ID<input {...field("plan_id", "Plan ID")} value={form.plan_id} onChange={(event) => set("plan_id", event.target.value)} />{error("plan_id")}</label>{details("plan_id")}
      <label>Support until<input type="date" {...field("support_until", "Support until")} value={form.support_until} onChange={(event) => set("support_until", event.target.value)} />{error("support_until")}</label>{details("support_until")}
      <label>Add-ons (csv)<input placeholder="team_seats,priority_support" {...field("addons", "Add-ons (csv)")} value={form.addons} onChange={(event) => set("addons", event.target.value)} />{error("addons")}</label>{details("addons")}
      <label>Notes<textarea {...field("notes", "Notes")} value={form.notes} onChange={(event) => set("notes", event.target.value)} />{error("notes")}</label>{details("notes")}
      <FormStatus feedback={feedback.status} />
      <div className="actions"><button disabled={busy} type="submit">Preview</button><button disabled={busy || previewBinding === null || previewBinding.preview.blocked.length > 0} type="button" onClick={onApply}>Apply</button></div>
    </form>
  </>;
}

export function CatalogImportEditor({
  text,
  previewBinding,
  preview,
  busy,
  feedback,
  onUpdate,
  onPreview,
  onApply,
}: {
  text: string;
  previewBinding: { digest: string; preview: CatalogImportPreviewResponse } | null;
  preview: CatalogImportPreviewResponse | CatalogImportApplyResult | null;
  busy: boolean;
  feedback: FormFeedback;
  onUpdate: (value: string) => void;
  onPreview: () => void;
  onApply: () => void;
}): React.ReactElement {
  return <section data-focus-section="catalog-import">
    <h2>Catalog import</h2>
    <p>Preview a catalog manifest and review every planned transition before applying it.</p>
    <form id={CATALOG_IMPORT_FORM} aria-label="Catalog import" onSubmit={(event) => { event.preventDefault(); onPreview(); }}>
      <label>Manifest JSON<textarea {...fieldProps(CATALOG_IMPORT_FORM, feedback.errors, "manifest", "Manifest JSON")} value={text} onChange={(event) => { feedback.clearField("manifest"); onUpdate(event.target.value); }} /><FieldError form={CATALOG_IMPORT_FORM} field="manifest" errors={feedback.errors} /></label><FieldDetails field="manifest" feedback={feedback} />
      <FormStatus feedback={feedback.status} />
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
