import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import { parseBoundJson, readBoundJson, validateBoundRequest, validateBoundClient } from "../src/device/bound_request.mjs";
import { deviceLabelComparisonForm } from "../src/device/device_label.mjs";
import { encodeBase64url, deviceOperationBody, deviceProofSigningInput, decodeDeviceLeaseEnvelope, deviceLeaseSigningInput, deviceEnrollmentComparisonInput, formatDeviceEnrollmentComparison } from "@licensecc/licensing-domain/lease/device_protocol";

const encoded = size => encodeBase64url(new Uint8Array(size).fill(7));
const parse = source => parseBoundJson(new TextEncoder().encode(source));
const enrollment = () => ({ client_id: "desktop", project: "APP", requested_feature: "DEFAULT", public_key_spki: encoded(91), device_label: " My PC ", redirect_uri: "http://127.0.0.1:45678/callback", state: encoded(32), code_challenge: encoded(32), code_challenge_method: "S256" });
test("native registration fixture agrees on request, PKCE and key-bound comparison", async () => {
  const wire = JSON.parse(await readFile(new URL("../../../test/vectors/device_bound/v1/registration_wire.json", import.meta.url), "utf8"));
  const request = validateBoundRequest("authorize", parse(wire.request_json));
  assert.deepEqual(request, wire.request);
  assert.equal(createHash("sha256").update(wire.code_verifier).digest("base64url"), request.code_challenge);
  const key = createPublicKey({ key: Buffer.from(request.public_key_spki, "base64url"), format: "der", type: "spki" });
  assert.equal(key.export({ format: "der", type: "spki" }).toString("base64url"), request.public_key_spki);
  assert.equal("sha256:"+createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex"), wire.key_id);
  const response = parse(wire.response_json).data;
  const input = { attempt_handle: response.attempt_handle, client_id: request.client_id, project: request.project,
    key_id: wire.key_id, redirect_uri: request.redirect_uri, state: request.state, code_challenge: request.code_challenge,
    requested_feature: request.requested_feature };
  assert.equal(formatDeviceEnrollmentComparison(createHash("sha256").update(deviceEnrollmentComparisonInput(input)).digest()), response.comparison_code);
  assert.equal(validateBoundRequest("authorize", { ...request, device_label: "\ufeff \t"+request.device_label+"\u3000\r\n" }).device_label, request.device_label);
  assert.throws(() => validateBoundRequest("authorize", { ...request, device_label: " \t\r\n\u00a0\u2028" }));
});
test("native exchange wire passes backend parsing and independent proof verification", async () => {
  const root = new URL("../../../test/vectors/device_bound/v1/", import.meta.url);
  const [vector, wire] = await Promise.all(["exchange.json", "exchange_wire.json"].map(async name => JSON.parse(await readFile(new URL(name, root), "utf8"))));
  const challenge = validateBoundRequest("challenge", parse(wire.challenge_request));
  const request = validateBoundRequest("exchange", parse(wire.exchange_request));
  const { proof: signature, ...body } = request;
  assert.deepEqual(body, vector.body);
  assert.equal(challenge.attempt_handle, body.attempt_handle);
  assert.equal(challenge.operation_id, body.operation_id);
  const key = createPublicKey({ key: Buffer.from(vector.device_spki, "base64url"), format: "der", type: "spki" });
  const intent = actual => ({ audience: vector.proof.audience, method: "POST", path: "/v2/device-authorizations/exchange",
    key_id: signature.key_id, operation_id: actual.operation_id, challenge_id: signature.challenge_id, nonce: signature.nonce,
    expires_at: signature.expires_at, body_sha256: createHash("sha256").update(deviceOperationBody("exchange", actual)).digest("hex") });
  const verifyBody = actual => verify("sha256", deviceProofSigningInput(intent(actual)), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature.signature, "base64url"));
  assert.equal(verifyBody(body), true);
  assert.equal(verifyBody({ ...body, redirect_uri: "http://127.0.0.1:45232/licensecc/callback" }), false);
  assert.equal(verifyBody({ ...body, code_verifier: encoded(32) }), false);
});
const proof = () => ({ key_id: `sha256:${"a".repeat(64)}`, challenge_id: encoded(16), nonce: encoded(32), expires_at: 1000, signature: encoded(64) });
const renewal = () => ({ binding_id: encoded(16), generation: 1, operation_id: encoded(32), proof: proof() });

