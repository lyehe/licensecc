import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DEVICE_COMPARISON_FIELDS, deviceEnrollmentComparisonInput, formatDeviceEnrollmentComparison, decodeEnrollmentPageCursor } from "../src/lease/device_protocol.mjs";
import { encodeDeviceLeasePayload, decodeDeviceLeasePayload, deviceLeaseSigningInput, encodeDeviceLeaseEnvelope, decodeDeviceLeaseEnvelope, deviceOperationBody, deviceOperationDigestInput, deviceProofSigningInput, decodeBase64url } from "../src/lease/device_protocol.mjs";

const claims = () => ({ version: 1, purpose: "device-lease", "key-id": `sha256:${"a".repeat(64)}`, issuer: "https://licenses.example.test", audience: "desktop", project: "CAD", feature: "DEFAULT", "license-fingerprint": "b".repeat(64), "binding-id": "A".repeat(22), "device-key-id": `sha256:${"c".repeat(64)}`, generation: 1, "revocation-seq": 0, "lease-id": "A".repeat(22), "operation-id": "A".repeat(43), "issued-at": 1000, "renew-after": 2000, "expires-at": 3000 });
const enc = new TextEncoder();
const dec = new TextDecoder();
test("protected lease identifiers use canonical 16/16/32-byte tokens",()=>{
  for(const field of ["binding-id","lease-id","operation-id"]){
    for(const value of ["bad","A".repeat(field==="operation-id"?22:43),"B".repeat(field==="operation-id"?43:22)]){
      assert.throws(()=>encodeDeviceLeasePayload({...claims(),[field]:value}));
    }
  }
});
test("enrollment cursor accepts only the bounded canonical ep1 tuple",()=>{
  const tuple=["ep1","a".repeat(64),"b".repeat(64),"DEFAULT","c".repeat(64)];
  const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.deepEqual(decodeEnrollmentPageCursor(encode(tuple)),tuple);
  for(const value of [null,"","A","cGFnZTI","a".repeat(513),encode(tuple)+"=",encode([...tuple,"extra"]),encode(["ep2",...tuple.slice(1)]),encode(["ep1","A".repeat(64),...tuple.slice(2)]),encode([...tuple.slice(0,3),"x".repeat(16),tuple[4]]),Buffer.from(JSON.stringify(tuple,null,2)).toString("base64url")]){
    assert.throws(()=>decodeEnrollmentPageCursor(value));
  }
});

test("enrollment comparison matches the independent Python transcript and digest",()=>{
  const vector=JSON.parse(readFileSync(new URL("../../../test/vectors/device_bound/v1/enrollment_comparison.json",import.meta.url),"utf8"));
  const bytes=deviceEnrollmentComparisonInput(vector.input),digest=createHash("sha256").update(bytes).digest();
  assert.equal(Buffer.from(bytes).toString("hex"),vector.input_hex);
  assert.equal(digest.toString("hex"),vector.sha256_hex);
  assert.equal(formatDeviceEnrollmentComparison(digest),vector.comparison_code);
  for(const field of DEVICE_COMPARISON_FIELDS){
    const changed={...vector.input,[field]:field==="key_id"?`sha256:${"b".repeat(64)}`:["attempt_handle","state","code_challenge"].includes(field)?"A".repeat(43):vector.input[field]+"x"};
    assert.notEqual(formatDeviceEnrollmentComparison(createHash("sha256").update(deviceEnrollmentComparisonInput(changed)).digest()),vector.comparison_code,field);
  }
  assert.equal(formatDeviceEnrollmentComparison(new Uint8Array(32)),"0000-0000-0000");
  for(const digest of [new Uint8Array(6),new Uint8Array(31),new Uint8Array(33),[]])assert.throws(()=>formatDeviceEnrollmentComparison(digest));
  for(const input of [{...vector.input,extra:"x"},{...vector.input,client_id:"bad client"},{...vector.input,state:"A".repeat(43)+"="},{...vector.input,redirect_uri:"\ud800"}])assert.throws(()=>deviceEnrollmentComparisonInput(input));
  for(const bytes of [Buffer.from(vector.input_hex,"hex").subarray(0,-1),Buffer.from(dec.decode(deviceEnrollmentComparisonInput(vector.input)).replaceAll("\n","\r\n"))])assert.notEqual(createHash("sha256").update(bytes).digest("hex"),vector.sha256_hex);
});

