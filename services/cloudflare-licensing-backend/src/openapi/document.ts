// OpenAPI 3.1 "doc-of-existing" for the licensecc online verifier / licensing-backend Worker.
// This document assembles bounded-context fragments only; it does not generate handler code.

import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "./assemble.js";
import { openApiComponents } from "./components.js";
import { emergencyPaths } from "./paths/emergency.js";
import { leasePaths } from "./paths/leases.js";
import { meterPaths } from "./paths/metering.js";
import { metaPaths } from "./paths/meta.js";
import { ordersPaths } from "./paths/orders.js";
import { reportPaths } from "./paths/reports.js";
import { seatPaths } from "./paths/seats.js";
import { verifyPaths } from "./paths/verify.js";

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: { url: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

const paths = assemblePaths(
  metaPaths,
  verifyPaths,
  ordersPaths,
  leasePaths,
  seatPaths,
  meterPaths,
  reportPaths,
  emergencyPaths,
);
assertUniqueOperationIds(paths);

export const openApiSpec: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "licensecc online verifier / licensing-backend",
    version: "0.1.0-rc.1",
    description:
      "Cloudflare Worker that issues signed online assertions (lccoa1) and hardware-bound v201 leases / floating seats, ingests signed subscription orders, and reports usage. All responses use a FLAT { ok, code, ... } envelope. This spec documents the routes the Worker's fetch handler dispatches.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "meta", description: "Health and documentation." },
    { name: "client", description: "Unauthenticated client-facing online verification." },
    { name: "fulfillment", description: "HMAC-signed subscription order ingest." },
    { name: "lease", description: "Account-token-scoped hardware-bound lease issuance (v201)." },
    { name: "seat", description: "Account-token-scoped floating/concurrent seat lifecycle." },
    { name: "report", description: "Account-token-scoped usage analytics." },
    { name: "emergency", description: "Break-glass operator overrides gated by EMERGENCY_OPERATOR_BEARER." },
  ],
  paths,
  components: assembleComponents(openApiComponents),
};
