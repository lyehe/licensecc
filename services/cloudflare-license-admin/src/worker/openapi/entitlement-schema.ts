import { MAX_DEVICE_LIMIT } from "../../shared/api.js";

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

export const entitlementCreateSchema = {
  allOf: [{ $ref: "#/components/schemas/EntitlementInput" }, {
    type: "object",
    required: ["enforcement_mode", "customer_id", "license_id"],
    properties: {
      enforcement_mode: { type: "string", const: "device_bound_v1", description: "Required. Every create is protected; an omitted or any other mode returns 400 invalid_request. A protected grant requires an active customer, that customer's license for this project, no seat pool, and a usable policy; it carries no device hash or assertion TTL. An existing row of another mode is never converted in place (409 enforcement_mode_conflict). Retries must repeat the same tuple." },
      max_active_devices: { type: "integer", minimum: 1, maximum: MAX_DEVICE_LIMIT, description: "Device limit for a create that selects no policy; omitted, the create keeps the stored limit (1 for a new grant). It is written in the create's own batch. A selected policy stamps its own limit, so sending both returns 400 invalid_request. A limit below the devices already connected is refused as protected_creation_conflict with data.reason invalid_capacity." },
      ...protectedGrantFields,
    },
  }, {
    // A selected policy owns the device limit.
    if: { required: ["policy_id"], properties: { policy_id: { type: "string", minLength: 1 } } },
    then: { not: { required: ["max_active_devices"] } },
  }],
};

// A sync writes the same protected grant as an admin create: it names the grant's customer and that
// customer's license, and the Worker supplies the protected mode.
export const entitlementSyncSchema = {
  description: "Every synced grant is protected. The body names the customer who owns it and that customer's license for the project. A sync that creates a grant, or leaves or makes one active, passes the same protected checks as an admin create (409 protected_creation_conflict names a failed rule). A sync with status disabled or revoked for an existing grant always applies: it is a status-only transition that keeps the stored owner, license, notes and validity, whatever the body names. The body cannot choose the mode, and an existing grant of another mode is 409 enforcement_mode_conflict, even when unchanged.",
  not: { required: ["enforcement_mode"] },
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

// The fields an entitlement PATCH writes through patchEntitlement. Keys the Worker does not patch
// are ignored, so the schema leaves them open.
const patchFields = {
  valid_from: { type: ["integer", "null"], minimum: 0 },
  valid_until: { type: ["integer", "null"], minimum: 0 },
  notes: { type: "string", maxLength: 1000 },
  customer_id: { type: ["string", "null"], maxLength: 128 },
  license_id: { type: ["string", "null"], maxLength: 128 },
};

export const entitlementPatchSchema = {
  type: "object",
  // A protected grant carries no device hash or assertion TTL, and no PATCH changes its mode.
  not: { anyOf: [{ required: ["enforcement_mode"] }, { required: ["device_hash"] }, { required: ["assertion_ttl_seconds"] }] },
  description: "All fields optional; only provided fields are updated. project/feature/license_fingerprint/status are NOT patchable. device_hash and assertion_ttl_seconds are refused with 400 invalid_request: a protected grant carries neither. max_active_devices is its own audited capacity write: none of the other fields may accompany it (the optional expected_* precondition may), or the PATCH returns 400 invalid_request.",
  properties: {
    ...patchFields,
    max_active_devices: { type: "integer", minimum: 1, maximum: MAX_DEVICE_LIMIT, description: "Device limit. A protected grant refuses a limit below its connected devices with 409 capacity_in_use and data.devices_in_use." },
  },
  dependentSchemas: { max_active_devices: { not: { anyOf: Object.keys(patchFields).map((field) => ({ required: [field] })) } } },
};
