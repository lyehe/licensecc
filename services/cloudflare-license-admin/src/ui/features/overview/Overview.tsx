import React, { useCallback, useEffect, useState } from "react";

import { ReadNotice } from "../../shared/ReadNotice";
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
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { setMessage } = useOperatorControls();
  const { registerCoreRefresh } = useCoreRefresh();
  const summaryFence = useRequestFence(active ? "summary:active" : "summary:inactive");

  const refresh = useCallback(async (strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    if (!isCurrent()) return null;
    const ticket = summaryFence.begin();
    setLoading(true); setReadError(null);
    const response = await api<Summary>("/api/admin/summary");
    if (!isCurrent() || !summaryFence.isCurrent(ticket)) return null;
    setLoading(false);
    const parsed = parseExactApiSuccess<Summary>(response, "summary", hasOverviewData);
    if (parsed !== null) {
      if (summaryFence.settle(ticket)) {
        setSummary(parsed.data);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      setReadError(apiFailureMessage(response));
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setReadError(apiFailureMessage(response));
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
    <section className="listPage">
      <ReadNotice label="overview" loading={loading} error={readError} hasData={summary !== null} onRetry={() => void refresh()} />
      <div className="grid metrics">
      <div><span>Total entitlements</span><strong>{summary?.entitlements.total ?? "—"}</strong><p>All access records</p></div>
      <div><span>Active</span><strong>{summary?.entitlements.active ?? "—"}</strong><p>Enabled · validity dates still apply</p></div>
      <div><span>Disabled</span><strong>{summary?.entitlements.disabled ?? "—"}</strong><p>Paused · can be re-enabled</p></div>
      <div><span>Revoked</span><strong>{summary?.entitlements.revoked ?? "—"}</strong><p>Permanently withdrawn</p></div>
      </div>
    </section>
  );
}