test("native renewal wire vectors pass backend parsing and independent signature verification", async () => {
  const root = new URL("../../../test/vectors/device_bound/v1/", import.meta.url);
  const wire = JSON.parse(await readFile(new URL("renewal_wire.json", root), "utf8"));
  const vector = JSON.parse(await readFile(new URL("protocol.json", root), "utf8"));
  const challenge = validateBoundRequest("challenge", parse(wire.challenge_request));
  const request = validateBoundRequest("renew", parse(wire.renew_request));
  const { proof: signature, ...body } = request;
  assert.deepEqual(body, vector.body);
  assert.equal(challenge.binding_id, body.binding_id);
  assert.equal(challenge.operation_id, body.operation_id);
  const intent = { audience: vector.proof.audience, method: "POST", path: "/v2/device-leases/renew",
    key_id: signature.key_id, operation_id: body.operation_id, challenge_id: signature.challenge_id,
    nonce: signature.nonce, expires_at: signature.expires_at,
    body_sha256: createHash("sha256").update(deviceOperationBody("renew", body)).digest("hex") };
  const publicKey = createPublicKey({ key: Buffer.from(vector.device_spki, "base64url"), format: "der", type: "spki" });
  assert.equal(verify("sha256", deviceProofSigningInput(intent), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature.signature, "base64url")), true);
  const changed = validateBoundRequest("renew", parse(wire.renew_request.replace(signature.nonce, "A".repeat(43))));
  assert.equal(verify("sha256", deviceProofSigningInput({ ...intent, nonce: changed.proof.nonce }), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(changed.proof.signature, "base64url")), false);
  const response = parse(wire.renew_response);
  const lease = decodeDeviceLeaseEnvelope(response.data.lease);
  const signer = createPublicKey({ key: Buffer.from(vector.lease_signer_spki, "base64url"), format: "der", type: "spki" });
  assert.equal(verify("RSA-SHA256", deviceLeaseSigningInput(lease.payload), signer, lease.signature), true);
  assert.equal(response.data.accept_until, vector.claims["expires-at"] + 120);
  assert.deepEqual(parse(wire.challenge_response).data, { challenge_id: signature.challenge_id, nonce: signature.nonce, expires_at: signature.expires_at });
});

test("strict JSON rejects duplicate decoded keys at every object depth", () => {
  for (const source of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"proof":{"nonce":1,"nonce":2}}', '{"array":[{"x":1,"x":2}]}']) {
    assert.throws(() => parse(source), /invalid_request/);
  }
  assert.deepEqual(parse('{"a":{"x":1},"b":{"x":2},"text":"a \\\" colon: {}"}'), { a: { x: 1 }, b: { x: 2 }, text: 'a " colon: {}' });
});

test("strict JSON rejects invalid Unicode, syntax, nonobjects and excessive depth", () => {
  for (const source of ['{"x":"\\ud800"}', '{"\\udfff":1}', '\ufeff{}', 'null', '[]', '{"x":NaN}', '{"a":1,}', '{"a":' + '['.repeat(8) + '0' + ']'.repeat(8) + '}']) {
    assert.throws(() => parse(source), /invalid_request/);
  }
  assert.throws(() => parseBoundJson(new Uint8Array([123, 34, 120, 34, 58, 34, 0xff, 34, 125])), /invalid_request/);
  assert.deepEqual(parse('{"x":"\\ud83d\\ude80"}'), { x: "🚀" });
  assert.throws(() => parseBoundJson(new Uint8Array(16385)), /invalid_request/);
});

test("request reader bounds actual streamed bytes and cancels overflow", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundJson(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body, duplex: "half" })), /invalid_request/);
  assert.equal(cancelled, true);
  for (const headers of [{}, { "content-type": "text/plain" }, { "content-type": "application/json", "content-encoding": "gzip" }, { "content-type": "application/json", "content-length": "16385" }]) {
    await assert.rejects(readBoundJson(new Request("https://example.test", { method: "POST", headers, body: "{}" })), /invalid_request/);
  }
  assert.deepEqual(await readBoundJson(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: "{}" })), {});
});

