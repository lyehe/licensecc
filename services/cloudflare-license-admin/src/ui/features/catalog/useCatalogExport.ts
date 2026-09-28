import type { CatalogImportManifest, CatalogPlan } from "../../../shared/api";
import { api, parseExactApiSuccess } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { apiFailureFeedback } from "../../shared/messages";
import { hasCatalogImportManifestData } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import { catalogPlanExportPath } from "./workflow";

export function useCatalogExport(active: boolean): (plan: CatalogPlan) => Promise<void> {
  const { runMutation, setFeedback } = useOperatorControls();
  const exportFence = useRequestFence(`${active ? "active" : "inactive"}\u0000catalog-export`);
  return async (plan: CatalogPlan): Promise<void> => {
    await runMutation(async () => {
      const ticket = exportFence.begin();
      const result = await api<CatalogImportManifest>(catalogPlanExportPath(plan.id));
      if (!exportFence.isCurrent(ticket)) return;
      const parsed = parseExactApiSuccess<CatalogImportManifest>(result, "catalog_plan_exported", hasCatalogImportManifestData);
      if (parsed === null) { setFeedback(apiFailureFeedback(result)); return; }
      const blob = new Blob([JSON.stringify(parsed.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${plan.plan_key}-catalog.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setFeedback({ tone: "success", message: `Exported ${plan.plan_key}-catalog.json.` });
      } finally { URL.revokeObjectURL(url); }
    });
  };
}
