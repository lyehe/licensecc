import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type { EntitlementRecord } from "../../../shared/api";
import { MAX_DEVICE_LIMIT } from "../../../shared/api";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { hasEntitlementRecordData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { deviceLimitError, deviceLimitFailureMessage, deviceLimitRequestBody } from "./deviceLimit";
import { patchPath } from "./workflow";

/**
 * An existing license (entitlement)'s device limit, saved on its own: the Worker writes it through
 * the capacity path, separately from the entitlement's other fields. A protected grant refuses a
 * limit below its connected devices, and the refusal says how many to disconnect first.
 */
export function DeviceLimitForm({ item, locked }: { item: EntitlementRecord; locked: boolean }): React.ReactElement {
  const { busy, operationLocked, runKeyedMutation, setFeedback, setMessage } = useOperatorControls();
  const { refreshCore } = useCoreRefresh();
  const [draft, setDraft] = useState(item.max_active_devices);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const invalid = deviceLimitError(draft);
    setError(invalid);
    if (invalid !== null) return;
    if (draft === item.max_active_devices) {
      setMessage(`The device limit is already ${draft}.`);
      return;
    }
    const limit = draft;
    await runKeyedMutation<EntitlementRecord>({
      request: { method: "PATCH", path: patchPath(item), body: deviceLimitRequestBody(item, limit) },
      send: (attempt) => api(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (value, phase) => parseMutationResponse(value, "entitlement_patched", (data): data is EntitlementRecord => {
        if (!hasEntitlementRecordData(data)) return false;
        const row = data as EntitlementRecord;
        return row.id === item.id && row.max_active_devices === limit && row.revocation_seq > item.revocation_seq;
      }, mutationFailurePolicies.entitlementPatch, phase),
      onApplied: (result) => { if (mounted.current) setMessage(`Device limit set to ${limit}. Reference ${result.requestId}.`); },
      refresh: async () => await refreshCore(true),
      onUnapplied: (result) => setFeedback({ tone: "error", message: deviceLimitFailureMessage(result, limit) ?? `${result.code} (${result.requestId})` }),
      isCurrent: () => mounted.current,
    });
  }

  const protectedGrant = item.enforcement_mode === "device_bound_v1";
  return <form className="wide" aria-label="Device limit" noValidate onSubmit={(event) => void save(event)}><fieldset disabled={locked}>
    <label>Device limit<input aria-label="Device limit" name="max_active_devices" type="number" min={1} max={MAX_DEVICE_LIMIT} step={1} value={draft}
      aria-invalid={error !== null} aria-describedby={`device-limit-help${error === null ? "" : " device-limit-error"}`}
      onChange={(event) => { setError(null); setDraft(Number(event.target.value)); }} /></label>
    {error !== null && <span id="device-limit-error" role="alert">{error}</span>}
    <p id="device-limit-help" className="muted">The most devices this license (entitlement) can have connected at once. It is saved on its own{protectedGrant ? " and can't drop below the devices already connected" : ""}.</p>
    <button type="submit" disabled={busy || operationLocked}>Save device limit</button>
  </fieldset></form>;
}
