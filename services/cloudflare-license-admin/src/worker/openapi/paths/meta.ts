import type { LabeledPathFragment } from "../assemble.js";
import {
  ADMIN_AUTH_ERRORS,
  ADMIN_MUTATION_AUTH_ERRORS,
  ADMIN_SECURITY,
  csvExportResponse,
  deviceKeyIdParam,
  errorResponse,
  featureKeyParam,
  formatCsvParam,
  idempotencyKeyHeader,
  idParam,
  limitCursorParams,
  okResponse,
  SYNC_SECURITY,
} from "../components.js";

export const metaPaths: LabeledPathFragment = {
  label: "meta",
  entries: [
    ["/openapi.json", {
    get: {
      tags: ["meta"],
      summary: "This OpenAPI 3.1 document",
      operationId: "getOpenApiDocument",
      security: [],
      responses: {
        "200": { description: "The OpenAPI document for this Worker.", content: { "application/json": { schema: { type: "object" } } } },
      },
    },
  }],
    ["/docs", {
    get: {
      tags: ["meta"],
      summary: "Self-contained HTML API reference",
      operationId: "getDocsPage",
      security: [],
      responses: {
        "200": { description: "A dependency-free HTML page that fetches /openapi.json and renders the endpoint list.", content: { "text/html": { schema: { type: "string" } } } },
      },
    },
  }],
  ],
};
