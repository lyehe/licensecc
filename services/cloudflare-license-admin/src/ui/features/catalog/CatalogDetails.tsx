import React from "react";

import type { CatalogImportEffect, CatalogImportPreviewResponse, CatalogPlanFeature, PlanProjectionItem } from "../../../shared/api";
import { formatEpoch } from "../../shared/format";
import { catalogImportEffectValueLabel, catalogImportTargetFields, catalogImportTargetKey } from "./workflow";

export function ProjectionRows({ title, items }: { title: string; items: PlanProjectionItem[] }): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section className="deliveriesPane">
      <h3>{title}</h3>
      <table>
        <thead><tr><th>Feature</th><th>Mode</th><th>Policy</th><th>Window</th><th>Capacity</th><th>Source</th></tr></thead>
        <tbody>{items.map((item) => (
          <tr key={`${title}:${item.feature}`}>
            <td>{item.feature}</td><td>{item.license_mode}</td><td>{item.policy_id ?? "-"}</td>
            <td>{item.valid_until === null ? "open" : formatEpoch(item.valid_until)}</td>
            <td>{item.pool_size > 0 ? `pool ${item.pool_size}` : `devices ${item.max_active_devices}`}</td>
            <td>{item.addon_key ?? item.source}{item.reason ? ` / ${item.reason}` : ""}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

export function catalogImportEffectSummary(
  label: string,
  summary: CatalogImportPreviewResponse["effects"]["summary"]["features"],
): string {
  return `${label}: ${summary.create} create, ${summary.update} update, ${summary.disable} disable, ${summary.reenable} reenable, ${summary.unchanged} unchanged`;
}

function catalogImportEffectChanges(effect: CatalogImportEffect): Array<{ field: string; before: unknown; after: unknown }> {
  const before = effect.before ?? {};
  return [...new Set([...Object.keys(before), ...Object.keys(effect.after)])]
    .filter((field) => !["id", "created_at", "updated_at"].includes(field) && before[field] !== effect.after[field])
    .sort()
    .map((field) => ({ field, before: before[field], after: effect.after[field] }));
}

export function CatalogImportRows({ title, effects }: { title: string; effects: CatalogImportEffect[] }): React.ReactElement | null {
  if (effects.length === 0) return null;
  return (
    <section className="deliveriesPane">
      <h3>{title}</h3>
      <table>
        <thead><tr><th>Transition</th><th>Target</th><th>Delta</th></tr></thead>
        <tbody>{effects.map((effect) => {
          const changes = catalogImportEffectChanges(effect);
          const targetFields = catalogImportTargetFields(effect.target);
          return (
            <tr key={JSON.stringify([title, catalogImportTargetKey(effect.target)])}>
              <td>{effect.effect}</td>
              <td><dl aria-label="Catalog import target">{targetFields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd><code>{catalogImportEffectValueLabel(field.value)}</code></dd></div>)}</dl></td>
              <td><details><summary>Before → after ({changes.length})</summary>{changes.length === 0 ? <span className="muted">No mutable field changes</span> : <ul>{changes.map((change) => <li key={change.field}><code>{change.field}</code>: {catalogImportEffectValueLabel(change.before)} → {catalogImportEffectValueLabel(change.after)}</li>)}</ul>}</details></td>
            </tr>
          );
        })}</tbody>
      </table>
    </section>
  );
}

export function CatalogImportConsequenceDetails({ preview }: { preview: CatalogImportPreviewResponse }): React.ReactElement {
  return (
    <div className="catalogImportConsequences">
      <div className="details">
        <span>Server preview {preview.preview_id}</span><span>Server digest {preview.manifest_digest}</span>
        <span>Effective {formatEpoch(preview.effective_at)}</span><span>Expires {formatEpoch(preview.expires_at)}</span>
        <span>{catalogImportEffectSummary("Features", preview.effects.summary.features)}</span>
        <span>{catalogImportEffectSummary("Plans", preview.effects.summary.plans)}</span>
        <span>{catalogImportEffectSummary("Plan rows", preview.effects.summary.plan_features)}</span>
      </div>
      <CatalogImportRows title="Features" effects={preview.effects.features} />
      <CatalogImportRows title="Plans" effects={preview.effects.plans} />
      <CatalogImportRows title="Plan rows" effects={preview.effects.plan_features} />
    </div>
  );
}

export function catalogOverrideSummary(row: CatalogPlanFeature): string {
  const parts = [
    row.assertion_ttl_seconds === null ? "" : `TTL ${row.assertion_ttl_seconds}s`,
    row.pool_size === null ? "" : `pool ${row.pool_size}`,
    row.max_active_devices === null ? "" : `devices ${row.max_active_devices}`,
    row.max_borrow_sec === null ? "" : `borrow ${row.max_borrow_sec}s`,
    row.meter_quota === null ? "" : `meter ${row.meter_quota}`,
    row.meter_period_sec === null ? "" : `period ${row.meter_period_sec}s`,
  ].filter((item) => item !== "");
  return parts.length === 0 ? "-" : parts.join(" / ");
}
