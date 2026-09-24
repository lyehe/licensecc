import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

const failure = (code, data, requestId = "req-7") => ({ kind: "failure", code, requestId, ...(data === undefined ? {} : { data }) });

test("every protected-create reason reads as one actionable sentence, never its code", async () => {
  const onboarding = await loadWorkflowModule("features/entitlements/protectedCreate.ts");
  const { PROTECTED_CREATE_REASONS } = await loadWorkflowModule("../shared/api.ts");
  assert.equal(PROTECTED_CREATE_REASONS.length, 10);
  const sentences = new Set();
  for (const reason of PROTECTED_CREATE_REASONS) {
    const message = onboarding.protectedCreateFailureMessage(failure("protected_creation_conflict", { reason }));
    assert.equal(typeof message, "string", reason);
    assert.ok(!message.includes(reason) && !message.includes("protected_creation_conflict"), `${reason}: ${message}`);
    assert.doesNotMatch(message, /\b[a-z]+_[a-z_]+\b/, `${reason} leaks a snake_case code: ${message}`);
    assert.match(message, /Reference req-7\.$/, `${reason} names the request reference`);
    sentences.add(message);
  }
  assert.equal(sentences.size, PROTECTED_CREATE_REASONS.length, "each reason has its own sentence");
  const generic = onboarding.protectedCreateFailureMessage(failure("protected_creation_conflict", { reason: "unknown" }));
  for (const data of [undefined, null, {}, { reason: 7 }, { reason: "brand_new_rule" }, { reason: "toString" }, "customer_inactive"]) {
    assert.equal(onboarding.protectedCreateFailureMessage(failure("protected_creation_conflict", data)), generic, JSON.stringify(data));
  }
  assert.equal(onboarding.protectedCreateFailureMessage(failure("enforcement_mode_conflict", { reason: "customer_inactive" })), null);
});

test("generate fingerprint turns 32 random bytes into 64 lowercase hex characters", async () => {
  const onboarding = await loadWorkflowModule("features/entitlements/protectedCreate.ts");
  const ownStub = Object.hasOwn(crypto, "getRandomValues"), original = crypto.getRandomValues;
  let requested = 0;
  crypto.getRandomValues = (bytes) => { requested = bytes.length; bytes.forEach((_, index) => { bytes[index] = index * 8; }); return bytes; };
  try {
    assert.equal(onboarding.generateLicenseFingerprint(), Array.from({ length: 32 }, (_, index) => (index * 8).toString(16).padStart(2, "0")).join(""));
    assert.equal(requested, 32);
  } finally {
    if (ownStub) crypto.getRandomValues = original; else delete crypto.getRandomValues;
  }
  const first = onboarding.generateLicenseFingerprint(), second = onboarding.generateLicenseFingerprint();
  assert.match(first, /^[0-9a-f]{64}$/); assert.match(second, /^[0-9a-f]{64}$/); assert.notEqual(first, second);
});

test("create license targets one customer and accepts only that customer's new record for the project", async () => {
  const onboarding = await loadWorkflowModule("features/entitlements/protectedCreate.ts");
  assert.equal(onboarding.createLicensePath("cust/1 a"), "/api/admin/customers/cust%2F1%20a/licenses");
  const record = { id: "lic_0f8f0000-0000-4000-8000-000000000001", customer_id: "cust_1", project: "APP", label: "", created_at: 1_760_000_000 };
  assert.equal(onboarding.hasCreatedLicenseData(record, "cust_1", "APP"), true);
  for (const change of [{ id: "license" }, { customer_id: "cust_2" }, { project: "OTHER" }, { label: null }, { created_at: -1 }, { created_at: 1.5 }]) {
    assert.equal(onboarding.hasCreatedLicenseData({ ...record, ...change }, "cust_1", "APP"), false, JSON.stringify(change));
  }
  assert.equal(onboarding.hasCreatedLicenseData(null, "cust_1", "APP"), false);
  for (const project of ["APP", "a.b:c-d_e", "A".repeat(127)]) assert.equal(onboarding.isProtectedProject(project), true, project);
  for (const project of ["", "APP SPACE", "A".repeat(128), "应用", "APP\n"]) assert.equal(onboarding.isProtectedProject(project), false, project);
  const rules = onboarding.licenseCreateFailures.initial;
  assert.ok(rules.some((rule) => rule.status === 404 && rule.codes.includes("not_found")));
  assert.ok(rules.some((rule) => rule.status === 409 && rule.codes.includes("customer_inactive")));
  assert.deepEqual(onboarding.licenseCreateFailures.replay, []);
  for (const code of ["customer_inactive", "not_found", "invalid_request", "admin_role_required"]) {
    const message = onboarding.licenseCreateFailureMessage(failure(code));
    assert.ok(!message.includes(code), `${code}: ${message}`);
    assert.match(message, /Reference req-7\.$/);
  }
});

test("the create failure policy admits a protected conflict and keeps its reason for the operator", async () => {
  const guards = await loadWorkflowModule("shared/mutationGuards.ts");
  const envelope = Object.defineProperties(
    { ok: false, code: "protected_creation_conflict", request_id: "req-9", data: { reason: "license_missing" } },
    { __httpOk: { value: false }, __httpStatus: { value: 409 } },
  );
  assert.deepEqual(
    guards.parseMutationResponse(envelope, "entitlement_saved", () => true, guards.mutationFailurePolicies.entitlementCreate, "initial"),
    { kind: "failure", code: "protected_creation_conflict", requestId: "req-9", data: { reason: "license_missing" } },
  );
  // A replay still resolves only on an exact success.
  assert.deepEqual(guards.parseMutationResponse(envelope, "entitlement_saved", () => true, guards.mutationFailurePolicies.entitlementCreate, "replay"), { kind: "invalid" });
});
