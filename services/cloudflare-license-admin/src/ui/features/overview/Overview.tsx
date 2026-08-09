import React, { useCallback, useEffect, useState } from "react";

import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { ConfirmRefreshFailure, EXACT_READ_PROOF, type ExactReadProof, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { hasOverviewData } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";

interface Summary {
  entitlements: {
    total: number;
    active: number;
    revoked: number;
    disabled: number;
  };
}

export function Overview({ active }: { active: boolean }): React.ReactElement | null {
  const [summarySnapshot, setSummary] = useState<Summary | null>(null);
  const { setMessage } = useOperatorControls();
  const { registerCoreRefresh } = useCoreRefresh();
  const summaryFence = useRequestFence(active ? "summary:active" : "summary:inactive");

  const refresh = useCallback(async (strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    if (!isCurrent()) return null;
    const ticket = summaryFence.begin();
    const response = await api<Summary>("/api/admin/summary");
    if (!isCurrent() || !summaryFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<Summary>(response, "summary", hasOverviewData);
    if (parsed !== null) {
      if (summaryFence.settle(ticket)) {
        setSummary(parsed.data);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setMessage(apiFailureMessage(response));
    }
    return null;
  }, [setMessage, summaryFence]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const summary = summaryFence.isSettled() ? summarySnapshot : null;

  if (!active) {
    return null;
  }
  return (
    <section className="grid metrics">
      <div><span>Total</span><strong>{summary?.entitlements.total ?? 0}</strong></div>
      <div><span>Active</span><strong>{summary?.entitlements.active ?? 0}</strong></div>
      <div><span>Disabled</span><strong>{summary?.entitlements.disabled ?? 0}</strong></div>
      <div><span>Revoked</span><strong>{summary?.entitlements.revoked ?? 0}</strong></div>
    </section>
  );
}
