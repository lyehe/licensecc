import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type { EntitlementRecord, Policy } from "../../../shared/api";
import { MAX_DEVICE_LIMIT } from "../../../shared/api";
import { formatUtcDate } from "../../shared/format";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { ReadNotice } from "../../shared/ReadNotice";
import { DeviceLimitForm } from "./DeviceLimitForm";
import { EntitlementRelationships } from "./EntitlementRelationships";
import { generateLicenseFingerprint, isProtectedProject } from "./protectedCreate";
import { DEVICE_LIMIT_RULE, entitlementFormErrors, policiesForProject, policyOptionLabel, type EntitlementEditState, type EntitlementFormState } from "./workflow";

interface EditorProps {
  form: EntitlementFormState | EntitlementEditState;
  item?: EntitlementRecord;
  extendValidity?: boolean;
  busy: boolean;
  locked: boolean;
  lockMessage?: string;
  policies: Policy[];
  policiesReady: boolean;
  policiesError: OperatorFeedback | null;
  onRetryPolicies: () => void;
  /** Park this draft and open the policy form for its project; the new policy comes back chosen. */
  onCreatePolicy?: () => void;
  onChange: (patch: Partial<EntitlementFormState>) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  onCancel: () => void;
}

export function EntitlementEditor({ form, item, extendValidity = false, busy, locked, lockMessage, policies, policiesReady, policiesError, onRetryPolicies, onCreatePolicy, onChange, onSubmit, onCancel }: EditorProps): React.ReactElement {
  const editorRef = useRef<HTMLElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const isCreate = "license_fingerprint" in form;
  const title = isCreate ? "New entitlement" : "Edit entitlement";
  const inheritsDates = isCreate && form.policy_id !== "";
  const protectedCreate = isCreate;
  // Only this project's policies can stamp its grant; the chosen one owns the device limit.
  const projectPolicies = isCreate ? policiesForProject(policies, form.project) : [];
  const chosenPolicy = isCreate ? projectPolicies.find((policy) => policy.id === form.policy_id) : undefined;
  useEffect(() => {
    editorRef.current?.querySelector<HTMLElement>(extendValidity ? '[name="valid_until"]' : "h3")?.focus();
  }, [extendValidity, item?.id]);

  function submit(event: FormEvent): void {
    const next = entitlementFormErrors(form, item);
    // A device limit the number field could not read (such as "5e") reads as blank, which would
    // quietly create the default limit; it is refused beside the field instead. The field is read
    // now, since clearing such text changes no value and so fires no change event.
    const limitInput = (event.currentTarget as HTMLFormElement).elements.namedItem("max_active_devices");
    if (isCreate && !inheritsDates && limitInput instanceof HTMLInputElement && limitInput.validity.badInput) next.max_active_devices = DEVICE_LIMIT_RULE;
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
  // A chosen policy owns the device limit.
  const policyLimitLabel = `Device limit (from policy ${chosenPolicy?.name ?? (isCreate ? form.policy_id : "")})`;
  return <section ref={editorRef} className="editorLayout" aria-label={title}>
    <div className="editorHeader"><div><h3 tabIndex={-1}>{title}</h3><p>{isCreate ? "Grant access to a project and feature." : `${item?.project} / ${item?.feature}`}</p></div><button type="button" disabled={busy} onClick={onCancel}>Back to entitlements</button></div>
    {locked && <p className="readState">{lockMessage ?? "Resolve the notice at the bottom of the page before changing this draft."}</p>}
    <form aria-label={title} noValidate onSubmit={submit}><fieldset disabled={locked}>
      <legend className="srOnly">Entitlement details</legend>
      {isCreate && <>
        <p className="wide muted">Protection: Protected devices. Requires a customer, license, and an application using protected device enrollment; each enrolled device occupies a slot.</p>
        <label>Project (required)<input aria-label="Project" name="project" required aria-invalid={!!errors.project} aria-describedby={describedBy("project")} value={form.project} onChange={(event) => change("project", event.target.value)} />{errorFor("project")}</label>
        <label>Feature (required)<input aria-label="Feature" name="feature" required aria-invalid={!!errors.feature} aria-describedby={describedBy("feature")} value={form.feature} onChange={(event) => change("feature", event.target.value)} />{errorFor("feature")}</label>
        <label className="wide">License fingerprint (required)<input aria-label="License fingerprint" name="license_fingerprint" required aria-invalid={!!errors.license_fingerprint} aria-describedby={describedBy("license_fingerprint")} value={form.license_fingerprint} onChange={(event) => change("license_fingerprint", event.target.value)} />{errorFor("license_fingerprint")}<span className="muted">{protectedCreate ? "The exact 64-character lowercase hexadecimal fingerprint. A new protected license can use a generated one." : "The full 64-character hexadecimal fingerprint."}</span></label>
        {protectedCreate && <div className="wide"><button type="button" onClick={() => change("license_fingerprint", generateLicenseFingerprint())}>Generate fingerprint</button></div>}
        <div className="wide"><ReadNotice loading={!policiesReady && policiesError === null} error={policiesError} hasData={policies.length > 0} label="active policies" onRetry={onRetryPolicies} /><label>Policy (optional)<select aria-label="Policy (optional)" disabled={!policiesReady} value={form.policy_id} onChange={(event) => change("policy_id", event.target.value)}><option value="">No policy · use fields below</option>{projectPolicies.map((policy) => <option key={policy.id} value={policy.id}>{policyOptionLabel(policy)}</option>)}</select></label>{onCreatePolicy && !locked && !busy && <p><a href="#/policies" onClick={(event) => { event.preventDefault(); onCreatePolicy(); }}>Create policy…</a> <span className="muted">Opens the policy form for {form.project || "this project"}; this draft is kept and gets the new policy.</span></p>}{inheritsDates && <p className="muted">Blank validity dates inherit this policy’s defaults.</p>}</div>
        {inheritsDates
          ? <label>{policyLimitLabel}<input aria-label={policyLimitLabel} name="max_active_devices" readOnly value={chosenPolicy?.max_active_devices ?? ""} /><span className="muted">The policy sets the device limit.</span></label>
          : <label>Device limit<input aria-label="Device limit" name="max_active_devices" type="number" min={1} max={MAX_DEVICE_LIMIT} step={1} placeholder="1" value={form.max_active_devices} aria-invalid={!!errors.max_active_devices} aria-describedby={describedBy("max_active_devices")} onChange={(event) => change("max_active_devices", event.target.value === "" ? "" : Number(event.target.value))} />{errorFor("max_active_devices")}<span className="muted">Blank: a new license (entitlement) gets 1; an existing one keeps its limit.</span></label>}
      </>}
      {!isCreate && <p className="wide muted">Project, feature, and fingerprint identify this entitlement and cannot be edited. {extendValidity ? "Update Valid until to extend access." : "Save changes updates the existing entitlement."}</p>}
      <label>Valid from<input aria-label="Valid from" name="valid_from" type="date" min="1970-01-01" value={form.valid_from} aria-invalid={!!errors.valid_from} aria-describedby={`entitlement-date-rules${errors.valid_from ? " entitlement-valid_from-error" : ""}`} onChange={(event) => change("valid_from", event.target.value)} /><span className="muted">{inheritsDates ? "Blank: use policy start." : "Blank: Starts immediately."}</span>{errorFor("valid_from")}</label>
      <label>Valid until<input aria-label="Valid until" name="valid_until" type="date" min="1970-01-01" value={form.valid_until} aria-invalid={!!errors.valid_until} aria-describedby={`entitlement-date-rules${errors.valid_until ? " entitlement-valid_until-error" : ""}`} onChange={(event) => change("valid_until", event.target.value)} /><span className="muted">{inheritsDates ? "Blank: use policy expiry." : "Blank: No expiry."}</span>{errorFor("valid_until")}</label>
      <p id="entitlement-date-rules" className="wide muted">Dates are UTC. Expiry is at the start of the selected day; choose the following date to include a whole day. Untouched timestamps stay unchanged.</p>
      {item && <p className="wide muted">Stored start: {item.valid_from === null ? "Starts immediately" : formatUtcDate(item.valid_from)}. Stored expiry: {item.valid_until === null ? "No expiry" : formatUtcDate(item.valid_until)}.</p>}
      <EntitlementRelationships required={protectedCreate} protectedProject={protectedCreate && isProtectedProject(form.project) ? form.project : ""} customerId={form.customer_id} licenseId={form.license_id} onCustomerChange={(value) => { change("customer_id", value); if (isCreate) change("license_id", ""); }} onLicenseChange={(value) => change("license_id", value)} />
      {!isCreate && <p className="wide muted">Protection: Protected devices</p>}
      {(errors.customer_id || errors.license_id) && <p className="wide" role="alert">{errors.customer_id || errors.license_id}</p>}
      <label className="wide">Notes<textarea aria-label="Notes" name="notes" maxLength={1000} value={form.notes} aria-invalid={!!errors.notes} aria-describedby={describedBy("notes")} onChange={(event) => change("notes", event.target.value)} />{errorFor("notes")}</label>
      <div className="editorActions"><button className="primary" disabled={busy} type="submit">{isCreate ? "Create entitlement" : "Save changes"}</button><button disabled={busy} type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset></form>
    {!isCreate && item && <DeviceLimitForm item={item} locked={locked} />}
  </section>;
}
