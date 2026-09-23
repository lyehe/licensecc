import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type { EntitlementRecord, Policy } from "../../../shared/api";
import { ReadNotice } from "../../shared/ReadNotice";
import { EntitlementRelationships } from "./EntitlementRelationships";
import { entitlementFormErrors, type EntitlementEditState, type EntitlementFormState } from "./workflow";

interface EditorProps {
  form: EntitlementFormState | EntitlementEditState;
  item?: EntitlementRecord;
  extendValidity?: boolean;
  busy: boolean;
  locked: boolean;
  lockMessage?: string;
  policies: Policy[];
  policiesReady: boolean;
  policiesError: string | null;
  onRetryPolicies: () => void;
  onChange: (patch: Partial<EntitlementFormState>) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  onCancel: () => void;
}

export function EntitlementEditor({ form, item, extendValidity = false, busy, locked, lockMessage, policies, policiesReady, policiesError, onRetryPolicies, onChange, onSubmit, onCancel }: EditorProps): React.ReactElement {
  const editorRef = useRef<HTMLElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const isCreate = "license_fingerprint" in form;
  const title = isCreate ? "New entitlement" : "Edit entitlement";
  const inheritsDates = isCreate && form.policy_id !== "";
  useEffect(() => {
    editorRef.current?.querySelector<HTMLElement>(extendValidity ? '[name="valid_until"]' : "h3")?.focus();
  }, [extendValidity, item?.id]);

  function submit(event: FormEvent): void {
    const next = entitlementFormErrors(form, item);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      event.preventDefault();
      const input = editorRef.current?.querySelector<HTMLElement>(`[name="${Object.keys(next)[0]}"]`);
      const disclosure = input?.closest("details");
      if (disclosure) disclosure.open = true;
      input?.focus();
      return;
    }
    void onSubmit(event);
  }

  function change(field: keyof EntitlementFormState, value: string | number): void {
    setErrors((previous) => { const next = { ...previous }; delete next[field]; return next; });
    onChange(isCreate && field === "project" ? { project: String(value), license_id: "", policy_id: "" } : { [field]: value });
  }

  const errorFor = (field: string): React.ReactElement | null => errors[field] ? <span id={`entitlement-${field}-error`} role="alert">{errors[field]}</span> : null;
  const describedBy = (field: string): string | undefined => errors[field] ? `entitlement-${field}-error` : undefined;
  return <section ref={editorRef} className="editorLayout" aria-label={title}>
    <div className="editorHeader"><div><h3 tabIndex={-1}>{title}</h3><p>{isCreate ? "Grant access to a project and feature." : `${item?.project} / ${item?.feature}`}</p></div><button type="button" disabled={busy} onClick={onCancel}>Back to entitlements</button></div>
    {locked && <p className="readState">{lockMessage ?? "Resolve the pending operation before changing this draft."}</p>}
    <form aria-label={title} noValidate onSubmit={submit}><fieldset disabled={locked}>
      <legend className="srOnly">Entitlement details</legend>
      {isCreate && <>
        <label className="wide">Protection<select aria-label="Protection" name="enforcement_mode" value={form.enforcement_mode} onChange={(event) => change("enforcement_mode", event.target.value)}><option value="legacy">Legacy application</option><option value="device_bound_v1">Protected devices</option></select><span className="muted">{form.enforcement_mode === "device_bound_v1" ? "Requires a customer, license, and an application using protected device enrollment. Each enrolled device occupies a slot." : "For existing applications using the legacy licensing protocol."} Protection cannot be changed after creation.</span>{errorFor("enforcement_mode")}</label>
        <label>Project (required)<input aria-label="Project" name="project" required aria-invalid={!!errors.project} aria-describedby={describedBy("project")} value={form.project} onChange={(event) => change("project", event.target.value)} />{errorFor("project")}</label>
        <label>Feature (required)<input aria-label="Feature" name="feature" required aria-invalid={!!errors.feature} aria-describedby={describedBy("feature")} value={form.feature} onChange={(event) => change("feature", event.target.value)} />{errorFor("feature")}</label>
        <label className="wide">License fingerprint (required)<input aria-label="License fingerprint" name="license_fingerprint" required aria-invalid={!!errors.license_fingerprint} aria-describedby={describedBy("license_fingerprint")} value={form.license_fingerprint} onChange={(event) => change("license_fingerprint", event.target.value)} />{errorFor("license_fingerprint")}<span className="muted">The full 64-character hexadecimal fingerprint.</span></label>
        <div className="wide"><ReadNotice loading={!policiesReady && policiesError === null} error={policiesError} hasData={policies.length > 0} label="active policies" onRetry={onRetryPolicies} /><label>Policy (optional)<select aria-label="Policy (optional)" disabled={!policiesReady} value={form.policy_id} onChange={(event) => change("policy_id", event.target.value)}><option value="">No policy · use fields below</option>{policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} ({policy.type}) · {policy.id}</option>)}</select></label>{inheritsDates && <p className="muted">Blank validity dates inherit this policy’s defaults. The default assertion TTL value also inherits the policy lifetime.</p>}</div>
      </>}
      {!isCreate && <p className="wide muted">Project, feature, and fingerprint identify this entitlement and cannot be edited. {extendValidity ? "Update Valid until to extend access." : "Save changes updates the existing entitlement."}</p>}
      <label>Valid from<input aria-label="Valid from" name="valid_from" type="date" min="1970-01-01" value={form.valid_from} aria-invalid={!!errors.valid_from} aria-describedby={`entitlement-date-rules${errors.valid_from ? " entitlement-valid_from-error" : ""}`} onChange={(event) => change("valid_from", event.target.value)} /><span className="muted">{inheritsDates ? "Blank: use policy start." : "Blank: Starts immediately."}</span>{errorFor("valid_from")}</label>
      <label>Valid until<input aria-label="Valid until" name="valid_until" type="date" min="1970-01-01" value={form.valid_until} aria-invalid={!!errors.valid_until} aria-describedby={`entitlement-date-rules${errors.valid_until ? " entitlement-valid_until-error" : ""}`} onChange={(event) => change("valid_until", event.target.value)} /><span className="muted">{inheritsDates ? "Blank: use policy expiry." : "Blank: No expiry."}</span>{errorFor("valid_until")}</label>
      <p id="entitlement-date-rules" className="wide muted">Dates are UTC. Expiry is at the start of the selected day; choose the following date to include a whole day. Untouched timestamps stay unchanged.</p>
      {item && <p className="wide muted">Stored start: {item.valid_from === null ? "Starts immediately" : new Date(item.valid_from * 1000).toISOString()}. Stored expiry: {item.valid_until === null ? "No expiry" : new Date(item.valid_until * 1000).toISOString()}.</p>}
      <EntitlementRelationships required={isCreate && form.enforcement_mode === "device_bound_v1"} customerId={form.customer_id} licenseId={form.license_id} onCustomerChange={(value) => { change("customer_id", value); if (isCreate) change("license_id", ""); }} onLicenseChange={(value) => change("license_id", value)} />
      {!isCreate && <p className="wide muted">Protection: {item?.enforcement_mode === "device_bound_v1" ? "Protected devices" : item?.enforcement_mode === "legacy" ? "Legacy application" : "Unknown — refresh the entitlement to confirm."}</p>}
      {(errors.customer_id || errors.license_id) && <p className="wide" role="alert">{errors.customer_id || errors.license_id}</p>}
      <label className="wide">Notes<textarea aria-label="Notes" name="notes" maxLength={1000} value={form.notes} aria-invalid={!!errors.notes} aria-describedby={describedBy("notes")} onChange={(event) => change("notes", event.target.value)} />{errorFor("notes")}</label>
      <details><summary>Advanced settings</summary><div className="summaryCards">
        <label>Device hash<input aria-label="Device hash" name="device_hash" value={form.device_hash} aria-invalid={!!errors.device_hash} aria-describedby={describedBy("device_hash")} onChange={(event) => change("device_hash", event.target.value)} /><span className="muted">Optional 64-character hexadecimal device restriction.</span>{errorFor("device_hash")}</label>
        <label>Assertion TTL (seconds)<input aria-label="Assertion TTL (seconds)" name="assertion_ttl_seconds" type="number" min={1} max={3600} step={1} value={form.assertion_ttl_seconds} aria-invalid={!!errors.assertion_ttl_seconds} aria-describedby={`entitlement-ttl-help${errors.assertion_ttl_seconds ? " entitlement-assertion_ttl_seconds-error" : ""}`} onChange={(event) => change("assertion_ttl_seconds", Number(event.target.value))} />{errorFor("assertion_ttl_seconds")}</label>
        <p id="entitlement-ttl-help" className="wide muted">Signed assertion lifetime: 1–3600 seconds. Entitlement expiration is controlled by Valid until.{inheritsDates ? " The default value of 300 uses the selected policy’s TTL." : ""}</p>
      </div></details>
      <div className="editorActions"><button className="primary" disabled={busy} type="submit">{isCreate ? "Create entitlement" : "Save changes"}</button><button disabled={busy} type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset></form>
  </section>;
}