test("device protocol bytes match the independently verified checked-in vector", () => {
  const vector = JSON.parse(readFileSync(new URL("../../../test/vectors/device_bound/v1/protocol.json", import.meta.url), "utf8"));
  const hex = bytes => Buffer.from(bytes).toString("hex");
  assert.equal(hex(encodeDeviceLeasePayload(vector.claims)), vector.lease_payload_hex);
  assert.equal(hex(deviceLeaseSigningInput(encodeDeviceLeasePayload(vector.claims))), vector.lease_signing_input_hex);
  assert.equal(hex(deviceProofSigningInput(vector.proof)), vector.proof_input_hex);
  assert.equal(hex(deviceOperationDigestInput("renew", vector.proof.key_id, vector.body)), vector.operation_digest_input_hex);
  assert.deepEqual(decodeDeviceLeaseEnvelope(vector.token).claims, vector.claims);
  const exchange = JSON.parse(readFileSync(new URL("../../../test/vectors/device_bound/v1/exchange.json", import.meta.url), "utf8"));
  assert.equal(hex(deviceProofSigningInput(exchange.proof)), exchange.proof_input_hex);
  assert.equal(hex(deviceOperationDigestInput("exchange", exchange.proof.key_id, exchange.body)), exchange.operation_digest_input_hex);
});

test("device lease preserves claims and domain separates exact signing bytes", () => {
  const payload = encodeDeviceLeasePayload(claims());
  assert.deepEqual(decodeDeviceLeasePayload(payload), claims());
  assert.equal(dec.decode(deviceLeaseSigningInput(payload)), `lccdl1.${dec.decode(payload)}`);
  const token = encodeDeviceLeaseEnvelope(payload, new Uint8Array(384));
  assert.deepEqual(decodeDeviceLeaseEnvelope(token).claims, claims());
  assert.throws(() => decodeDeviceLeaseEnvelope(token.replace("lccdl1", "lccoa1")));
  assert.throws(() => decodeDeviceLeaseEnvelope(token + ".extra"));
  assert.throws(() => decodeDeviceLeaseEnvelope(token + "="));
});

test("lease decoder rejects reordered, duplicate, missing, unknown and noncanonical fields", () => {
  const payload = dec.decode(encodeDeviceLeasePayload(claims()));
  for (const bad of [payload.trimEnd(), payload.replaceAll("\n", "\r\n"), payload + "extra=eA\n", payload.replace("generation=1", "generation=01"), payload.replace("generation=1", "generation=9007199254740992"), payload.replace("purpose=", "version="), payload.replace("version=1\n", ""), payload.replace("version=1\npurpose=ZGV2aWNlLWxlYXNl", "purpose=ZGV2aWNlLWxlYXNl\nversion=1")]) {
    assert.throws(() => decodeDeviceLeasePayload(enc.encode(bad)), bad);
  }
  assert.throws(() => decodeDeviceLeasePayload(new Uint8Array([255])));
  assert.throws(() => decodeDeviceLeasePayload(enc.encode("\ufeff" + payload)));
  assert.throws(() => decodeDeviceLeasePayload(new Uint8Array(4097)));
});

test("lease encoder rejects wrong purpose, invalid identities, unsafe values and contradictory time", () => {
  for (const patch of [{version: 2}, {purpose: "online-assertion"}, {"device-key-id": "arbitrary"}, {generation: 0}, {"revocation-seq": -1}, {"renew-after": 3000}, {"issued-at": 2000}, {project: ""}, {project: "\ud800"}, {extra: 1}]) assert.throws(() => encodeDeviceLeasePayload({...claims(), ...patch}));
  assert.throws(() => encodeDeviceLeaseEnvelope(encodeDeviceLeasePayload(claims()), new Uint8Array(256)));
  assert.throws(() => encodeDeviceLeasePayload({...claims(), project: "bad project"}));
  assert.throws(() => encodeDeviceLeasePayload({...claims(), feature: "bad feature"}));
});

