// OpenAPI 3.1 "doc-of-existing" for the licensecc online verifier / licensing-backend Worker.
// This document assembles bounded-context fragments only; it does not generate handler code.

import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "./assemble.js";
import { openApiComponents } from "./components.js";
import { metaPaths } from "./paths/meta.js";
import { ordersPaths } from "./paths/orders.js";
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
  boundDevicePaths,
);
assertUniqueOperationIds(paths);

export const openApiSpec: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "licensecc online verifier / licensing-backend",
    version: "0.1.0-rc.2",
    description:
      "Cloudflare Worker that issues online assertions (lccoa1) and protected device leases (lccdl1), and ingests subscription orders. Legacy responses use { ok, code, ... }; device v2 responses use { ok, code, request_id, data? }. Protected enrollment remains staged until browser consent and native integration are delivered. This spec documents the routes the Worker's fetch handler dispatches.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "meta", description: "Health and documentation." },
    { name: "client", description: "Unauthenticated client-facing online verification." },
    { name: "device", description: "Protected device enrollment, mandatory fresh key proof and signed leases. No emergency override." },
    { name: "fulfillment", description: "HMAC-signed subscription order ingest." },
  ],
  paths,
  components: assembleComponents(openApiComponents),
};
