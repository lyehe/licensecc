import { MAX_DEVICE_LIMIT } from "../../shared/api.js";

export const entitlementRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Encoded entitlement id (project/feature/license_fingerprint)." },
    enforcement_mode: { type: "string", enum: ["legacy", "device_bound_v1"], readOnly: true, description: "Stored enforcement protocol, independent of commercial license_mode. Historical cached mutation responses may omit this field; read the current entitlement to establish its mode." },
    project: { type: "string" },
    feature: { type: "string" },
    license_fingerprint: { type: "string" },
    status: { type: "string", enum: ["active", "disabled", "revoked"] },
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
    trial_started_at: { type: ["integer", "null"] },
    trial_device_hash: { type: ["string", "null"] },
    max_active_devices: { type: "integer", minimum: 0, description: "Device limit: the most devices this license (entitlement) may have connected at once." },
  },
};

// The wire rules every protected grant body meets, on admin create and on sync: protected
// identifiers, and the customer and license that own the grant.
const protectedGrantFields = {
  project: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,127}(?![\\s\\S])" },
  feature: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,15}(?![\\s\\S])" },
  license_fingerprint: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
  customer_id: { type: "string", minLength: 1 },
  license_id: { type: "string", minLength: 1 },
  valid_from: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  valid_until: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
};

// A create, sync or PATCH body names only the fields its route reads; any other field returns
// 400 invalid_request. unevaluatedProperties closes each composed schema the same way.
export const entitlementCreateSchema = {
  description: "Every create is protected, so the body names no mode. A protected grant requires an active customer, that customer's license for this project, and, when the body selects one, a usable policy. Retries must repeat the same tuple.",
  unevaluatedProperties: false,
  allOf: [{ $ref: "#/components/schemas/EntitlementInput" }, {
    type: "object",
    required: ["customer_id", "license_id"],
    properties: {
      policy_id: {
        type: "string",
        maxLength: 128,
        description:
          "Optional. When present (and non-empty), the entitlement is STAMPED from this policy template instead of validated directly. Requires POLICY_STAMP_MODE=on (else 400 policy_stamping_disabled); the policy must exist and be active (else 404 policy_not_found). The body's grant fields act as per-field overrides on the stamp, except status and max_active_devices: the stamp writes an active grant with the policy's device limit, so a policy create naming either returns 400 invalid_request.",
      },
      max_active_devices: { type: "integer", minimum: 1, maximum: MAX_DEVICE_LIMIT, description: "Device limit for a create that selects no policy; omitted, the create keeps the stored limit (1 for a new grant). It is written in the create's own batch. A selected policy stamps its own limit, so sending both returns 400 invalid_request. A limit below the devices already connected is refused as protected_creation_conflict with data.reason invalid_capacity." },
      ...protectedGrantFields,
    },
  }, {
    // A selected policy stamps the grant's device limit and status, so a policy create names neither.
    if: { required: ["policy_id"], properties: { policy_id: { type: "string", minLength: 1 } } },
    then: { not: { anyOf: [{ required: ["max_active_devices"] }, { required: ["status"] }] } },
  }],
};

// A sync writes the same protected grant as an admin create: it names the grant's customer and that
// customer's license.
export const entitlementSyncSchema = {
  description: "Every synced grant is protected. The body names the customer who owns it and that customer's license for the project. A sync that creates a grant, or leaves or makes one active, passes the same protected checks as an admin create (409 protected_creation_conflict names a failed rule). A sync with status disabled or revoked for an existing grant always applies: it is a status-only transition that keeps the stored owner, license, notes and validity, whatever the body names.",
  unevaluatedProperties: false,
  allOf: [
    { $ref: "#/components/schemas/EntitlementInput" },
    {
      type: "object",
      required: ["customer_id", "license_id"],
      properties: {
        ...protectedGrantFields,
        reason: { type: "string", maxLength: 1000, description: "Optional; required (non-empty) when status is disabled or revoked." },
      },
    },
  ],
};

// The fields an entitlement PATCH writes through patchEntitlement. The PATCH request schema closes
// this schema together with the observed-state precondition.
const patchFields = {
  valid_from: { type: ["integer", "null"], minimum: 0 },
  valid_until: { type: ["integer", "null"], minimum: 0 },
  notes: { type: "string", maxLength: 1000 },
  customer_id: { type: ["string", "null"], maxLength: 128 },
  license_id: { type: ["string", "null"], maxLength: 128 },
};

export const entitlementPatchSchema = {
  type: "object",
  description: "All fields optional; only provided fields are updated. project/feature/license_fingerprint/status are NOT patchable: a body naming any field other than the properties below and the expected_* precondition returns 400 invalid_request. max_active_devices is its own audited capacity write: none of the other fields may accompany it (the required expected_* precondition may), or the PATCH returns 400 invalid_request.",
  properties: {
    ...patchFields,
    max_active_devices: { type: "integer", minimum: 1, maximum: MAX_DEVICE_LIMIT, description: "Device limit. A protected grant refuses a limit below its connected devices with 409 capacity_in_use and data.devices_in_use." },
  },
  dependentSchemas: { max_active_devices: { not: { anyOf: Object.keys(patchFields).map((field) => ({ required: [field] })) } } },
};
