import React, { useRef, useState } from "react";

import type {
  CatalogImportApplyResult,
  CatalogImportManifest,
  CatalogImportPreviewResponse,
} from "../../../shared/api";
import { api } from "../../shared/api";
import {
  confirmMutationUnknown,
  confirmSuccessWithRefreshFailure,
  EXACT_READ_PROOF,
  focusTargetInSection,
  type ConfirmActionContext,
  type ConfirmActionOutcome,
  type ConfirmActionResolution,
  type ExactReadProof,
  useContextGeneration,
  useOperatorControls,
} from "../../shared/controls";
import {
  hasCatalogImportApplyData,
  hasCatalogImportPreviewData,
  mutationFailurePolicies,
  parseMutationResponse,
} from "../../shared/mutationGuards";
import {
  catalogImportApplyBody,
  catalogImportApplyMatchesConfirmedPreview,
  catalogImportInputDigest,
  catalogImportInputSnapshot,
  catalogImportPath,
  catalogImportPreviewMatchesLocalInput,
} from "./workflow";
import { CatalogImportConsequenceDetails } from "./CatalogDetails";

interface CatalogImportPreviewBinding {
  digest: string;
  snapshot: string;
  preview: CatalogImportPreviewResponse;
}

type CatalogImportControls = Pick<
  ReturnType<typeof useOperatorControls>,
  "requestConfirm" | "runMutation" | "setMessage"
>;

interface CatalogImportWorkflowOptions extends CatalogImportControls {
  active: boolean;
  invalidatePlanProjection: () => void;
  refreshCurrentCatalog: () => Promise<ExactReadProof | null>;
}

export interface CatalogImportWorkflow {
  text: string;
  previewBinding: CatalogImportPreviewBinding | null;
  preview: CatalogImportPreviewResponse | CatalogImportApplyResult | null;
  invalidate: (clearResult?: boolean) => void;
  updateText: (value: string) => void;
  previewImport: () => Promise<void>;
  requestApply: () => void;
}

