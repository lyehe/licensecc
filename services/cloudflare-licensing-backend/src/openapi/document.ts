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
import { boundDevicePaths } from "./paths/bound-devices.js";

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
  boundDevicePaths,
);
assertUniqueOperationIds(paths);

export const openApiSpec: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "licensecc online verifier / licensing-backend",
    version: "0.1.0-rc.2",
    description:
      "Cloudflare Worker that issues online assertions (lccoa1), legacy v201 leases, floating seats and protected device leases (lccdl1), ingests subscription orders, and reports usage. Legacy responses use { ok, code, ... }; device v2 responses use { ok, code, request_id, data? }. Protected enrollment remains staged until browser consent and native integration are delivered. This spec documents the routes the Worker's fetch handler dispatches.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "meta", description: "Health and documentation." },
    { name: "client", description: "Unauthenticated client-facing online verification." },
    { name: "device", description: "Protected device enrollment, mandatory fresh key proof and signed leases. No emergency override." },
    { name: "fulfillment", description: "HMAC-signed subscription order ingest." },
    { name: "lease", description: "Account-token-scoped hardware-bound lease issuance (v201)." },
    { name: "seat", description: "Account-token-scoped floating/concurrent seat lifecycle." },
    { name: "report", description: "Account-token-scoped usage analytics." },
    { name: "emergency", description: "Break-glass operator overrides gated by EMERGENCY_OPERATOR_BEARER." },
  ],
  paths,
  components: assembleComponents(openApiComponents),
};
