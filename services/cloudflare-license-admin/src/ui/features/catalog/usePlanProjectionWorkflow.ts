import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type {
  PlanProjectionApplyInput,
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionPreviewResponse,
} from "../../../shared/api";
import { useAdminNavigation } from "../../app/navigation";
import { api } from "../../shared/api";
import {
  EXACT_READ_PROOF,
  type ExactReadProof,
  useOperatorControls,
} from "../../shared/controls";
import { type FormFeedback, useFormFeedback } from "../../shared/fieldErrors";
import { codeFeedback, failureFeedback, validationCode } from "../../shared/messages";
import {
  hasPlanProjectionApplyData,
  hasPlanProjectionPreviewEvidence,
  mutationFailurePolicies,
  parseMutationResponse,
} from "../../shared/mutationGuards";
import { PLAN_PROJECTION_FORM, planProjectionFieldForCode } from "./fieldErrors";
import { planProjectionBindingIsUsable } from "./planProjectionBinding";
import {
  emptyPlanProjectionForm,
  normalizePlanProjectionForm,
  planProjectionApplyBody,
  planProjectionApplyPath,
  planProjectionInputDigest,
  planProjectionPreviewPath,
  type PlanProjectionFormState,
} from "./workflow";

export interface PlanProjectionPreviewBinding {
  input: PlanProjectionInput;
  digest: string;
  preview: PlanProjectionPreviewResponse;
}

type PlanProjectionControls = Pick<
  ReturnType<typeof useOperatorControls>,
  "runKeyedMutation" | "runMutation" | "setFeedback" | "requestConfirm" | "modalActive"
>;

interface PlanProjectionWorkflowOptions extends PlanProjectionControls {
  refreshCore: (strict?: boolean, isCurrent?: () => boolean) => Promise<ExactReadProof | null>;
  /** The server applied the current form's preview: the form is no longer an unsaved draft. */
  onApplied: () => void;
}

export interface PlanProjectionWorkflow {
  form: PlanProjectionFormState;
  previewBinding: PlanProjectionPreviewBinding | null;
  preview: PlanProjectionPreviewResponse | PlanProjectionApplyResult | null;
  /** The projection form's inline errors and status line. */
  feedback: FormFeedback;
  invalidate: () => void;
  updateForm: (updater: (current: PlanProjectionFormState) => PlanProjectionFormState) => void;
  submitPreview: (event: FormEvent) => Promise<void>;
  /** Applies the bound preview, warning first when it would disable any entitlement. */
  requestApply: () => void;
}

