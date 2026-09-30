import type { LabeledPathFragment } from "../assemble.js";

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
    summary: "Health and protected-licensing readiness check.",
    operationId: "getHealth",
    security: [],
    responses: {
      "200": {
        description:
          "Service healthy and protected_device_ready: the protected device configuration passed its local readiness checks. config_warnings is present only for names-only paired-material consistency warnings.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HealthSuccess" },
            examples: {
              ok: {
                value: {
                  ok: true,
                  service: "licensecc-online-verifier",
                  protected_device_ready: true,
                },
              },
            },
          },
        },
      },
      "503": {
        description:
          "Not ready. protected_device_ready is false when the protected device configuration fails a local readiness check; config_error with invalid_config_modes means one or more security rollout selectors is invalid. Health remains callable and returns names and booleans only, never raw configuration values or secrets.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HealthConfigError" },
            examples: {
              protected_not_ready: {
                value: {
                  ok: false,
                  service: "licensecc-online-verifier",
                  protected_device_ready: false,
                },
              },
              config_error: {
                value: {
                  ok: false,
                  service: "licensecc-online-verifier",
                  protected_device_ready: true,
                  code: "config_error",
                  invalid_config_modes: ["ORDER_SIGNER_SCOPE_MODE"],
                },
              },
            },
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
