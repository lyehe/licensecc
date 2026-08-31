import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverWebhooks,
  enqueueWebhooks,
  WEBHOOK_CLAIM_TTL_SECONDS,
  WEBHOOK_ERROR_BODY_MAX_BYTES,
} from "../src/webhooks/webhook.mjs";

const SECRET_B64 = Buffer.alloc(32, 7).toString("base64");
const SIGNING_ENV = {
  WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k1: SECRET_B64 }),
  WEBHOOK_SIGNING_KEY_ID: "k1",
};

function makeDelivery(overrides = {}) {
  return {
    id: 17,
    endpoint_id: "ep1",
    event_source: "customer",
    event_id: 1,
    event_type: "disable",
    payload_json: '{"ok":true}',
    attempts: 0,
    url: "https://hook.test/ep1",
    ...overrides,
  };
}

function makeEnvironment(overrides = {}) {
  const row = makeDelivery(overrides.delivery);
  const state = { ...row, last_status: 0, last_error: "", next_attempt_at: 0, status: "pending" };
  const control = { updateError: overrides.updateError, claimError: overrides.claimError };
  const db = {
    prepare(sql) {
      if (sql.includes("FROM webhook_deliveries")) {
        return {
          bind(now) {
            return {
              all: async () => ({
                results: state.status === "pending" && state.next_attempt_at <= now ? [state] : [],
              }),
            };
          },
        };
      }
      if (sql.startsWith("UPDATE webhook_deliveries")) {
        return {
          bind(...values) {
            if (sql.startsWith("UPDATE webhook_deliveries SET next_attempt_at = ?")) {
              return {
                first: async () => {
                  if (control.claimError !== undefined) throw control.claimError;
                  const [claimUntil, id, dueAt] = values;
                  if (state.id !== id || state.status !== "pending" || state.next_attempt_at > dueAt) return null;
                  state.next_attempt_at = claimUntil;
                  return { id };
                },
              };
            }
            return {
              first: async () => {
                if (control.updateError !== undefined) throw control.updateError;
                let id = values[4];
                if (sql.includes("status = 'delivered'")) id = values[2];
                else if (sql.includes("status = 'failed'")) id = values[3];
                const expectedClaimUntil = values.at(-1);
                if (state.id !== id || state.status !== "pending" || state.next_attempt_at !== expectedClaimUntil) return null;
                if (sql.includes("status = 'delivered'")) {
                  state.status = "delivered";
                  state.attempts += 1;
                  state.last_status = values[0];
                  state.last_error = "";
                  state.delivered_at = values[1];
                } else if (sql.includes("status = 'failed'")) {
                  state.status = "failed";
                  state.attempts = values[0];
                  state.last_status = values[1];
                  state.last_error = values[2];
                } else {
                  state.attempts = values[0];
                  state.last_status = values[1];
                  state.last_error = values[2];
                  state.next_attempt_at = values[3];
                }
                return { id };
              },
            };
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { env: { ...SIGNING_ENV, ...overrides.env, DB: db }, state, control };
}

function streamedResponse(
  chunks,
  { status = 500, keepOpen = false, error, cancelError, headers = new Headers() } = {},
) {
  const encoder = new TextEncoder();
  let index = 0;
  let reads = 0;
  let cancelAttempts = 0;
  let cancelled = false;
  let cancelReason;
  let textCalls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        if (error !== undefined) {
          controller.error(error);
        } else if (!keepOpen) {
          controller.close();
        }
        return;
      }
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  });
  const body = {
    cancel(reason) {
      cancelAttempts += 1;
      if (cancelError !== undefined) throw cancelError;
      return stream.cancel(reason);
    },
    getReader() {
      const reader = stream.getReader();
      return {
        async read() {
          reads += 1;
          return reader.read();
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
        releaseLock() {
          reader.releaseLock();
        },
      };
    },
  };
  return {
    status,
    headers,
    body,
    async text() {
      textCalls += 1;
      const reader = body.getReader();
      const values = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          values.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0));
      let offset = 0;
      for (const value of values) {
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      return new TextDecoder().decode(bytes);
    },
    get reads() {
      return reads;
    },
    get cancelAttempts() {
      return cancelAttempts;
    },
    get cancelled() {
      return cancelled;
    },
    get cancelReason() {
      return cancelReason;
    },
    get textCalls() {
      return textCalls;
    },
  };
}

async function deliverWith(fetchResult, overrides = {}) {
  return deliverWithFetcher(async () => fetchResult, overrides);
}

async function deliverWithFetcher(fetcher, overrides = {}) {
  const { env, state } = makeEnvironment(overrides);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await deliverWebhooks(env, 200, () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  return state;
}

test("redirect responses are handled manually without forwarding signed requests", async () => {
  const redirectStatuses = [301, 302, 303, 307, 308];
  const crossOrigin = "https://attacker.example/steal";

  for (const status of redirectStatuses) {
    const calls = [];
    const response = streamedResponse(
      ["x".repeat(WEBHOOK_ERROR_BODY_MAX_BYTES + 1)],
      { status, keepOpen: true, headers: new Headers({ Location: crossOrigin }) },
    );
    const state = await deliverWithFetcher(async (url, init) => {
      calls.push({ url, init });
      return response;
    });

    assert.equal(response.headers.get("location"), crossOrigin);
    assert.equal(calls.length, 1, `redirect ${status} must not issue a second request`);
    assert.equal(calls[0].url, "https://hook.test/ep1");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, '{"ok":true}');
    assert.equal(calls[0].init.headers["Licensecc-Webhook-Id"], "17");
    assert.equal(calls[0].init.headers["Licensecc-Event-Source"], "customer");
    assert.match(calls[0].init.headers["Licensecc-Signature"], /^t=200,keyid=k1,v1=[0-9a-f]{64}$/);
    assert.equal(response.reads, 1);
    assert.equal(response.cancelled, true);
    assert.equal(state.status, "pending");
    assert.equal(state.attempts, 1);
    assert.equal(state.last_status, status);
    assert.equal(state.last_error, "x".repeat(256));
  }
});

test("non-2xx diagnostic at the byte cap preserves the 256-character shape", async () => {
  const response = streamedResponse(["x".repeat(WEBHOOK_ERROR_BODY_MAX_BYTES)]);
  const state = await deliverWith(response);

  assert.equal(response.reads, 1);
  assert.equal(response.textCalls, 0);
  assert.equal(state.last_error, "x".repeat(256));
  assert.equal(state.last_error.length, 256);
});

test("non-2xx diagnostic cancels an oversized chunked response at the byte cap", async () => {
  const response = streamedResponse([
    "a".repeat(WEBHOOK_ERROR_BODY_MAX_BYTES - 1),
    "b",
    "c".repeat(10_000),
  ]);
  const state = await deliverWith(response);

  assert.equal(response.reads, 2);
  assert.equal(response.textCalls, 0);
  assert.equal(response.cancelled, true);
  assert.ok(response.cancelReason !== undefined);
  assert.equal(state.last_error, "a".repeat(256));
});

test("normal UTF-8 diagnostics retain the existing 256-character truncation", async () => {
  const state = await deliverWith(streamedResponse(["é".repeat(300)]));

  assert.equal(state.last_error, "é".repeat(256));
});

test("empty and erroring response bodies remain retryable with an empty diagnostic", async () => {
  const empty = await deliverWith({ status: 503, body: null, text: async () => "" });
  assert.equal(empty.last_error, "");
  assert.equal(empty.attempts, 1);

  const erroring = streamedResponse([], { error: new Error("body read failed") });
  const errored = await deliverWith(erroring);
  assert.equal(errored.last_error, "");
  assert.equal(errored.attempts, 1);
});

test("malformed UTF-8 is decoded deterministically in the diagnostic", async () => {
  const response = streamedResponse([new Uint8Array([0xe2, 0x28, 0xa1])]);
  const state = await deliverWith(response);

  assert.equal(state.last_error, "�(�");
});

test("fetch errors retain timeout/retry behavior", async () => {
  const { env, state } = makeEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down / aborted");
  };
  try {
    await deliverWebhooks(env, 200, () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(state.status, "pending");
  assert.equal(state.attempts, 1);
  assert.match(state.last_error, /network down|aborted/);
});

test("successful responses cancel an endless body before committing delivery", async () => {
  const response = streamedResponse([], { status: 204, keepOpen: true });
  const calls = [];
  const state = await deliverWithFetcher(async (url, init) => {
    calls.push({ url, init });
    return response;
  });

  assert.equal(calls.length, 1);
  assert.equal(state.status, "delivered");
  assert.equal(state.last_status, 204);
  assert.equal(state.attempts, 1);
  assert.equal(state.next_attempt_at, 200 + WEBHOOK_CLAIM_TTL_SECONDS);
  assert.equal(state.last_error, "");
  assert.equal(response.reads, 0);
  assert.equal(response.cancelAttempts, 1);
  assert.equal(response.cancelled, true);
});

test("successful responses remain delivered when body cancellation throws", async () => {
  const response = streamedResponse([], {
    status: 200,
    keepOpen: true,
    cancelError: new Error("body cancel failed"),
  });
  const calls = [];
  const state = await deliverWithFetcher(async (url, init) => {
    calls.push({ url, init });
    return response;
  });

  assert.equal(calls.length, 1);
  assert.equal(state.status, "delivered");
  assert.equal(state.last_status, 200);
  assert.equal(state.attempts, 1);
  assert.equal(state.next_attempt_at, 200 + WEBHOOK_CLAIM_TTL_SECONDS);
  assert.equal(state.last_error, "");
  assert.equal(response.reads, 0);
  assert.equal(response.cancelAttempts, 1);
  assert.equal(response.cancelled, false);
});

test("overlapping dispatchers atomically lease one pending delivery before fetch", async () => {
  const { env, state } = makeEnvironment();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };
  try {
    await Promise.all([
      deliverWebhooks(env, 200, () => {}),
      deliverWebhooks(env, 200, () => {}),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 1);
  assert.equal(state.status, "delivered");
  assert.equal(state.attempts, 1);
});

test("delayed multi-row delivery refreshes claim, signature, completion, and retry clocks", async () => {
  const rows = [
    makeDelivery({ id: 17, event_id: 1 }),
    makeDelivery({ id: 18, event_id: 2, url: "https://hook.test/ep2" }),
  ].map((row) => ({ ...row, next_attempt_at: 0, status: "pending" }));
  const claims = [];
  const outcomes = [];
  const env = {
    ...SIGNING_ENV,
    DB: {
      prepare(sql) {
        if (sql.includes("FROM webhook_deliveries")) {
          return {
            bind: (dueAt) => ({
              all: async () => ({ results: rows.filter((row) => row.next_attempt_at <= dueAt) }),
            }),
          };
        }
        if (!sql.startsWith("UPDATE webhook_deliveries")) throw new Error(`unexpected SQL: ${sql}`);
        return {
          bind(...values) {
            if (sql.startsWith("UPDATE webhook_deliveries SET next_attempt_at = ?")) {
              return {
                first: async () => {
                  const [claimUntil, id, dueAt] = values;
                  claims.push({ id, dueAt, claimUntil });
                  return { id };
                },
              };
            }
            return {
              first: async () => {
                if (sql.includes("status = 'delivered'")) {
                  outcomes.push({ id: values[2], completedAt: values[1], status: "delivered" });
                  return { id: values[2] };
                }
                outcomes.push({ id: values[4], retryAt: values[3], status: "pending" });
                return { id: values[4] };
              },
            };
          },
        };
      },
    },
  };
  const clockValues = [200, 207, 400, 406];
  const signatures = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    signatures.push(init.headers["Licensecc-Signature"]);
    return new Response(null, { status: url.endsWith("ep1") ? 204 : 503 });
  };
  try {
    await deliverWebhooks(env, 100, () => {}, () => clockValues.shift());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(clockValues, []);
  assert.deepEqual(claims, [
    { id: 17, dueAt: 200, claimUntil: 200 + WEBHOOK_CLAIM_TTL_SECONDS },
    { id: 18, dueAt: 400, claimUntil: 400 + WEBHOOK_CLAIM_TTL_SECONDS },
  ]);
  assert.deepEqual(signatures.map((header) => header.match(/^t=(\d+),/u)?.[1]), ["200", "400"]);
  assert.deepEqual(outcomes, [
    { id: 17, completedAt: 207, status: "delivered" },
    { id: 18, retryAt: 436, status: "pending" },
  ]);
});

test("a post-send persistence failure retries only after the lease and keeps a stable dedupe id", async () => {
  const { env, state, control } = makeEnvironment({ updateError: new Error("simulated post-send crash") });
  const originalFetch = globalThis.fetch;
  const dedupeKeys = [];
  globalThis.fetch = async (url, init) => {
    dedupeKeys.push(`${init.headers["Licensecc-Event-Source"]}:${init.headers["Licensecc-Webhook-Id"]}`);
    return new Response(null, { status: 204 });
  };
  try {
    await deliverWebhooks(env, 200, () => {});
    assert.equal(state.status, "pending");
    assert.equal(state.next_attempt_at, 200 + WEBHOOK_CLAIM_TTL_SECONDS);
    control.updateError = undefined;
    await deliverWebhooks(env, 200 + WEBHOOK_CLAIM_TTL_SECONDS - 1, () => {});
    assert.equal(dedupeKeys.length, 1, "the active lease suppresses premature redelivery");
    await deliverWebhooks(env, 200 + WEBHOOK_CLAIM_TTL_SECONDS, () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(dedupeKeys, ["customer:17", "customer:17"]);
  assert.equal(state.status, "delivered");
  assert.equal(state.attempts, 1);
});

test("endpoint discovery failures emit fixed safe enqueue telemetry and remain no-throw", async () => {
  const secretMessage = `fingerprint=${"f".repeat(64)}`;
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM webhook_endpoints/u);
        return {
          all: async () => {
            throw new TypeError(secretMessage);
          },
        };
      },
    },
  };
  const events = [];

  await assert.doesNotReject(enqueueWebhooks(env, 200, (severity, event, fields) => {
    events.push({ severity, event, fields });
  }));
  assert.deepEqual(events, [{
    severity: "error",
    event: "webhook.enqueue_error",
    fields: { source: "endpoints", error_type: "TypeError" },
  }]);
  assert.doesNotMatch(JSON.stringify(events), /fingerprint|f{64}/u);
  await assert.doesNotReject(enqueueWebhooks(env, 200, () => {
    throw new Error("logger unavailable");
  }));

  const namedSecret = new Error("safe message");
  namedSecret.name = "CustomerSecretSentinel";
  const customNameEvents = [];
  await enqueueWebhooks({
    DB: {
      prepare: () => ({ all: async () => { throw namedSecret; } }),
    },
  }, 200, (severity, event, fields) => customNameEvents.push({ severity, event, fields }));
  assert.deepEqual(customNameEvents, [{
    severity: "error",
    event: "webhook.enqueue_error",
    fields: { source: "endpoints", error_type: "Error" },
  }]);
  assert.doesNotMatch(JSON.stringify(customNameEvents), /CustomerSecretSentinel/u);
});

test("one event-source enqueue failure is observable without blocking later sources", async () => {
  const cursorSources = [];
  const events = [];
  const env = {
    DB: {
      prepare(sql) {
        if (sql.includes("FROM webhook_endpoints")) {
          return { all: async () => ({ results: [{ id: "ep1" }] }) };
        }
        if (sql.includes("FROM webhook_cursor")) {
          return {
            bind(source) {
              cursorSources.push(source);
              return {
                first: async () => {
                  if (source === "entitlement") throw new RangeError("sensitive enqueue detail");
                  return null;
                },
              };
            },
          };
        }
        if (sql.includes("FROM customer_events") || sql.includes("FROM order_events")) {
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    },
  };

  await assert.doesNotReject(enqueueWebhooks(env, 200, (severity, event, fields) => {
    events.push({ severity, event, fields });
  }));
  assert.deepEqual(cursorSources, ["entitlement", "customer", "order"]);
  assert.deepEqual(events, [{
    severity: "error",
    event: "webhook.enqueue_error",
    fields: { source: "entitlement", error_type: "RangeError" },
  }]);
});

test("due-delivery query failures emit fixed safe delivery telemetry and remain no-throw", async () => {
  const secretMessage = `token=${"s".repeat(80)}`;
  const env = {
    ...SIGNING_ENV,
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM webhook_deliveries/u);
        return {
          bind: () => ({
            all: async () => {
              throw new SyntaxError(secretMessage);
            },
          }),
        };
      },
    },
  };
  const events = [];

  await assert.doesNotReject(deliverWebhooks(env, 200, (severity, event, fields) => {
    events.push({ severity, event, fields });
  }));
  assert.deepEqual(events, [{
    severity: "error",
    event: "webhook.deliver_error",
    fields: { source: "pending_deliveries", error_type: "SyntaxError" },
  }]);
  assert.doesNotMatch(JSON.stringify(events), /token|s{80}/u);
  await assert.doesNotReject(deliverWebhooks({}, 200, () => {
    throw new Error("logger unavailable");
  }));
});

test("delivery outcome persistence failures emit safe telemetry without escaping", async () => {
  const secretMessage = `payload=${"p".repeat(80)}`;
  const { env, state } = makeEnvironment({ updateError: new TypeError(secretMessage) });
  const originalFetch = globalThis.fetch;
  const events = [];
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await assert.doesNotReject(deliverWebhooks(env, 200, (severity, event, fields) => {
      events.push({ severity, event, fields });
    }));
    await assert.doesNotReject(deliverWebhooks(env, 200, () => {
      throw new Error("logger unavailable");
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(state.status, "pending");
  assert.equal(state.attempts, 0);
  assert.deepEqual(events, [{
    severity: "error",
    event: "webhook.deliver_error",
    fields: { source: "persistence", delivery_id: 17, error_type: "TypeError" },
  }]);
  assert.doesNotMatch(JSON.stringify(events), /payload|p{80}/u);
});
