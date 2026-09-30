import type { LabeledPathFragment } from "../assemble.js";

function readinessResponse(description: string, code: string, ready: boolean, envelope: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [{ $ref: `#/components/schemas/${envelope}` }],
          properties: {
            code: { const: code },
            data: { type: "object", required: ["backend_protected_ready"], properties: { backend_protected_ready: { const: ready } } },
          },
        },
      },
    },
  };
}

export const opsPaths: LabeledPathFragment = {
  label: "ops",
  entries: [
    ["/health", {
      get: {
        tags: ["ops"],
        operationId: "health",
        summary: "Health check. 200 only if the backend reports protected licensing ready.",
        description: "The portal is healthy only when the backend's own /health returns ok and protected_device_ready. Any missing, malformed, mismatched, non-200 or unreachable backend answer fails closed.",
        security: [],
        responses: {
          "200": readinessResponse("Healthy: the backend reports protected licensing ready.", "healthy", true, "Envelope"),
          "503": readinessResponse("The backend did not prove protected licensing ready, so the portal is not healthy.", "backend_not_ready", false, "ErrorEnvelope"),
        },
      },
    }],
  ],
};
