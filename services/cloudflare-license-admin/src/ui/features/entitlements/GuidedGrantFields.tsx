import React, { useEffect, useState } from "react";
import type { CatalogFeature } from "../../../shared/api";
import { ProjectPicker } from "../catalog/ProjectPicker";
import { loadAllExactPages } from "../../shared/pagination";
import { hasCatalogFeatureListData, hasLicenseListData } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import type { EntitlementFormState } from "./workflow";
import { FeedbackText } from "../../shared/FeedbackText";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import type { GrantCustomer } from "../../app/types";

export type GrantChoice = { context: string; ready: boolean; createNew: boolean };
type License = { id: string; project: string; customer_id: string; label: string | null };
export function GuidedGrantFields({ customer, form, onChange, onAutoLicense, onChoice }: {
  customer: GrantCustomer; form: EntitlementFormState; onChange(patch: Partial<EntitlementFormState>): void;
  onAutoLicense(id: string): void; onChoice(choice: GrantChoice): void;
}): React.ReactElement {
  const [licenses, setLicenses] = useState<License[]>([]), [features, setFeatures] = useState<CatalogFeature[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState<OperatorFeedback | null>(null), [revision, setRevision] = useState(0);
  const [newLicense, setNewLicense] = useState(false);
  const context = `${form.customer_id}\0${form.project}`;
  const path = `/api/admin/licenses?${new URLSearchParams({customer_id:form.customer_id})}`;
  const fence = useRequestFence(context);
  const featurePath = `/api/admin/catalog/features?${new URLSearchParams({project:form.project,status:"active"})}`;
  const featureFence = useRequestFence(featurePath);
  useEffect(()=>{
    let current=true; setReady(false);setError(null);setLicenses([]);setNewLicense(false);
    void loadAllExactPages<License>(path,"licenses_listed",value=>hasLicenseListData(value) && (value as {items:License[]}).items.every(item=>item.customer_id===form.customer_id),fence,item=>item.id,()=>current).then(result=>{
      if(!current || result.kind==='stale')return;
      if(result.kind==='failure'){setError(result.feedback);return;}
      const eligible=result.items.filter(item=>item.project===form.project);setLicenses(eligible);setReady(true);
      if(eligible.length===0)setNewLicense(true);
    });
    return()=>{current=false;};
  },[context,path,fence,revision,form.customer_id,form.project]);
  useEffect(()=>{
    let current=true;setFeatures([]);
    if(form.project)void loadAllExactPages<CatalogFeature>(featurePath,"features_listed",hasCatalogFeatureListData,featureFence,item=>item.id,()=>current).then(result=>{
      if(current && result.kind==='success')setFeatures(result.items.filter(item=>item.project===form.project && item.status==='active'));
    });
    return()=>{current=false;};
  },[featurePath,featureFence,form.project]);
  useEffect(()=>{
    if(ready && fence.canLoadMore() && !form.license_id && !newLicense && licenses.length===1)onAutoLicense(licenses[0]!.id);
  },[ready,fence,form.license_id,newLicense,licenses,onAutoLicense]);
  useEffect(()=>{onChoice({context,ready:ready && fence.canLoadMore() && form.project!=="",createNew:newLicense});},[context,ready,fence,newLicense,form.project,onChoice]);
  return <div className="wide">
    <div><p>Grant access to <strong>{customer.name || customer.email || customer.id}</strong>.</p>{customer.email && <p>{customer.email}</p>}<p className="muted">Customer ID: <span className="identifier">{customer.id}</span></p></div>
    <p>Choose the app and feature to grant.</p>
    <label>App (required)<input aria-label="App" name="project" value={form.project} onChange={event=>onChange({project:event.target.value,license_id:"",policy_id:""})} /></label>
    <ProjectPicker onSelect={project=>onChange({project,license_id:"",policy_id:""})} />
    <label>Feature (required)<input aria-label="Feature" name="feature" list="grant-feature-options" value={form.feature} onChange={event=>onChange({feature:event.target.value})} /></label>
    <datalist id="grant-feature-options">{features.map(feature=><option key={feature.id} value={feature.feature_key}>{feature.name}</option>)}</datalist>
    <p className="muted">Browse existing apps or enter valid app and feature IDs directly. Catalog setup is optional.</p>
    {error && <p role="alert"><FeedbackText feedback={error} /> <button type="button" onClick={()=>setRevision(value=>value+1)}>Retry licenses</button></p>}
    {!ready && !error && <p role="status">Checking this customer's licenses…</p>}
    {ready && <><label>License<select aria-label="License" value={newLicense && !form.license_id?"new":form.license_id} onChange={event=>{setNewLicense(event.target.value==="new");onChange({license_id:event.target.value==="new"?"":event.target.value});}}>
      <option value="">Choose a license</option>{form.license_id && !licenses.some(item=>item.id===form.license_id) && <option value={form.license_id}>Selected license · {form.license_id}</option>}
      {licenses.map(item=><option key={item.id} value={item.id}>{item.label || item.project} · {item.id}</option>)}<option value="new">Create a new license on save</option>
    </select></label>{newLicense && !form.license_id && <p>A license record will be created when you save. No records are created while you fill this form.</p>}</>}
  </div>;
}
