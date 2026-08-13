import React from "react";

import type {
  CatalogFeature,
  CatalogPlan,
  CatalogPlanFeature,
  PlanProjectionApplyResult,
  PlanProjectionPreviewResponse,
} from "../../../shared/api";
import { formatEpoch, shortHash } from "../../shared/format";
import type { CatalogFilter } from "./workflow";
import type { PlanProjectionPreviewBinding } from "./usePlanProjectionWorkflow";
import { catalogOverrideSummary, ProjectionRows } from "./CatalogDetails";

export function CatalogPlansTable({
  plans,
  selectedPlanId,
  filter,
  hasMore,
  actionsDisabled,
  canDisable,
  canReenable,
  onFilter,
  onSelect,
  onEdit,
  onExport,
  onDisable,
  onReenable,
  onLoadMore,
}: {
  plans: CatalogPlan[];
  selectedPlanId: string;
  filter: CatalogFilter;
  hasMore: boolean;
  actionsDisabled: boolean;
  canDisable: (plan: CatalogPlan) => boolean;
  canReenable: (plan: CatalogPlan) => boolean;
  onFilter: (filter: CatalogFilter) => void;
  onSelect: (plan: CatalogPlan) => void;
  onEdit: (plan: CatalogPlan) => void;
  onExport: (plan: CatalogPlan) => void;
  onDisable: (plan: CatalogPlan) => void;
  onReenable: (plan: CatalogPlan) => void;
  onLoadMore: () => void;
}): React.ReactElement {
  return <section className="deliveriesPane">
    <h3>Catalog plans</h3>
    <div className="filters"><input placeholder="project" value={filter.project} onChange={(event) => onFilter({ ...filter, project: event.target.value })} /><select value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div>
    <table><thead><tr><th>Plan</th><th>Project</th><th>Version</th><th>Status</th><th>Actions</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id} className={plan.id === selectedPlanId ? "selectedRow" : ""} data-focus-row={`catalog-plan:${plan.id}`}>
      <td>{plan.name}<div className="muted">{plan.plan_key}</div></td><td>{plan.project}</td><td>{plan.version}</td><td><span className={`status ${plan.status}`}>{plan.status}</span></td>
      <td className="actions"><button type="button" disabled={actionsDisabled} onClick={() => onSelect(plan)}>Use</button><button type="button" disabled={actionsDisabled} onClick={() => onEdit(plan)}>Edit</button><button type="button" disabled={actionsDisabled} onClick={() => onExport(plan)}>Export</button><button className="danger" type="button" disabled={actionsDisabled || !canDisable(plan)} onClick={() => onDisable(plan)}>Disable</button><button data-focus-action="reenable" type="button" disabled={actionsDisabled || !canReenable(plan)} onClick={() => onReenable(plan)}>Reenable</button></td>
    </tr>)}</tbody></table>
    <div className="tableFooter"><span className="muted">{plans.length} shown</span>{hasMore && <button type="button" disabled={actionsDisabled} onClick={onLoadMore}>Load more</button>}</div>
  </section>;
}

export function CatalogFeaturesTable({
  features,
  filter,
  hasMore,
  actionsDisabled,
  canDisable,
  canReenable,
  onFilter,
  onEdit,
  onDisable,
  onReenable,
  onLoadMore,
}: {
  features: CatalogFeature[];
  filter: CatalogFilter;
  hasMore: boolean;
  actionsDisabled: boolean;
  canDisable: (feature: CatalogFeature) => boolean;
  canReenable: (feature: CatalogFeature) => boolean;
  onFilter: (filter: CatalogFilter) => void;
  onEdit: (feature: CatalogFeature) => void;
  onDisable: (feature: CatalogFeature) => void;
  onReenable: (feature: CatalogFeature) => void;
  onLoadMore: () => void;
}): React.ReactElement {
  return <section className="deliveriesPane">
    <h3>Catalog features</h3>
    <div className="filters"><input placeholder="project" value={filter.project} onChange={(event) => onFilter({ ...filter, project: event.target.value })} /><select value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div>
    <table><thead><tr><th>Feature</th><th>Project</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody>{features.map((feature) => <tr key={feature.id} data-focus-row={`catalog-feature:${feature.id}`}>
      <td>{feature.name}<div className="muted">{feature.feature_key}</div></td><td>{feature.project}</td><td>{feature.category || "-"}</td><td><span className={`status ${feature.status}`}>{feature.status}</span></td>
      <td className="actions"><button type="button" disabled={actionsDisabled} onClick={() => onEdit(feature)}>Edit</button><button className="danger" type="button" disabled={actionsDisabled || !canDisable(feature)} onClick={() => onDisable(feature)}>Disable</button><button data-focus-action="reenable" type="button" disabled={actionsDisabled || !canReenable(feature)} onClick={() => onReenable(feature)}>Reenable</button></td>
    </tr>)}</tbody></table>
    <div className="tableFooter"><span className="muted">{features.length} shown</span>{hasMore && <button type="button" disabled={actionsDisabled} onClick={onLoadMore}>Load more</button>}</div>
  </section>;
}

