import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { encodeBase64url, encodeDeviceLeasePayload, encodeDeviceLeaseEnvelope, decodeDeviceLeaseEnvelope, deviceLeaseSigningInput, deviceProofSigningInput } from "@licensecc/licensing-domain/lease/device_protocol";
import { importBoundDeviceKey, normalizeDeviceSignature, verifyBoundDeviceProof, signBoundDeviceLease, verifyBoundDeviceLease, boundLeaseKeyId } from "../dist/device/bound_crypto.mjs";

test("bound device proof requires key possession, complete intent and canonical P-256 signature", async () => {
  const pair = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"}, true, ["sign","verify"]);
  const spki = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const {keyId} = await importBoundDeviceKey(spki);
  const input = {audience:"backend", method:"POST", path:"/v2/device-leases/renew", key_id:keyId, operation_id:"operation", body_sha256:"a".repeat(64), challenge_id:"challenge", nonce:"nonce", expires_at:3000};
  const raw = new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},pair.privateKey,deviceProofSigningInput(input)));
  const signature = encodeBase64url(normalizeDeviceSignature(raw));
  assert.equal(await verifyBoundDeviceProof(spki,input,signature),true);
  for (const patch of [{nonce:"other"},{operation_id:"other"},{body_sha256:"b".repeat(64)},{audience:"other"},{expires_at:3001},{key_id:`sha256:${"b".repeat(64)}`}]) assert.equal(await verifyBoundDeviceProof(spki,{...input,...patch},signature),false);
  assert.equal(await verifyBoundDeviceProof(spki,input,encodeBase64url(new Uint8Array(64))),false);
  assert.equal(await verifyBoundDeviceProof(spki+"=",input,signature),false);
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const low = normalizeDeviceSignature(raw);
  const s = BigInt(`0x${Buffer.from(low.slice(32)).toString("hex")}`);
  const high = new Uint8Array(low); high.set(Buffer.from((order-s).toString(16).padStart(64,"0"),"hex"),32);
  assert.equal(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},pair.publicKey,high,deviceProofSigningInput(input)),true);
  assert.equal(await verifyBoundDeviceProof(spki,input,encodeBase64url(high)),false);
  const wrongCurve = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-384"},true,["sign","verify"]);
  const wrongSpki = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki",wrongCurve.publicKey)));
  await assert.rejects(importBoundDeviceKey(wrongSpki));
  const spkiBytes = new Uint8Array(await crypto.subtle.exportKey("spki",pair.publicKey));
  const trailing = new Uint8Array(spkiBytes.length+1); trailing.set(spkiBytes);
  await assert.rejects(importBoundDeviceKey(encodeBase64url(trailing)));
});

test("signed lease verifies with independent Node crypto and enforces purpose, binding, time and revocation", async () => {
  const pair = await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"}, true, ["sign","verify"]);
  const keyId = await boundLeaseKeyId(pair.publicKey);
  const claims = {version:1,purpose:"device-lease","key-id":keyId,issuer:"https://backend.test",audience:"desktop",project:"CAD",feature:"DEFAULT","license-fingerprint":"b".repeat(64),"binding-id":"A".repeat(22),"device-key-id":`sha256:${"c".repeat(64)}`,generation:1,"revocation-seq":2,"lease-id":"A".repeat(22),"operation-id":"A".repeat(43),"issued-at":1000,"renew-after":1100,"expires-at":1200};
  const token = await signBoundDeviceLease(claims,pair.privateKey,pair.publicKey);
  await assert.rejects(signBoundDeviceLease({...claims,"key-id":`sha256:${"a".repeat(64)}`},pair.privateKey,pair.publicKey),/lease_key_id_mismatch/);
  const decoded = decodeDeviceLeaseEnvelope(token);
  const publicKey = createPublicKey({key:Buffer.from(await crypto.subtle.exportKey("spki",pair.publicKey)),format:"der",type:"spki"});
  assert.equal(nodeVerify("RSA-SHA256",deviceLeaseSigningInput(decoded.payload),publicKey,decoded.signature),true);
  const expected = {...claims,min_revocation_seq:2};
  const trusted = new Map([[keyId,pair.publicKey]]);
  assert.deepEqual(await verifyBoundDeviceLease(token,trusted,expected,1100),claims);
  assert.deepEqual(await verifyBoundDeviceLease(token,trusted,expected,1199),claims);
  for (const time of [999,1200,1320,Infinity]) assert.equal(await verifyBoundDeviceLease(token,trusted,expected,time),null);
  for (const patch of [{project:"OTHER"},{generation:2},{"operation-id":"old"},{min_revocation_seq:3},{"device-key-id":`sha256:${"d".repeat(64)}`}]) assert.equal(await verifyBoundDeviceLease(token,trusted,{...expected,...patch},1100),null);
  assert.equal(await verifyBoundDeviceLease(token,new Map(),expected,1100),null);
  assert.equal(await verifyBoundDeviceLease(token,trusted,{},1100),null);
  // A valid signature does not authorize a mislabeled trust-key registry entry.
  const alias = `sha256:${"a".repeat(64)}`;
  const aliasPayload = encodeDeviceLeasePayload({...claims,"key-id":alias});
  const aliasSignature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,deviceLeaseSigningInput(aliasPayload)));
  assert.equal(await verifyBoundDeviceLease(encodeDeviceLeaseEnvelope(aliasPayload,aliasSignature),new Map([[alias,pair.publicKey]]),expected,1100),null);
  const altered = token.slice(0,-2)+(token.at(-2)==="A"?"B":"A")+token.at(-1);
  assert.equal(await verifyBoundDeviceLease(altered,trusted,expected,1100),null);
  const small = await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},false,["sign","verify"]);
  await assert.rejects(signBoundDeviceLease(claims,small.privateKey,pair.publicKey),/invalid_lease_key/);
});
