// Shared customer shape for listing, provisioning, and lifecycle responses.
export const customerRowSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    login_email: { type: ["string", "null"], description: "Password login address; not proof of email ownership." },
    status: { type: "string", enum: ["active", "disabled"] },
    external_ref: { type: ["string", "null"] },
    created_at: { type: "integer" },
    updated_at: { type: "integer" },
  },
};
