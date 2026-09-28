import { PROTECTED_CREATE_REASONS } from "../../shared/api.js";
import type { LabeledComponentFragment } from "./assemble.js";

// Protected onboarding: the license record an operator creates for a customer, and the rule a
// refused protected entitlement create names in data.reason (the runtime reason list, verbatim).
export const protectedOnboardingComponents: LabeledComponentFragment = {
  label: "protected-onboarding",
  namespaces: [["schemas", [
    ["LicenseCreateInput", {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,127}$", description: "Protected project ID, under the same rule a protected entitlement uses." },
        label: { type: "string", maxLength: 128, default: "", description: "Optional operator label. Trimmed; C0 control characters and DEL are rejected." },
      },
    }],
    ["LicenseCreatedData", {
      type: "object",
      required: ["id", "customer_id", "project", "label", "created_at"],
      properties: {
        id: { type: "string", pattern: "^lic_[0-9a-f-]{36}$" },
        customer_id: { type: "string" },
        project: { type: "string" },
        label: { type: "string" },
        created_at: { type: "integer" },
      },
    }],
    ["ProtectedCreationConflictData", {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: { reason: { enum: [...PROTECTED_CREATE_REASONS] } },
    }],
    ["ProtectedCreationConflictError", {
      allOf: [
        { $ref: "#/components/schemas/ErrorEnvelope" },
        {
          type: "object",
          required: ["code", "data"],
          properties: {
            code: { const: "protected_creation_conflict" },
            data: { $ref: "#/components/schemas/ProtectedCreationConflictData" },
          },
        },
      ],
    }],
  ]]],
};

// A protected eligibility refusal names its rule; every other conflict keeps the plain envelope.
// Its code is excluded from the plain branch so the documented oneOf stays mutually exclusive.
export function protectedCreationConflictResponse(description: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              allOf: [
                { $ref: "#/components/schemas/ErrorEnvelope" },
                { type: "object", required: ["code"], properties: { code: { enum: codes.filter((code) => code !== "protected_creation_conflict") } } },
              ],
            },
            { $ref: "#/components/schemas/ProtectedCreationConflictError" },
          ],
        },
        examples: Object.fromEntries(codes.map((code) => [code, {
          value: code === "protected_creation_conflict"
            ? { ok: false, code, request_id: "1a2b3c-1", data: { reason: "customer_inactive" } }
            : { ok: false, code, request_id: "1a2b3c-1" },
        }])),
      },
    },
  };
}