/** Owns the preview capability and immutable same-key replay lifecycle. */
export function useCatalogImportWorkflow({
  active,
  invalidatePlanProjection,
  refreshCurrentCatalog,
  requestConfirm,
  runMutation,
  setMessage,
}: CatalogImportWorkflowOptions): CatalogImportWorkflow {
  const [text, setText] = useState("");
  const [previewBinding, setPreviewBinding] = useState<CatalogImportPreviewBinding | null>(null);
  const previewBindingRef = useRef<CatalogImportPreviewBinding | null>(null);
  previewBindingRef.current = previewBinding;
  const [applyResult, setApplyResult] = useState<CatalogImportApplyResult | null>(null);
  const revisionRef = useRef(0);
  const contextKey = `${active ? "active" : "inactive"}\u0000${text}`;
  const {
    generation,
    isCurrent: isGenerationCurrent,
    currentGeneration,
  } = useContextGeneration(contextKey);
  const activeRef = useRef(active);
  activeRef.current = active;

  function invalidate(clearResult = true): void {
    revisionRef.current += 1;
    previewBindingRef.current = null;
    setPreviewBinding(null);
    if (clearResult) setApplyResult(null);
  }

  function updateText(value: string): void {
    setText(value);
    invalidate();
  }

  async function previewImport(): Promise<void> {
    const importGeneration = generation;
    const revision = revisionRef.current;
    const isCurrent = (): boolean =>
      active && isGenerationCurrent(importGeneration) && revisionRef.current === revision;
    let manifest: CatalogImportManifest;
    let snapshot: string;
    let digest: string;
    try {
      manifest = JSON.parse(text) as CatalogImportManifest;
      snapshot = catalogImportInputSnapshot(manifest);
      digest = await catalogImportInputDigest(manifest);
    } catch {
      if (isCurrent()) setMessage("invalid_catalog_import_manifest");
      return;
    }
    if (!isCurrent()) return;
    await runMutation(async () => {
      const parsed = parseMutationResponse(
        await api<unknown>(catalogImportPath(true), { method: "POST", body: JSON.stringify(manifest) }),
        "catalog_import_previewed",
        hasCatalogImportPreviewData,
        mutationFailurePolicies.catalogImport,
        "initial",
      );
      if (!isCurrent()) return;
      if (parsed.kind === "success") {
        if (!catalogImportPreviewMatchesLocalInput(parsed.data, digest, snapshot)) {
          invalidate();
          setMessage("catalog_import_manifest_digest_mismatch");
          return;
        }
        const binding: CatalogImportPreviewBinding = { digest, snapshot, preview: parsed.data };
        previewBindingRef.current = binding;
        setPreviewBinding(binding);
        setApplyResult(null);
        setMessage(`${parsed.code} (${parsed.requestId})`);
        return;
      }
      if (parsed.kind === "failure") {
        setMessage(parsed.code === "catalog_import_too_large"
          ? "catalog_import_too_large — narrow the manifest and preview again"
          : `${parsed.code} (${parsed.requestId})`);
        return;
      }
      setMessage("invalid_mutation_response");
    });
  }

  function bindingIsUsable(binding: CatalogImportPreviewBinding, revision: number): boolean {
    return revisionRef.current === revision && previewBindingRef.current === binding;
  }

  async function applyFromPreview(
    binding: CatalogImportPreviewBinding,
    revision: number,
    importGeneration: number,
    idempotencyKey: string,
  ): Promise<ConfirmActionOutcome> {
    // The original presentation owns its focus target. A retained same-key
    // replay may still be required after navigating away, but must never use
    // this captured generation to publish into or focus a successor view.
    const isCurrent = (): boolean => activeRef.current && isGenerationCurrent(importGeneration);
    const bindingMatchesLocalInput = catalogImportPreviewMatchesLocalInput(
      binding.preview,
      binding.digest,
      binding.snapshot,
    );
    if (!bindingIsUsable(binding, revision) || !bindingMatchesLocalInput) {
      return { ok: false, message: "preview_required", retryable: true };
    }
    const body = JSON.stringify(catalogImportApplyBody(binding.preview.preview_id));
    const refreshStatus = async (): Promise<ExactReadProof | null> => await refreshCurrentCatalog();
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const hasConfirmedApplyData = (value: unknown): value is CatalogImportApplyResult =>
      bindingMatchesLocalInput &&
      hasCatalogImportApplyData(value) &&
      catalogImportApplyMatchesConfirmedPreview(value, binding.preview);
    const applyKnown = async (
      parsed: { code: string; requestId: string; data: CatalogImportApplyResult },
      publicationGeneration: number,
    ): Promise<ConfirmActionResolution> => {
      const ownsBinding = bindingIsUsable(binding, revision);
      const mayPublish = ownsBinding && activeRef.current && isGenerationCurrent(publicationGeneration);
      if (ownsBinding) {
        invalidate();
        invalidatePlanProjection();
      }
      if (mayPublish) {
        setApplyResult(parsed.data);
        setMessage(`${parsed.code} (${parsed.requestId})`);
      }
      if (!mayPublish) return "applied";
      try {
        return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
      } catch {
        return "refresh_failed";
      }
    };
    const replay = async (): Promise<ConfirmActionResolution> => {
      let retry: unknown | undefined;
      try {
        retry = await runMutation(async () => await api<unknown>(catalogImportPath(), {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body,
        }), "recovery");
      } catch {
        return "indeterminate";
      }
      if (retry === undefined) return "indeterminate";
      const parsed = parseMutationResponse(
        retry,
        "catalog_import_applied",
        hasConfirmedApplyData,
        mutationFailurePolicies.catalogImport,
        "replay",
      );
      if (parsed.kind !== "success") {
        return parsed.kind === "failure" ? "unapplied" : "indeterminate";
      }
      return await applyKnown(parsed, currentGeneration());
    };
    const reconciliation = {
      label: "Reconcile catalog import",
      run: replay,
      isCurrent,
      settlesRetainedAttempt: true,
      postSuccessRefresh,
    };
    let mutation: unknown | undefined;
    try {
      mutation = await runMutation(async () => await api<unknown>(catalogImportPath(), {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body,
      }), "consequence");
    } catch {
      return confirmMutationUnknown(reconciliation);
    }
    if (mutation === undefined) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(
      mutation,
      "catalog_import_applied",
      hasConfirmedApplyData,
      mutationFailurePolicies.catalogImport,
      "initial",
    );
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      const previewMustBeReplaced = [
        "catalog_import_snapshot_stale",
        "stale_catalog_import_preview",
        "expired_catalog_import_preview",
        "claimed_catalog_import_preview",
        "catalog_import_too_large",
      ].includes(parsed.code);
      if (previewMustBeReplaced) invalidate();
      const message = previewMustBeReplaced
        ? `${parsed.code} — preview again`
        : `${parsed.code} (${parsed.requestId})`;
      setMessage(message);
      return { ok: false, message, retryable: true };
    }
    return await applyKnown(parsed, importGeneration) === "applied"
      ? { ok: true }
      : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
  }

  function requestApply(): void {
    const binding = previewBinding;
    if (binding === null) {
      setMessage("preview_required");
      return;
    }
    const revision = revisionRef.current;
    const importGeneration = generation;
    requestConfirm({
      title: "Apply catalog import",
      body: "Apply this exact server-bound Preview. The manifest editor is not sent again.",
      details: <CatalogImportConsequenceDetails preview={binding.preview} />,
      requiresReason: false,
      run: ({ idempotencyKey }: ConfirmActionContext) =>
        applyFromPreview(binding, revision, importGeneration, idempotencyKey),
      successFocusTarget: focusTargetInSection("catalog-import"),
      isCurrent: () => active && isGenerationCurrent(importGeneration),
    });
  }

  return {
    text,
    previewBinding,
    preview: previewBinding?.preview ?? applyResult,
    invalidate,
    updateText,
    previewImport,
    requestApply,
  };
}
