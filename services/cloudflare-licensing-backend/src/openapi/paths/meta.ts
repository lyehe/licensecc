import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS } from "../components.js";

const openapiJsonPath: Record<string, unknown> = {
  get: {
    tags: ["meta"],
    summary: "This OpenAPI 3.1 document.",
    operationId: "getOpenApiJson",
    security: [],
    responses: {
      "200": {
        description: "The OpenAPI specification as JSON.",
        content: { "application/json": { schema: { type: "object" } } },
      },
    },
  },
};

const docsPath: Record<string, unknown> = {
  get: {
    tags: ["meta"],
    summary: "Self-contained HTML API documentation viewer.",
    operationId: "getDocs",
    security: [],
    responses: {
      "200": {
        description: "An HTML page that fetches /openapi.json and renders a grouped endpoint list.",
        content: { "text/html": { schema: { type: "string" } } },
      },
    },
  },
};

const healthPath: Record<string, unknown> = {
  get: {
    tags: ["meta"],
    summary: "Health check.",
    operationId: "getHealth",
    security: [],
    responses: {
      "200": {
        description: "Service healthy.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HealthSuccess" },
            examples: { ok: { value: { ok: true, service: "licensecc-online-verifier" } } },
          },
        },
      },
    },
  },
};

export const metaPaths: LabeledPathFragment = {
  label: "meta",
  entries: [
    ["/openapi.json", openapiJsonPath],
    ["/docs", docsPath],
    ["/health", healthPath],
  ],
};
