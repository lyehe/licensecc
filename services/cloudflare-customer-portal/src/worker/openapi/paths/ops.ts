import type { LabeledPathFragment } from "../assemble.js";
import { ERR_BODY_TOO_LARGE, ERR_CROSS_SITE, ERR_INVALID_JSON, errorResponse, LEASE_ACTION_REQUEST } from "../components.js";

export const opsPaths: LabeledPathFragment = {
  label: "ops",
  entries: [
    ["/health", {
      get: {
        tags: ["ops"],
        operationId: "health",
        summary: "Health check. 200 only if ACCOUNT_TOKEN_MODE=required (backend account isolation enforced).",
        description: "Invariant 7: the portal is only healthy when the backend enforces full account isolation.",
        security: [],
        responses: {
          "200": {
            description: "Healthy (ACCOUNT_TOKEN_MODE=required).",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "healthy" },
                    data: { type: "object", required: ["account_token_mode_required"], properties: { account_token_mode_required: { const: true } } },
                  },
                },
              },
            },
          },
          "503": errorResponse('ACCOUNT_TOKEN_MODE != "required" — the portal is not healthy because backend account isolation is not enforced.', "account_token_mode_not_required"),
        },
      },
    }],
  ],
};
