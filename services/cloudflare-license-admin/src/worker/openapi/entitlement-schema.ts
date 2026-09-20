export const entitlementRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Encoded entitlement id (project/feature/license_fingerprint)." },
    enforcement_mode: { type: "string", enum: ["legacy", "device_bound_v1"], readOnly: true, description: "Stored enforcement protocol, independent of commercial license_mode. Historical cached mutation responses may omit this field; read the current entitlement to establish its mode." },
    project: { type: "string" },
    feature: { type: "string" },
    license_fingerprint: { type: "string" },
    device_hash: { type: "string" },
    status: { type: "string", enum: ["active", "disabled", "revoked"] },
    assertion_ttl_seconds: { type: "integer" },
    revocation_seq: { type: "integer" },
    valid_from: { type: ["integer", "null"] },
    valid_until: { type: ["integer", "null"] },
    notes: { type: "string" },
    customer_id: { type: ["string", "null"] },
    license_id: { type: ["string", "null"] },
    created_at: { type: "integer" },
    updated_at: { type: "integer" },
    policy_id: { type: ["string", "null"], description: "Advisory provenance: the policy this row was stamped from (frozen; no live link)." },
    is_trial: { type: "integer", description: "1 when stamped from a trial policy, else 0. Frozen on the row." },
    trial_expiration_basis: { type: ["string", "null"], enum: ["from_issue", "from_first_activation", "from_first_use", null] },
    trial_duration_sec: { type: "integer" },
    trial_one_per_device: { type: "integer", enum: [0, 1] },
    trial_require_device_proof: { type: "integer", enum: [0, 1] },
    trial_started_at: { type: ["integer", "null"] },
    trial_device_hash: { type: ["string", "null"] },
  },
};

export const entitlementCreateSchema = {
  allOf: [{ $ref: "#/components/schemas/EntitlementInput" }, {
    type: "object",
    properties: {
      enforcement_mode: { type: "string", enum: ["legacy", "device_bound_v1"], description: "Create-only selection. Omission inserts legacy or preserves existing mode. Explicit mode must match an existing row; no in-place conversion. Protected grants require an active customer, matching license/project, zero pool, no legacy device hash/history, and usable policy. Explicit retries require the same tuple and mode; historical missing-mode replies conflict." },
    },
    if: { required: ["enforcement_mode"], properties: { enforcement_mode: { const: "device_bound_v1" } } },
    then: {
      required: ["customer_id", "license_id"],
      properties: {
        project: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,127}(?![\\s\\S])" },
        feature: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,15}(?![\\s\\S])" },
        license_fingerprint: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
        device_hash: { const: "" },
        customer_id: { type: "string", minLength: 1 },
        license_id: { type: "string", minLength: 1 },
        valid_from: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        valid_until: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
  }],
};
