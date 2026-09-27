import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type {
  PlanProjectionApplyInput,
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionPreviewResponse,
} from "../../../shared/api";
import { api } from "../../shared/api";
import {
  EXACT_READ_PROOF,
  type ExactReadProof,
  useOperatorControls,
} from "../../shared/controls";
import {
  hasPlanProjectionApplyData,
  hasPlanProjectionPreviewEvidence,
  mutationFailurePolicies,
  parseMutationResponse,
} from "../../shared/mutationGuards";
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
  "runKeyedMutation" | "runMutation" | "setMessage" | "requestConfirm" | "modalActive"
>;

interface PlanProjectionWorkflowOptions extends PlanProjectionControls {
  refreshCore: (strict?: boolean, isCurrent?: () => boolean) => Promise<ExactReadProof | null>;
}

export interface PlanProjectionWorkflow {
  form: PlanProjectionFormState;
  previewBinding: PlanProjectionPreviewBinding | null;
  preview: PlanProjectionPreviewResponse | PlanProjectionApplyResult | null;
  invalidate: () => void;
  updateForm: (updater: (current: PlanProjectionFormState) => PlanProjectionFormState) => void;
  submitPreview: (event: FormEvent) => Promise<void>;
  /** Applies the bound preview, warning first when it would disable any grant. */
  requestApply: () => void;
}

/** Owns projection form revisioning, preview binding, and keyed apply recovery. */
export function usePlanProjectionWorkflow({
  refreshCore,
  runKeyedMutation,
  runMutation,
  setMessage,
  requestConfirm,
  modalActive,
}: PlanProjectionWorkflowOptions): PlanProjectionWorkflow {
  const [form, setForm] = useState(emptyPlanProjectionForm);
  const [previewBinding, setPreviewBinding] = useState<PlanProjectionPreviewBinding | null>(null);
  const [applyResult, setApplyResult] = useState<PlanProjectionApplyResult | null>(null);
  const revisionRef = useRef(0);
  // Confirming the disable warning below only closes that dialog; the actual apply is deferred
  // until the shared modal has fully released the operation gate, then run exactly as it is when
  // nothing needs confirming.
  const pendingApplyRef = useRef(false);
  const modalWasActiveRef = useRef(false);
  useEffect(() => {
    if (modalWasActiveRef.current && !modalActive && pendingApplyRef.current) {
      pendingApplyRef.current = false;
      void applyFromPreview();
    }
    modalWasActiveRef.current = modalActive;
  }, [modalActive]);

  function invalidate(): void {
    revisionRef.current += 1;
    setPreviewBinding(null);
    setApplyResult(null);
  }

  function updateForm(updater: (current: PlanProjectionFormState) => PlanProjectionFormState): void {
    revisionRef.current += 1;
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
        setMessage(error instanceof Error ? error.message : "invalid_plan_projection");
        setPreviewBinding(null);
        setApplyResult(null);
        return;
      }
      let digest: string;
      try {
        digest = await planProjectionInputDigest(body);
      } catch (error) {
        if (revision !== revisionRef.current) return;
        setMessage(error instanceof Error ? error.message : "plan_projection_digest_failed");
        setPreviewBinding(null);
        setApplyResult(null);
        return;
      }
      if (revision !== revisionRef.current) return;
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
        setMessage(`${parsed.code} (${parsed.requestId})`);
        setPreviewBinding({ input: body, digest, preview: parsed.data });
      } else if (parsed.kind === "failure") {
        setMessage(`${parsed.code} (${parsed.requestId})`);
      } else {
        setMessage("invalid_mutation_response");
      }
    });
  }

  async function applyFromPreview(): Promise<void> {
    const binding = previewBinding;
    const revision = revisionRef.current;
    if (binding === null || binding.preview.blocked.length > 0 || revision !== revisionRef.current) {
      setMessage("plan_projection_preview_required");
      return;
    }
    const body: PlanProjectionApplyInput = planProjectionApplyBody(binding.preview.preview_id);
    const requestBody = JSON.stringify(body);
    const isCurrent = (): boolean => revision === revisionRef.current;
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
        ].includes(parsed.code)) {
          invalidate();
          setMessage(`${parsed.code} — preview again`);
          return;
        }
        setMessage(`${parsed.code} (${parsed.requestId})`);
      },
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        appliedResult = parsed.data;
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
      setMessage("plan_projection_preview_required");
      return;
    }
    const disableCount = binding.preview.summary.disable;
    if (disableCount === 0) {
      void applyFromPreview();
      return;
    }
    const revision = revisionRef.current;
    requestConfirm({
      title: "Apply plan projection",
      body: `This will disable ${disableCount} grant${disableCount === 1 ? "" : "s"}.`,
      requiresReason: false,
      run: async () => {
        pendingApplyRef.current = true;
        return { ok: true };
      },
      isCurrent: () => revision === revisionRef.current,
    });
  }

  return {
    form,
    previewBinding,
    preview: previewBinding?.preview ?? applyResult,
    invalidate,
    updateForm,
    submitPreview,
    requestApply,
  };
}
