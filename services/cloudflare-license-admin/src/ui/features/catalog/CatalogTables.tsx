import React from "react";

import type {
  CatalogFeature,
  CatalogPlan,
  CatalogPlanFeature,
  PlanProjectionApplyResult,
  PlanProjectionPreviewResponse,
} from "../../../shared/api";
import { formatEpoch, shortHash } from "../../shared/format";
import { ActionMenu, StatusActions } from "../../shared/ActionMenu";
import type { CatalogFilter } from "./workflow";
import type { PlanProjectionPreviewBinding } from "./usePlanProjectionWorkflow";
import { catalogOverrideSummary, ProjectionRows } from "./CatalogDetails";

export function CatalogPlansTable({
  plans,
  selectedPlanId,
  filter,
  hasMore,
  loaded,
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
  loaded: boolean;
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
  return <section className="catalogRecords">
    <h3>Catalog plans</h3>
    <div className="filters filterBar"><label>Plan project<input placeholder="project" value={filter.project} onChange={(event) => onFilter({ ...filter, project: event.target.value })} /></label><label>Plan status<select value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option></select></label><button type="button" onClick={() => onFilter({ project: "", status: "" })}>Clear filters</button></div>
    {loaded && plans.length === 0 && <p className="emptyState">{filter.project || filter.status ? "No plans match these filters." : "No plans yet. Create a plan to define its included features."}</p>}
    <div className="desktopRecords tableScroll" role="region" aria-label="Catalog plans table" tabIndex={0}><table><thead><tr><th>Plan</th><th>Project</th><th>Version</th><th>Status</th><th>Actions</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id} className={plan.id === selectedPlanId ? "selectedRow" : ""} data-focus-row={`catalog-plan:${plan.id}`}>
      <td>{plan.name}<div className="muted">{plan.plan_key}</div></td><td>{plan.project}</td><td>{plan.version}</td><td><span className={`status ${plan.status}`}>{plan.status}</span></td>
      <td className="actions"><button type="button" disabled={actionsDisabled} onClick={() => onSelect(plan)}>View plan</button><button type="button" disabled={actionsDisabled} onClick={() => onEdit(plan)}>Edit</button><ActionMenu label="Actions"><button type="button" disabled={actionsDisabled} onClick={() => onExport(plan)}>Export</button><button data-focus-action="disable" className="danger" type="button" disabled={actionsDisabled || !canDisable(plan)} onClick={() => onDisable(plan)}>Disable</button><button data-focus-action="reenable" type="button" disabled={actionsDisabled || !canReenable(plan)} onClick={() => onReenable(plan)}>Reenable</button></ActionMenu></td>
    </tr>)}</tbody></table></div>
    <div className="recordCards">{plans.map((plan) => <article className="recordCard" key={plan.id} data-focus-row={`catalog-plan:${plan.id}`}><h3>{plan.name || plan.plan_key}</h3><p>{plan.project} / {plan.plan_key} · Version {plan.version}</p><span className={`status ${plan.status}`}>{plan.status}</span><div className="actions"><button type="button" disabled={actionsDisabled} onClick={() => onSelect(plan)}>View plan</button><button type="button" disabled={actionsDisabled} onClick={() => onEdit(plan)}>Edit</button><ActionMenu label="Actions"><button type="button" disabled={actionsDisabled} onClick={() => onExport(plan)}>Export</button><button data-focus-action="disable" className="danger" type="button" disabled={actionsDisabled || !canDisable(plan)} onClick={() => onDisable(plan)}>Disable</button><button data-focus-action="reenable" type="button" disabled={actionsDisabled || !canReenable(plan)} onClick={() => onReenable(plan)}>Reenable</button></ActionMenu></div></article>)}</div>
    <div className="tableFooter">{loaded && <span className="muted">{plans.length} shown</span>}{hasMore && <button type="button" disabled={actionsDisabled} onClick={onLoadMore}>Load more</button>}</div>
  </section>;
}