test("overflow rejection does not wait for cancellation; empty chunks consume no retained storage", async () => {
  const stalled = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { return new Promise(() => {}); } });
  await assert.rejects(readBoundJson(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: stalled, duplex: "half" })), /invalid_request/);
  let remaining = 100;
  const empty = new ReadableStream({ pull(controller) {
    if (remaining-- > 0) controller.enqueue(new Uint8Array());
    else { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
  } });
  assert.deepEqual(await readBoundJson(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: empty, duplex: "half" })), {});
});

test("integer lexemes cannot acquire authority by JSON rounding", () => {
  for (const value of ["1.0000000000000001", "9007199254740991.1", "9007199254740992", "1e0", "1.0", "-0", "-1"]) {
    for (const source of [`{"generation":${value}}`, `{"proof":{"expires_at":${value}}}`]) assert.throws(() => parse(source), /invalid_request/);
  }
  assert.deepEqual(parse('{"generation":9007199254740991}'), { generation: Number.MAX_SAFE_INTEGER });
});

test("request reader accepts the exact byte limit with split UTF-8 and handles stream failures", async () => {
  const source = new TextEncoder().encode(JSON.stringify({ x: "a".repeat(16372) + "🚀" }));
  assert.equal(source.length, 16384);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(source.subarray(0, 16379));
    controller.enqueue(source.subarray(16379)); controller.close();
  } });
  const request = body => new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" });
  assert.equal((await readBoundJson(request(stream))).x, "a".repeat(16372) + "🚀");
  await assert.rejects(readBoundJson(request(new ReadableStream({ pull() { throw new Error("private stream failure"); } }))), error => error.message === "invalid_request");
  await assert.rejects(readBoundJson(request(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { throw new Error("private cancel failure"); } }))), error => error.message === "invalid_request");
});

test("enrollment validates exact schema, canonical secrets and trimmed Unicode label", () => {
  assert.equal(validateBoundRequest("authorize", enrollment()).device_label, "My PC");
  for (const patch of [{ extra: 1 }, { state: encoded(16) }, { state: encoded(32) + "=" }, { code_challenge_method: "plain" }, { public_key_spki: "a".repeat(513) }, { device_label: " " }, { device_label: "🚀".repeat(81) }, { project: "bad project" }]) {
    assert.throws(() => validateBoundRequest("authorize", { ...enrollment(), ...patch }));
  }
  assert.equal(validateBoundRequest("authorize", { ...enrollment(), device_label: "🚀".repeat(80) }).device_label.length, 160);
});

// The approval page shows the label beside the real comparison code, so a label may not break
// lines, reorder or hide text, or carry a code of its own for the approver to match.
const MISLEADING_LABELS = {
  "a C0 control": "My\u0007PC",
  "a line feed inside": "My PC\nApproved",
  "a carriage return inside": "My\rPC",
  "a tab inside": "My\tPC",
  "a delete control": "My\u007fPC",
  "a C1 control": "My\u0085PC",
  "the last C1 control": "My\u009fPC",
  "a line separator": "My\u2028PC",
  "a paragraph separator": "My\u2029PC",
  "a zero-width space": "My\u200bPC",
  "a left-to-right mark": "\u200eMy PC",
  "a right-to-left mark": "My\u200fPC",
  "a bidi embedding": "My\u202aPC",
  "a bidi override": "PC\u202emy",
  "a word joiner": "My\u2060PC",
  "an invisible separator": "My\u2064PC",
  "a bidi isolate": "My\u2066PC",
  "a pop directional isolate": "My\u2069PC",
  "a byte order mark inside": "My\ufeffPC",
  "a comparison code": "code 4F2A-0C12-B7E4 matches",
  "a lowercase comparison code": "pick 4f2a-0c12-b7e4",
  "a comparison code inside a word": "PC4F2A-0C12-B7E4X",
};

test("a device label that could mislead the approver is refused at registration", () => {
  for (const [label, device_label] of Object.entries(MISLEADING_LABELS)) {
    assert.throws(
      () => validateBoundRequest("authorize", { ...enrollment(), device_label }),
      error => error.code === "invalid_request" && error.status === 400,
      label,
    );
  }
});