export function CatalogPlanFeaturesTable({
  rows,
  selectedPlan,
  busy,
  canDisable,
  canReenable,
  onDisable,
  onReenable,
}: {
  rows: CatalogPlanFeature[];
  selectedPlan: CatalogPlan | null;
  busy: boolean;
  canDisable: (row: CatalogPlanFeature) => boolean;
  canReenable: (row: CatalogPlanFeature) => boolean;
  onDisable: (row: CatalogPlanFeature) => void;
  onReenable: (row: CatalogPlanFeature) => void;
}): React.ReactElement {
  return <section className="deliveriesPane">
    <h3>{selectedPlan === null ? "Plan features" : `Plan features / ${selectedPlan.plan_key}`}</h3>
    <table><thead><tr><th>Feature</th><th>Inclusion</th><th>Add-on</th><th>Policy</th><th>Overrides</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.plan_id}:${row.feature_key}`} data-focus-row={`catalog-plan-feature:${row.plan_id}:${row.feature_key}`}>
      <td>{row.feature_name}<div className="muted">{row.feature_key}</div></td><td>{row.feature_inclusion}</td><td>{row.addon_key ?? "-"}</td><td>{row.policy_id ?? "-"}</td><td>{catalogOverrideSummary(row)}</td><td><span className={`status ${row.status}`}>{row.status}</span></td>
      <td className="actions"><button className="danger" type="button" disabled={busy || !canDisable(row)} onClick={() => onDisable(row)}>Disable</button><button data-focus-action="reenable" type="button" disabled={busy || !canReenable(row)} onClick={() => onReenable(row)}>Reenable</button></td>
    </tr>)}</tbody></table>
    {rows.length === 0 && <p className="muted">No rows for the selected plan.</p>}
  </section>;
}

export function PlanProjectionResults({
  preview,
  binding,
}: {
  preview: PlanProjectionPreviewResponse | PlanProjectionApplyResult | null;
  binding: PlanProjectionPreviewBinding | null;
}): React.ReactElement {
  if (preview === null) {
    return <section className="deliveriesPane"><h3>Projection</h3><p className="muted">No preview loaded.</p></section>;
  }
  return <>
    <section className="grid metrics"><div><span>Create</span><strong>{preview.summary.create}</strong></div><div><span>Update</span><strong>{preview.summary.update}</strong></div><div><span>Disable</span><strong>{preview.summary.disable}</strong></div><div><span>Blocked</span><strong>{preview.summary.blocked}</strong></div></section>
    <section className="deliveriesPane"><h3>{preview.assignment.plan_key} / {preview.assignment.license_id}</h3><div className="details"><span>Project {preview.assignment.project}</span><span>Fingerprint {shortHash(preview.assignment.license_fingerprint)}</span><span>Customer {preview.assignment.customer_id ?? "-"}</span><span>Add-ons {preview.assignment.addons.length === 0 ? "-" : preview.assignment.addons.join(", ")}</span>{binding === null ? <span>Execution result; re-preview required before another Apply</span> : <><span>Server preview {binding.preview.preview_id}</span><span>Effective {formatEpoch(binding.preview.effective_at)}</span><span>Local form digest {binding.digest}</span></>}</div></section>
    <ProjectionRows title="Create" items={preview.will_create} />
    <ProjectionRows title="Update" items={preview.will_update} />
    <ProjectionRows title="Disable" items={preview.will_disable} />
    <ProjectionRows title="Blocked" items={preview.blocked} />
    <ProjectionRows title="Unchanged" items={preview.unchanged} />
  </>;
}