/** Owns projection form revisioning, preview binding, and keyed apply recovery. */
export function usePlanProjectionWorkflow({
  refreshCore,
  runKeyedMutation,
  runMutation,
  setFeedback,
  requestConfirm,
  modalActive,
  onApplied,
}: PlanProjectionWorkflowOptions): PlanProjectionWorkflow {
  const { routeVersion } = useAdminNavigation();
  const feedback = useFormFeedback(PLAN_PROJECTION_FORM, routeVersion);
  const showCode = (code: string, requestId: string | null = null): void => { feedback.show(code, requestId, planProjectionFieldForCode); };
  const [form, setForm] = useState(emptyPlanProjectionForm);
  const [previewBinding, setPreviewBinding] = useState<PlanProjectionPreviewBinding | null>(null);
  const [applyResult, setApplyResult] = useState<PlanProjectionApplyResult | null>(null);
  const revisionRef = useRef(0);
  // Mirrors `previewBinding` for synchronous reads from the deferred-apply effect below, the same
  // way catalog import's `previewBindingRef` backs its own `bindingIsUsable`.
  const previewBindingRef = useRef<PlanProjectionPreviewBinding | null>(null);
  previewBindingRef.current = previewBinding;

  interface ConfirmedApply {
    binding: PlanProjectionPreviewBinding;
    revision: number;
  }
  // Confirming the disable warning below freezes exactly which preview was confirmed; the actual
  // apply is deferred until the shared modal has fully released the operation gate (`runKeyedMutation`
  // refuses to start while the confirm dialog still owns it), then runs against that frozen binding,
  // exactly as it would have run directly when nothing needed confirming.
  const pendingApplyRef = useRef<ConfirmedApply | null>(null);
  const modalWasActiveRef = useRef(false);
  useEffect(() => {
    // The dialog releases the operation gate in the same commit whose passive effect runs here, and
    // React flushes a discrete event's passive effects before it handles the next discrete event, so
    // no other click can start a catalog mutation or replace the confirmed preview in between. The
    // `planProjectionBindingIsUsable` check below is an invariant kept as a defence, not a race
    // handler: were the confirmed preview ever no longer the one on screen, the apply would be
    // dropped with a message, never duplicated and never sent against it.
    if (modalWasActiveRef.current && !modalActive && pendingApplyRef.current !== null) {
      const confirmed = pendingApplyRef.current;
      pendingApplyRef.current = null;
      if (planProjectionBindingIsUsable(confirmed.binding, confirmed.revision, previewBindingRef.current, revisionRef.current)) {
        void applyFromPreview(confirmed.binding, confirmed.revision);
      } else {
        showCode("plan_projection_preview_required");
      }
    }
    modalWasActiveRef.current = modalActive;
  }, [modalActive]);

  function invalidate(): void {
    revisionRef.current += 1;
    pendingApplyRef.current = null;
    setPreviewBinding(null);
    setApplyResult(null);
  }

  function updateForm(updater: (current: PlanProjectionFormState) => PlanProjectionFormState): void {
    revisionRef.current += 1;
    pendingApplyRef.current = null;
    setForm(updater);
    setPreviewBinding(null);
  }

  async function submitPreview(event: FormEvent): Promise<void> {
    event.preventDefault();
    const revision = revisionRef.current;
    await runMutation(async () => {
      let body: ReturnType<typeof normalizePlanProjectionForm>;
      try {
        body = normalizePlanProjectionForm(form);
      } catch (error) {
        showCode(validationCode(error));
        setPreviewBinding(null);
        setApplyResult(null);
        return;
      }
      let digest: string;
      try {
        digest = await planProjectionInputDigest(body);
      } catch (error) {
        if (revision !== revisionRef.current) return;
        feedback.setStatus(failureFeedback("plan_projection_digest_failed"));
        setPreviewBinding(null);
        setApplyResult(null);
        return;
      }
      if (revision !== revisionRef.current) return;
      feedback.clear();
      setPreviewBinding(null);
      setApplyResult(null);
      const result = await api<PlanProjectionPreviewResponse>(planProjectionPreviewPath(), {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (revision !== revisionRef.current) return;
      const parsed = parseMutationResponse(
        result,
        "license_plan_projection_previewed",
        (value): value is PlanProjectionPreviewResponse => hasPlanProjectionPreviewEvidence(value, body),
        mutationFailurePolicies.catalogProjectionPreview,
        "initial",
      );
      if (parsed.kind === "success") {
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        setPreviewBinding({ input: body, digest, preview: parsed.data });
      } else if (parsed.kind === "failure") {
        showCode(parsed.code, parsed.requestId);
      } else {
        feedback.setStatus(failureFeedback("invalid_mutation_response"));
      }
    });
  }

  async function applyFromPreview(binding: PlanProjectionPreviewBinding, revision: number): Promise<void> {
    if (binding.preview.blocked.length > 0 || !planProjectionBindingIsUsable(binding, revision, previewBindingRef.current, revisionRef.current)) {
      showCode("plan_projection_preview_required");
      return;
    }
    const body: PlanProjectionApplyInput = planProjectionApplyBody(binding.preview.preview_id);
    const requestBody = JSON.stringify(body);
    const isCurrent = (): boolean => planProjectionBindingIsUsable(binding, revision, previewBindingRef.current, revisionRef.current);
    let appliedResult: PlanProjectionApplyResult | null = null;
    await runKeyedMutation<PlanProjectionApplyResult>({
      request: { method: "POST", path: planProjectionApplyPath(), body: requestBody },
      send: (attempt) => api<PlanProjectionApplyResult>(attempt.path, {
        method: attempt.method,
        headers: { "idempotency-key": attempt.idempotencyKey },
        body: attempt.body,
      }),
      parse: (result, phase) => parseMutationResponse(
        result,
        "license_plan_projection_applied",
        (value): value is PlanProjectionApplyResult => {
          if (!hasPlanProjectionApplyData(value) || !hasPlanProjectionPreviewEvidence(value, binding.input)) {
            return false;
          }
          return (value as PlanProjectionApplyResult).preview_id === binding.preview.preview_id;
        },
        mutationFailurePolicies.catalogProjectionApply,
        phase,
      ),
      onUnapplied: (parsed) => {
        if (!isCurrent()) return;
        if ([
          "stale_projection_preview",
          "projection_preview_grant_expired",
          "license_fingerprint_conflict",
          "plan_projection_blocked",
        ].includes(parsed.code)) invalidate();
        // Each of those codes says to preview again; every refusal shows in the projection form.
        showCode(parsed.code, parsed.requestId);
      },
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        appliedResult = parsed.data;
        // A still-current binding proves the form is exactly what the server applied.
        onApplied();
      },
      refresh: async (): Promise<ExactReadProof | null> => {
        // A retained replay may settle after the editor has been hidden. The
        // current core readers still require their own committed fenced GETs;
        // an old form revision must not make GET-only recovery impossible.
        const proof = await refreshCore(true);
        if (proof !== EXACT_READ_PROOF) return null;
        if (isCurrent() && appliedResult !== null) {
          invalidate();
          setApplyResult(appliedResult);
        }
        return EXACT_READ_PROOF;
      },
      isCurrent,
    });
  }

  function requestApply(): void {
    const binding = previewBinding;
    if (binding === null) {
      showCode("plan_projection_preview_required");
      return;
    }
    const revision = revisionRef.current;
    const disableCount = binding.preview.summary.disable;
    if (disableCount === 0) {
      void applyFromPreview(binding, revision);
      return;
    }
    requestConfirm({
      title: "Apply plan projection",
      body: `This will disable ${disableCount} entitlement${disableCount === 1 ? "" : "s"}.`,
      requiresReason: false,
      confirmLabel: "Apply",
      run: async () => {
        pendingApplyRef.current = { binding, revision };
        return { ok: true };
      },
      isCurrent: () => planProjectionBindingIsUsable(binding, revision, previewBindingRef.current, revisionRef.current),
    });
  }

  return {
    form,
    previewBinding,
    preview: previewBinding?.preview ?? applyResult,
    feedback,
    invalidate,
    updateForm,
    submitPreview,
    requestApply,
  };
}
