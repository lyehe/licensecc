import type { LabeledComponentFragment } from "./assemble.js";

// Device limit: a PATCH below a protected grant's connected devices is refused (ADR 0006), and the
// refusal says how many devices hold a slot, so the operator knows how many to disconnect first.
export const deviceLimitComponents: LabeledComponentFragment = {
  label: "device-limit",
  namespaces: [["schemas", [
    ["CapacityInUseData", {
      type: "object",
      additionalProperties: false,
      required: ["devices_in_use"],
      properties: {
        devices_in_use: { type: "integer", minimum: 0, description: "Devices holding a slot on this license (entitlement): active, or disconnected but still within their hold. Read after the refusal, so it is advisory." },
      },
    }],
    ["CapacityInUseError", {
      allOf: [
        { $ref: "#/components/schemas/ErrorEnvelope" },
        {
          type: "object",
          required: ["code", "data"],
          properties: {
            code: { const: "capacity_in_use" },
            data: { $ref: "#/components/schemas/CapacityInUseData" },
          },
        },
      ],
    }],
  ]]],
};

// The capacity refusal carries data; every other conflict keeps the plain envelope. Its code is
// excluded from the plain branch so the documented oneOf stays mutually exclusive.
export function capacityConflictResponse(description: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              allOf: [
                { $ref: "#/components/schemas/ErrorEnvelope" },
                { type: "object", required: ["code"], properties: { code: { enum: codes.filter((code) => code !== "capacity_in_use") } } },
              ],
            },
            { $ref: "#/components/schemas/CapacityInUseError" },
          ],
        },
        examples: Object.fromEntries(codes.map((code) => [code, {
          value: code === "capacity_in_use"
            ? { ok: false, code, request_id: "1a2b3c-1", data: { devices_in_use: 3 } }
            : { ok: false, code, request_id: "1a2b3c-1" },
        }])),
      },
    },
  };
}