export function CatalogFeaturesTable({
  features,
  filter,
  hasMore,
  loaded,
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
  loaded: boolean;
  actionsDisabled: boolean;
  canDisable: (feature: CatalogFeature) => boolean;
  canReenable: (feature: CatalogFeature) => boolean;
  onFilter: (filter: CatalogFilter) => void;
  onEdit: (feature: CatalogFeature) => void;
  onDisable: (feature: CatalogFeature) => void;
  onReenable: (feature: CatalogFeature) => void;
  onLoadMore: () => void;
}): React.ReactElement {
  return <section className="catalogRecords">
    <h3>Catalog features</h3>
    <div className="filters filterBar"><label>Feature project<input placeholder="project" value={filter.project} onChange={(event) => onFilter({ ...filter, project: event.target.value })} /></label><label>Feature status<select value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option></select></label><button type="button" onClick={() => onFilter({ project: "", status: "" })}>Clear filters</button></div>
    {loaded && features.length === 0 && <p className="emptyState">{filter.project || filter.status ? "No features match these filters." : "No features yet. Create a feature to include it in a plan."}</p>}
    <div className="desktopRecords tableScroll" role="region" aria-label="Catalog features table" tabIndex={0}><table><thead><tr><th>Feature</th><th>Project</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody>{features.map((feature) => <tr key={feature.id} data-focus-row={`catalog-feature:${feature.id}`}>
      <td>{feature.name}<div className="muted">{feature.feature_key}</div></td><td>{feature.project}</td><td>{feature.category || "-"}</td><td><span className={`status ${feature.status}`}>{feature.status}</span></td>
      <td className="actions"><button type="button" disabled={actionsDisabled} onClick={() => onEdit(feature)}>Edit</button><StatusActions status={feature.status}><button data-focus-action="disable" className="danger" type="button" disabled={actionsDisabled || !canDisable(feature)} onClick={() => onDisable(feature)}>Disable</button><button data-focus-action="reenable" type="button" disabled={actionsDisabled || !canReenable(feature)} onClick={() => onReenable(feature)}>Reenable</button></StatusActions></td>
    </tr>)}</tbody></table></div>
    <div className="recordCards">{features.map((feature) => <article className="recordCard" key={feature.id} data-focus-row={`catalog-feature:${feature.id}`}><h3>{feature.name || feature.feature_key}</h3><p>{feature.project} / {feature.feature_key}</p><span className={`status ${feature.status}`}>{feature.status}</span><div className="actions"><button type="button" disabled={actionsDisabled} onClick={() => onEdit(feature)}>Edit</button><StatusActions status={feature.status}><button data-focus-action="disable" className="danger" type="button" disabled={actionsDisabled || !canDisable(feature)} onClick={() => onDisable(feature)}>Disable</button><button data-focus-action="reenable" type="button" disabled={actionsDisabled || !canReenable(feature)} onClick={() => onReenable(feature)}>Reenable</button></StatusActions></div></article>)}</div>
    <div className="tableFooter">{loaded && <span className="muted">{features.length} shown</span>}{hasMore && <button type="button" disabled={actionsDisabled} onClick={onLoadMore}>Load more</button>}</div>
  </section>;
}

export function CatalogPlanFeaturesTable({
  rows,
  loaded,
  selectedPlan,
  busy,
  canDisable,
  canReenable,
  onDisable,
  onReenable,
}: {
  rows: CatalogPlanFeature[];
  loaded: boolean;
  selectedPlan: CatalogPlan | null;
  busy: boolean;
  canDisable: (row: CatalogPlanFeature) => boolean;
  canReenable: (row: CatalogPlanFeature) => boolean;
  onDisable: (row: CatalogPlanFeature) => void;
  onReenable: (row: CatalogPlanFeature) => void;
}): React.ReactElement {
  return <section className="catalogRecords">
    <h3>{selectedPlan === null ? "Plan features" : `Plan features / ${selectedPlan.plan_key}`}</h3>
    <div className="tableScroll" role="region" aria-label="Plan features table" tabIndex={0}><table><thead><tr><th>Feature</th><th>Inclusion</th><th>Add-on</th><th>Policy</th><th>Overrides</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.plan_id}:${row.feature_key}`} data-focus-row={`catalog-plan-feature:${row.plan_id}:${row.feature_key}`}>
      <td>{row.feature_name}<div className="muted">{row.feature_key}</div></td><td>{row.feature_inclusion}</td><td>{row.addon_key ?? "-"}</td><td>{row.policy_id ?? "-"}</td><td>{catalogOverrideSummary(row)}</td><td><span className={`status ${row.status}`}>{row.status}</span></td>
      <td className="actions"><StatusActions status={row.status}><button className="danger" type="button" disabled={busy || !canDisable(row)} onClick={() => onDisable(row)}>Disable</button><button data-focus-action="reenable" type="button" disabled={busy || !canReenable(row)} onClick={() => onReenable(row)}>Reenable</button></StatusActions></td>
    </tr>)}</tbody></table></div>
    {loaded && rows.length === 0 && <p className="muted">No features for this plan. Use Add feature to configure one.</p>}
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
    return <section className="catalogRecords"><h3>Projection</h3><p className="muted">No preview loaded.</p></section>;
  }
  return <>
    <section className="grid metrics"><div><span>Create</span><strong>{preview.summary.create}</strong></div><div><span>Update</span><strong>{preview.summary.update}</strong></div><div><span>Disable</span><strong>{preview.summary.disable}</strong></div><div><span>Blocked</span><strong>{preview.summary.blocked}</strong></div></section>
    <section className="catalogRecords"><h3>{preview.assignment.plan_key} / {preview.assignment.license_id}</h3><div className="details"><span>Project {preview.assignment.project}</span><span>Fingerprint {shortHash(preview.assignment.license_fingerprint)}</span><span>Customer {preview.assignment.customer_id ?? "-"}</span><span>Add-ons {preview.assignment.addons.length === 0 ? "-" : preview.assignment.addons.join(", ")}</span>{binding === null ? <span>Execution result; re-preview required before another Apply</span> : <><span>Server preview {binding.preview.preview_id}</span><span>Effective {formatEpoch(binding.preview.effective_at)}</span><details><summary>Technical details</summary><span>Local form digest {binding.digest}</span></details></>}</div></section>
    <ProjectionRows title="Create" items={preview.will_create} />
    <ProjectionRows title="Update" items={preview.will_update} />
    <ProjectionRows title="Disable" items={preview.will_disable} />
    <ProjectionRows title="Blocked" items={preview.blocked} />
    <ProjectionRows title="Unchanged" items={preview.unchanged} />
  </>;
}
