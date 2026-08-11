// OpenAPI 3.1 "doc-of-existing" for the Customer Portal Worker.
// The two self-describing meta routes are served but deliberately marked inSpec:false.

import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "./assemble.js";
import { openApiComponents } from "./components.js";
import { authPaths } from "./paths/auth.js";
import { opsPaths } from "./paths/ops.js";
import { selfServicePaths } from "./paths/self-service.js";

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

const paths = assemblePaths(authPaths, selfServicePaths, opsPaths);
assertUniqueOperationIds(paths);

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "licensecc Customer Portal Worker",
    version: "0.1.0-rc.1",
    description:
      "Self-serve customer portal: email-OTP / magic-link sign-in, read-only session-scoped " +
      "entitlement/device/usage views, and per-action seat operations (checkout/heartbeat/" +
      "release/download) proxied to the licensing backend via an ephemeral, session-scoped " +
      "account token. Every authenticated route binds the session-derived customer_id; no " +
      "client-supplied customer_id or fingerprint reaches a mutation chokepoint. This document " +
      "describes the routes the Worker actually serves and is pinned to the source by a " +
      "build-time cross-check test.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "auth", description: "Public sign-in / sign-out (email OTP + magic link). No session required." },
    { name: "admin", description: "Operator break-glass OTP issuance (bearer-gated; unset -> 404)." },
    { name: "portal", description: "Session-scoped customer data + per-action seat operations. Requires the lccp_session cookie." },
    { name: "ops", description: "Health / operational endpoints." },
  ],
  components: assembleComponents(openApiComponents),
  paths,
};