test("base64url rejects padding, nonzero unused bits and foreign alphabet", () => {
  assert.deepEqual(decodeBase64url("Zg"), new Uint8Array([102]));
  for (const value of ["Zg==", "Zh", "+w", "/w", "a", " Zg"]) assert.throws(() => decodeBase64url(value));
});

test("semantic body has fixed field order, exact scope and no proof-dependent retry digest", () => {
  assert.equal(dec.decode(deviceOperationBody("renew", {operation_id: "op", generation: 2, binding_id: "binding"})), '["YmluZGluZw",2,"b3A"]');
  assert.throws(() => deviceOperationBody("renew", {operation_id: "op", generation: 2, binding_id: "binding", proof: {}}));
  assert.throws(() => deviceOperationBody("renew", {operation_id: "op", generation: "2", binding_id: "binding"}));
  assert.throws(() => deviceOperationBody("release", {}));
  const body = {operation_id: "op", generation: 2, binding_id: "binding"};
  const digestInput = deviceOperationDigestInput("renew", `sha256:${"a".repeat(64)}`, body);
  assert.ok(dec.decode(digestInput).startsWith("lcc-device-operation-v1\n"));
  assert.notDeepEqual(deviceOperationDigestInput("renew", `sha256:${"b".repeat(64)}`, body), digestInput);
  assert.notDeepEqual(deviceOperationDigestInput("renew", `sha256:${"a".repeat(64)}`, {...body, generation: 3}), digestInput);
});

test("proof signs full request intent and rejects unsupported operations", () => {
  const input = {audience: "backend", method: "POST", path: "/v2/device-leases/renew", key_id: `sha256:${"a".repeat(64)}`, operation_id: "op", body_sha256: "b".repeat(64), challenge_id: "challenge", nonce: "nonce", expires_at: 3000};
  const original = dec.decode(deviceProofSigningInput(input));
  assert.ok(original.startsWith("lcc-device-proof-v2\n"));
  for (const [field, value] of Object.entries({audience: "other", path: "/v2/device-authorizations/exchange", operation_id: "new", body_sha256: "c".repeat(64), challenge_id: "new", nonce: "new", expires_at: 3001})) assert.notEqual(dec.decode(deviceProofSigningInput({...input, [field]: value})), original);
  assert.throws(() => deviceProofSigningInput({...input, method: "GET"}));
  assert.throws(() => deviceProofSigningInput({...input, path: "/v1/renew"}));
  assert.throws(() => deviceProofSigningInput({...input, expires_at: -1}));
});


test("feature-specific comparison matches independent bytes and cannot silently downgrade", () => {
  const vector = JSON.parse(readFileSync(new URL("../../../test/vectors/device_bound/v1/enrollment_comparison_feature.json", import.meta.url), "utf8"));
  const bytes = deviceEnrollmentComparisonInput(vector.input);
  assert.equal(Buffer.from(bytes).toString("hex"), vector.input_hex);
  assert.equal(formatDeviceEnrollmentComparison(createHash("sha256").update(bytes).digest()), vector.comparison_code);
  const legacy = {...vector.input}; delete legacy.requested_feature;
  assert.notDeepEqual(deviceEnrollmentComparisonInput(legacy), bytes);
  assert.notDeepEqual(deviceEnrollmentComparisonInput({...vector.input,requested_feature:"BATCH_RUN"}), bytes);
  for (const value of [null,"",123,"TOO_LONG_FEATURE_NAME"])
    assert.throws(() => deviceEnrollmentComparisonInput({...vector.input,requested_feature:value}));
});
