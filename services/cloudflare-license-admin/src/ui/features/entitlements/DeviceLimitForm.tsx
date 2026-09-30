import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type { EntitlementRecord } from "../../../shared/api";
import { MAX_DEVICE_LIMIT } from "../../../shared/api";
import { useNavigationGuard } from "../../app/navigation";
import { api } from "../../shared/api";
import { EXACT_READ_PROOF, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { failureFeedback, feedbackWith } from "../../shared/messages";
import { hasEntitlementRecordData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { deviceLimitError, deviceLimitFailureMessage, deviceLimitRequestBody } from "./deviceLimit";
import { DEVICE_LIMIT_RULE, ENTITLEMENT_NOT_RELOADED_AFTER_STALE, patchPath } from "./workflow";

/**
 * An existing license (entitlement)'s device limit, saved on its own: the Worker writes it through
 * the capacity path, separately from the entitlement's other fields. A protected grant refuses a
 * limit below its connected devices, and the refusal says how many to disconnect first.
 */
export function DeviceLimitForm({ item, locked }: { item: EntitlementRecord; locked: boolean }): React.ReactElement {
  const { busy, operationLocked, operationRetained, runKeyedMutation, setFeedback, setMessage } = useOperatorControls();
  const { refreshCore } = useCoreRefresh();
  const [draft, setDraft] = useState(item.max_active_devices);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // An untouched field follows the stored limit as the list refreshes; a typed one is a draft.
  const shown = useRef(item.max_active_devices);
  useEffect(() => {
    setDraft((current) => current === shown.current ? item.max_active_devices : current);
    shown.current = item.max_active_devices;
  }, [item.max_active_devices]);
  // Guard on the retained flag, not the visible lock: a dismissible notice locks the fieldset but
  // must not silence an unsaved-change prompt (matches the Entitlements/Catalog guards).
  useNavigationGuard({ when: !operationRetained && draft !== item.max_active_devices, onDiscard: () => setDraft(item.max_active_devices) });

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    // Text the number field could not read (such as "5e" or "-") reads as blank to the page; it is
    // refused beside the field rather than saved as some other number. The field is read now, since
    // clearing such text changes no value and so fires no change event.
    const input = (event.currentTarget as HTMLFormElement).elements.namedItem("max_active_devices");
    const invalid = input instanceof HTMLInputElement && input.validity.badInput ? DEVICE_LIMIT_RULE : deviceLimitError(draft);
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
      onApplied: (result) => { if (mounted.current) setFeedback(feedbackWith(`Device limit set to ${limit}.`, result.code, result.requestId, "success")); },
      refresh: async () => await refreshCore(true),
      onUnapplied: (result) => {
        const sentence = deviceLimitFailureMessage(result, limit);
        if (result.code !== "stale_transition") {
          setFeedback(sentence === null ? failureFeedback(result.code, result.requestId) : feedbackWith(sentence, result.code, result.requestId));
          return;
        }
        // A stale expectation wrote nothing; reload so the next save carries the current state, and
        // say it was reloaded only once it was.
        const settle = (reloaded: boolean): void => { if (mounted.current) setFeedback(feedbackWith(reloaded && sentence !== null ? sentence : ENTITLEMENT_NOT_RELOADED_AFTER_STALE, result.code, result.requestId)); };
        void refreshCore().then((proof) => settle(proof === EXACT_READ_PROOF), () => settle(false));
      },
      isCurrent: () => mounted.current,
    });
  }

  return <form className="wide" aria-label="Device limit" noValidate onSubmit={(event) => void save(event)}><fieldset disabled={locked}>
    <label>Device limit<input aria-label="Device limit" name="max_active_devices" type="number" min={1} max={MAX_DEVICE_LIMIT} step={1} value={draft}
      aria-invalid={error !== null} aria-describedby={`device-limit-help${error === null ? "" : " device-limit-error"}`}
      onChange={(event) => { setError(null); setDraft(Number(event.target.value)); }} /></label>
    {error !== null && <span id="device-limit-error" role="alert">{error}</span>}
    <p id="device-limit-help" className="muted">The most devices this license (entitlement) can have connected at once. It is saved on its own and can't drop below the devices already connected.</p>
    <button type="submit" disabled={busy || operationLocked}>Save device limit</button>
  </fieldset></form>;
}