// A label may not hide a comparison code behind a character that renders as nothing, or spell one
// with other dashes, spaces or fullwidth forms. Built from code points so no escape is lost.
const cp = (...points) => String.fromCodePoint(...points);
const fullwidth = text => [...text].map(c => cp(c.codePointAt(0) + 0xfee0)).join("");
const HIDDEN_OR_LOOKALIKE_LABELS = {
  "a soft hyphen inside a code": `4F2A${cp(0xad)}-0C12-B7E4`,
  "a combining grapheme joiner inside a code": `4F2A-0C12-B${cp(0x34f)}7E4`,
  "a variation selector inside a code": `4F2A-0C12-B7E${cp(0xfe0f)}4`,
  "a tag character inside a code": `4F2A-0C12-B7${cp(0xe0041)}E4`,
  "an inhibit symmetric swapping control": `My${cp(0x206a)}PC`,
  "an interlinear annotation anchor": `My${cp(0xfff9)}PC`,
  "an Arabic letter mark": `My${cp(0x61c)}PC`,
  "a Hangul filler": `My${cp(0x3164)}PC`,
  "a code separated by en dashes": `4F2A${cp(0x2013)}0C12${cp(0x2013)}B7E4`,
  "a code separated by spaces": "4F2A 0C12 B7E4",
  "a code separated by spaced em dashes": `4F2A ${cp(0x2014)} 0C12 ${cp(0x2014)} B7E4`,
  "a code separated by no-break spaces": `4F2A${cp(0xa0)}0C12${cp(0xa0)}B7E4`,
  "a code in fullwidth digits, letters and dashes": fullwidth("4F2A-0C12-B7E4"),
  "a code in fullwidth digits with ASCII dashes": `${fullwidth("4F2A")}-${fullwidth("0C12")}-${fullwidth("B7E4")}`,
};

test("a device label cannot hide a comparison code behind invisible characters or look-alike separators", () => {
  for (const [label, device_label] of Object.entries(HIDDEN_OR_LOOKALIKE_LABELS)) {
    assert.throws(
      () => validateBoundRequest("authorize", { ...enrollment(), device_label }),
      error => error.code === "invalid_request" && error.status === 400,
      label,
    );
  }
});

test("a device label still accepts letters, digits, spaces and punctuation in any script", () => {
  for (const device_label of ["Büro-PC", "工作站", "DESKTOP-7Q2K1AB", "Ana's MacBook Pro (2024)", "build-01.example.com", "ПК №12", "Room 4F2A-0C12",
    "📎 Laptop", `Studio ${cp(0x2013)} Mac`, `Lab PC${cp(0xa0)}12`, fullwidth("PC12")]) {
    assert.equal(validateBoundRequest("authorize", { ...enrollment(), device_label }).device_label, device_label, device_label);
  }
  // Surrounding whitespace is still trimmed before the rule applies.
  assert.equal(validateBoundRequest("authorize", { ...enrollment(), device_label: "\ufeff\t Büro-PC \r\n" }).device_label, "Büro-PC");
});

// A label may not spell a comparison code with characters from other scripts whose Unicode
// confusable prototype is a code digit, letter or dash.
const CROSS_SCRIPT_LABELS = {
  "a Cyrillic capital A (U+0410) in a code": `4F2${cp(0x410)}-0C12-B7E4`,
  "a Greek capital Alpha (U+0391) in a code": `4F2${cp(0x391)}-0C12-B7E4`,
  "a Cyrillic small a (U+0430) in a code": `4f2${cp(0x430)}-0c12-b7e4`,
  "a mathematical bold digit four (U+1D7D2) in a code": `${cp(0x1d7d2)}F2A-0C12-B7E4`,
  "a code mixing Latin, Cyrillic, Greek and mathematical characters": `${cp(0x1d7d2)}F2${cp(0x410)}-0${cp(0x421)}12-${cp(0x392)}7${cp(0x415)}4`,
  "a code separated by minus signs (U+2212)": `4F2A${cp(0x2212)}0C12${cp(0x2212)}B7E4`,
};

test("a device label cannot spell a comparison code with look-alike characters from other scripts", () => {
  for (const [label, device_label] of Object.entries(CROSS_SCRIPT_LABELS)) {
    assert.throws(
      () => validateBoundRequest("authorize", { ...enrollment(), device_label }),
      error => error.code === "invalid_request" && error.status === 400,
      label,
    );
  }
  // The comparison form folds each look-alike to the code character it imitates.
  assert.equal(deviceLabelComparisonForm(CROSS_SCRIPT_LABELS["a code mixing Latin, Cyrillic, Greek and mathematical characters"]), "4F2A-0C12-B7E4");
  assert.equal(deviceLabelComparisonForm(`${cp(0x430)}${cp(0x2212)} ${cp(0x2010)}x`), "a-x");
});

