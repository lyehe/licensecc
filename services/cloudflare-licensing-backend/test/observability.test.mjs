import assert from "node:assert/strict";
import { test } from "node:test";

import { logEvent } from "../dist/observability/index.js";

function capture(method, action) {
  const original = console[method];
  const lines = [];
  console[method] = (line) => lines.push(line);
  try {
    action();
  } finally {
    console[method] = original;
  }
  return lines;
}

test("structured logs retain operational fields and drop sensitive or unbounded values", () => {
  const lines = capture("error", () => logEvent("error", "verify.d1_error", {
    request_id: `ray\n${"r".repeat(300)}`,
    d1_duration_ms: 42,
    invalid_config_modes: ["REQUEST_SIGNATURE_MODE"],
    license_fingerprint: "a".repeat(64),
    client_ip: "192.0.2.1",
    token: "must-not-appear",
    payload: { assertion: "must-not-appear" },
  }));

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, "verify.d1_error");
  assert.equal(parsed.severity, "error");
  assert.equal(parsed.d1_duration_ms, 42);
  assert.deepEqual(parsed.invalid_config_modes, ["REQUEST_SIGNATURE_MODE"]);
  assert.equal(parsed.request_id.includes("\n"), false);
  assert.equal(parsed.request_id.length, 256);
  assert.equal(parsed.license_fingerprint, undefined);
  assert.equal(parsed.client_ip, undefined);
  assert.equal(parsed.token, undefined);
  assert.equal(parsed.payload, undefined);
  assert.doesNotMatch(lines[0], /must-not-appear|192\.0\.2\.1|a{32}/u);
});

test("structured logs use the selected console severity and neutralize invalid event names", () => {
  assert.equal(capture("log", () => logEvent("info", "verify.ok", { success: true })).length, 1);
  assert.equal(capture("warn", () => logEvent("warn", "verify.denied", { success: false })).length, 1);
  const line = capture("error", () => logEvent("error", "TOKEN=value", { error: "secret" }))[0];
  assert.deepEqual(JSON.parse(line), {
    event: "observability.invalid_event_name",
    severity: "error",
  });
});

test("structured logs classify error_type through a closed safe taxonomy", () => {
  const customName = "DatabaseError: authorization=must-not-appear";
  const customLine = capture("error", () => logEvent("error", "verify.d1_error", {
    error_type: customName,
  }))[0];
  const knownLine = capture("error", () => logEvent("error", "verify.d1_error", {
    error_type: "TypeError",
  }))[0];

  assert.equal(JSON.parse(customLine).error_type, "Error");
  assert.doesNotMatch(customLine, /authorization|must-not-appear/u);
  assert.equal(JSON.parse(knownLine).error_type, "TypeError");
});
