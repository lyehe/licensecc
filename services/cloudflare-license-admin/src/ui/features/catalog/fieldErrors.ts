import { fieldForCode } from "../../shared/fieldErrors";

/*
 * The catalog editor field each validation or refusal code belongs to. A code with no field here
 * (a refusal of the whole row, or a rule for a field the editor does not show) stays in the
 * editor's own status line.
 */

export const CATALOG_FEATURE_FORM = "catalog-feature-editor";
export const CATALOG_PLAN_FORM = "catalog-plan-editor";
export const CATALOG_PLAN_FEATURE_FORM = "catalog-plan-feature-editor";
export const PLAN_PROJECTION_FORM = "plan-projection-editor";
export const CATALOG_IMPORT_FORM = "catalog-import-editor";

export function catalogFeatureFieldForCode(code: string): string | null {
  return fieldForCode(code, ["project", "feature_key", "name", "category"], {
    catalog_feature_conflict: "feature_key",
    notes_must_be_at_most_1000_chars: "description",
  });
}

export function catalogPlanFieldForCode(code: string): string | null {
  return fieldForCode(code, ["project", "plan_key", "name", "version"], {
    catalog_plan_conflict: "plan_key",
    notes_must_be_at_most_1000_chars: "description",
  });
}

export function catalogPlanFeatureFieldForCode(code: string): string | null {
  return fieldForCode(code, ["project", "feature_key", "addon_key", "policy_id", "display_order", "max_active_devices"], {
    addon_key_required: "addon_key",
    catalog_feature_not_found: "feature_key",
    catalog_policy_not_available: "policy_id",
    policy_not_found: "policy_id",
    policy_disabled: "policy_id",
  });
}

export function planProjectionFieldForCode(code: string): string | null {
  return fieldForCode(code, ["license_id", "customer_id", "plan_id", "plan_key", "support_until"], {
    plan_id_or_plan_key_required: "plan_key",
    license_id_required: "license_id",
    addon_must_be_at_most_128_chars: "addons",
    unknown_addon: "addons",
    notes_must_be_at_most_1000_chars: "notes",
  });
}

export function catalogImportFieldForCode(code: string): string | null {
  return code === "invalid_catalog_import_manifest" ? "manifest" : null;
}
