import React, { useEffect, useRef } from "react";
import type { CreatedLicense } from "../../../shared/api";
import { api, parseExactApiSuccess } from "../../shared/api";
import { EXACT_READ_PROOF, useOperatorControls } from "../../shared/controls";
import { feedbackWith } from "../../shared/messages";
import { hasLicenseListData, parseMutationResponse } from "../../shared/mutationGuards";
import { createLicensePath, hasCreatedLicenseData, licenseCreateFailureMessage, licenseCreateFailures } from "./protectedCreate";

/**
 * Offered when a protected grant's customer holds no license for its project. Creation uses the
 * keyed-mutation lifecycle, so a lost response reconciles under the same key instead of creating a
 * second license; a strict read proves the record before its id is handed to the form.
 */
export function CreateLicenseButton({ customerId, project, onCreated }: { customerId: string; project: string; onCreated: (id: string) => void }): React.ReactElement {
  const { busy, operationLocked, runKeyedMutation, setFeedback, setMessage } = useOperatorControls();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function create(): Promise<void> {
    let created: CreatedLicense | null = null;
    await runKeyedMutation<CreatedLicense>({
      request: { method: "POST", path: createLicensePath(customerId), body: JSON.stringify({ project }) },
      send: (attempt) => api(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (value, phase) => parseMutationResponse(value, "license_created", (data): data is CreatedLicense => hasCreatedLicenseData(data, customerId, project), licenseCreateFailures, phase),
      onApplied: (result) => { created = result.data; },
      refresh: async () => {
        const license = created;
        if (license === null) return null;
        const response = await api(`/api/admin/licenses?${new URLSearchParams({ customer_id: customerId, q: license.id })}`);
        const listed = parseExactApiSuccess<{ items: Array<{ id: string }> }>(response, "licenses_listed", hasLicenseListData);
        if (listed === null || !listed.data.items.some((item) => item.id === license.id)) return null;
        onCreated(license.id);
        setMessage(`Created a license for ${project} and selected it.`);
        return EXACT_READ_PROOF;
      },
      onUnapplied: (result) => setFeedback(feedbackWith(licenseCreateFailureMessage(result), result.code, result.requestId)),
      isCurrent: () => mounted.current,
    });
  }

  return <button type="button" disabled={busy || operationLocked} onClick={() => void create()}>Create license for {project}</button>;
}
