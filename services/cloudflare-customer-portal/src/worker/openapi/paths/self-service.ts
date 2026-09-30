import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse } from "../components.js";

export const selfServicePaths: LabeledPathFragment = {
  label: "self-service",
  entries: [
    ["/api/portal/me", {
      get: {
        tags: ["portal"],
        operationId: "portalMe",
        summary: "Return the authenticated customer_id from the session.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "The session-scoped identity.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "me" },
                    data: {
                      type: "object",
                      required: ["customer_id", "email"],
                      properties: {
                        customer_id: { type: "string" },
                        email: { type: ["string", "null"], description: "customers.email, else portal_passwords.email_lower, else the earliest portal_identities.email, else null." },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse("No / invalid / expired / revoked session.", "unauthorized"),
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/api/portal/entitlements", {
      get: {
        tags: ["portal"],
        operationId: "portalEntitlements",
        summary: "List the customer's entitlements (read-only, customer_id bound).",
        description: "Ordered by project, feature.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "The customer's entitlements.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "entitlements" },
                    data: {
                      type: "object",
                      required: ["items"],
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              project: { type: "string" },
                              feature: { type: "string" },
                              license_fingerprint: { type: "string" },
                              enforcement_mode: { type: "string", enum: ["device_bound_v1"], description: "Every grant is protected: devices connect from the application with browser consent." },
                              status: { type: "string" },
                              valid_from: { type: ["integer", "null"] },
                              valid_until: { type: ["integer", "null"] },
                              trial_ends_at: {
                                type: ["integer", "null"],
                                description: "When the trial ends (epoch seconds), by the protected-device trial rule that enforces the row; never after valid_until. null for a license that is not a trial, for a trial whose clock starts at its first activation and has not started yet (trial_starts_on_activation), and for a trial with no end of its own.",
                              },
                              trial_starts_on_activation: {
                                type: "boolean",
                                description: "True for a trial whose clock starts at its first activation and has not started yet, with a duration the protected-device trial rule accepts: at least 2 seconds. Otherwise false.",
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse("No / invalid / expired / revoked session.", "unauthorized"),
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
  ],
};