test("a device label still accepts ordinary names in scripts that have code look-alikes", () => {
  for (const device_label of ["Компьютер", "Δέλτα-PC", "工作站", "Büro-PC", "DESKTOP-7Q2K1AB"]) {
    assert.equal(validateBoundRequest("authorize", { ...enrollment(), device_label }).device_label, device_label, device_label);
  }
});

test("an authorization without requested_feature is refused", () => {
  const request = enrollment();
  delete request.requested_feature;
  assert.throws(() => validateBoundRequest("authorize", request), error => error.code === "invalid_request" && error.status === 400);
  for (const requested_feature of [null, "", 7, "TOO_LONG_FEATURE", "bad feature"]) {
    assert.throws(() => validateBoundRequest("authorize", { ...request, requested_feature }), error => error.code === "invalid_request" && error.status === 400);
  }
  assert.equal(validateBoundRequest("authorize", { ...request, requested_feature: "EXPORT" }).requested_feature, "EXPORT");
});

test("callback policy rejects normalization tricks and unregistered apps or destinations", () => {
  const registry = [{ client_id: "desktop", project: "APP", callbacks: [{ host: "127.0.0.1", path: "/callback" }, { host: "[::1]", path: "/callback" }] }];
  for (const uri of ["http://127.0.0.1:45678/callback", "http://[::1]:56789/callback"]) {
    const request = validateBoundRequest("authorize", { ...enrollment(), redirect_uri: uri });
    assert.equal(validateBoundClient(request, registry), registry[0]);
  }
  for (const uri of ["http://localhost:1234/callback", "http://127.1:1234/callback", "http://2130706433:1234/callback", "http://127.0.0.1:1234/../callback", "http://user@127.0.0.1:1234/callback", "https://127.0.0.1:1234/callback", "http://127.0.0.1:1234/callback?x=1", "http://127.0.0.1:1234/callback#x", "http://127.0.0.1:65536/callback", "http://127.0.0.1:0/callback", "http://192.168.1.1:1234/callback", "http://127.0.0.1:1234/other", "http://127.0.0.1:1234/%63allback"]) {
    assert.throws(() => validateBoundClient(validateBoundRequest("authorize", { ...enrollment(), redirect_uri: uri }), registry));
  }
  assert.throws(() => validateBoundClient({ ...enrollment(), project: "OTHER" }, registry), /access_denied/);
  assert.throws(() => validateBoundClient({ ...enrollment(), client_id: "unknown" }, registry), /access_denied/);
  for (const suffix of ["?", "#"]) assert.throws(() => validateBoundRequest("authorize", { ...enrollment(), redirect_uri: enrollment().redirect_uri + suffix }), /invalid_request/);
});

test("proof requests enforce exact intent, identifier widths and safe generations", () => {
  assert.deepEqual(validateBoundRequest("renew", renewal()), renewal());
  const exchange = { attempt_handle: encoded(32), code: encoded(32), code_verifier: encoded(32), redirect_uri: enrollment().redirect_uri, operation_id: encoded(32), proof: proof() };
  assert.deepEqual(validateBoundRequest("exchange", exchange), exchange);
  for (const patch of [{ generation: 0 }, { generation: 1.5 }, { generation: 2 ** 53 }, { operation_id: encoded(16) }, { binding_id: encoded(32) }, { proof: { ...proof(), extra: 1 } }, { proof: { ...proof(), signature: encoded(63) } }]) {
    assert.throws(() => validateBoundRequest("renew", { ...renewal(), ...patch }), /invalid_request/);
  }
  const { proof: omitted, ...missing } = renewal();
  assert.ok(omitted);
  assert.throws(() => validateBoundRequest("renew", missing), error => error.status === 401 && error.code === "proof_required");
  for (const purpose of ["exchange", "renew"]) {
    const subject = purpose === "exchange" ? { attempt_handle: encoded(32) } : { binding_id: encoded(16) };
    assert.doesNotThrow(() => validateBoundRequest("challenge", { purpose, ...subject, operation_id: encoded(32) }));
    assert.throws(() => validateBoundRequest("challenge", { purpose, ...subject, operation_id: encoded(32), generation: 1 }));
  }
});
