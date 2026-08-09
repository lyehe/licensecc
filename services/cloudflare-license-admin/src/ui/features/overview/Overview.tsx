import React, { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";

interface Summary {
  entitlements: {
    total: number;
    active: number;
    revoked: number;
    disabled: number;
  };
}

export function Overview({ active }: { active: boolean }): React.ReactElement | null {
  const [summary, setSummary] = useState<Summary | null>(null);
  const { setMessage } = useOperatorControls();
  const { registerCoreRefresh } = useCoreRefresh();

  const refresh = useCallback(async (): Promise<void> => {
    const response = await api<Summary>("/api/admin/summary");
    if (response.ok && response.data) {
      setSummary(response.data);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }, [setMessage]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
