import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "@typescript/typescript6";

// Transpile the fetch-wrapping / onUnauthorized-hook / session-epoch logic in api.tsx as a pure ES
// module, the same seam test/portal-ui-workflow.test.mjs uses for portalWorkflow.ts. Unlike
// portalWorkflow.ts, api.tsx also defines a JSX component (StatusLine) that needs `react` and
// portalWorkflow's copy helpers resolvable at import time -- neither is needed to exercise api()'s
// fetch-wrapping/hook/epoch behavior, so this slices the source down to everything ABOVE
// `export function StatusLine` (dropping its now-unused imports too) before transpiling, leaving zero
// runtime imports left to resolve from a scratch temp directory.
async function loadApiModule() {
  const fullSource = readFileSync(new URL("../src/ui/shared/api.tsx", import.meta.url), "utf8");
  const statusLineMarker = "export function StatusLine";
  const cut = fullSource.indexOf(statusLineMarker);
  assert.ok(cut > 0, "api.tsx must still define StatusLine at this exact name for the slice point below to be valid");
  const pureSource = fullSource.slice(0, cut)
    .replace(/^import React from "react";\n/m, "")
    .replace(/^import \{ describeResultCode, describeUnknownResult \} from "\.\.\/portalWorkflow";\n/m, "");
  assert.doesNotMatch(pureSource, /from "react"|from "\.\.\/portalWorkflow"/, "the sliced source must have zero remaining runtime imports to resolve");
  const transpiled = ts.transpileModule(pureSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "licensecc-portal-api-"));
  const file = join(dir, "api.mjs");
  writeFileSync(file, transpiled, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Fix round 1 (Minor): a session epoch stops a straggler -- a request sent under an OLD, already-
// superseded session that only answers 401 long after the customer signed in again -- from bouncing
// that new sign-in back a step.

test("api() fires onUnauthorized for a plain 401 unauthorized (same epoch throughout)", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnUnauthorized(() => fired.push(true));
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r1" });
  const result = await api.api("/api/portal/entitlements");
  assert.equal(result.code, "unauthorized");
  assert.equal(fired.length, 1, "a same-epoch 401 unauthorized must fire the hook");
  api.setOnUnauthorized(null);
});

test("api() ignores a straggler 401 whose request started under an OLDER, already-superseded session", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnUnauthorized(() => fired.push(true));

  // A slow request starts -- api() captures the CURRENT epoch internally -- but its response is held
  // back, simulating a request that has been in flight for a while.
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const pending = api.api("/api/portal/heartbeat", { method: "POST" });

  // The customer signs in again (a brand-new session) while that old request is still in flight.
  api.beginNewSession();

  // The stale request finally resolves with a 401 unauthorized from the now-dead, superseded session.
  resolveFetch(jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r2" }));
  const result = await pending;

  assert.equal(result.code, "unauthorized"); // the caller still sees the real result envelope...
  assert.equal(fired.length, 0, "...but a straggler from an old epoch must not fire the hook");
});

test("api() still fires for a 401 sent AFTER the epoch bump (not just before it)", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnUnauthorized(() => fired.push(true));
  api.beginNewSession();
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r3" });
  await api.api("/api/portal/devices");
  assert.equal(fired.length, 1, "a request sent in the CURRENT epoch must still fire normally");
});

test("skipUnauthorizedHook bypasses the epoch check entirely (retrySession's own /me call)", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnUnauthorized(() => fired.push(true));
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r4" });
  await api.api("/api/portal/me", undefined, { skipUnauthorizedHook: true });
  assert.equal(fired.length, 0, "the retry's own /me check must never re-enter the handler it is answering");
});

test("beginNewSession/currentSessionEpoch track one counter, and credential 401s never fire regardless of epoch", async () => {
  const api = await loadApiModule();
  const first = api.currentSessionEpoch();
  api.beginNewSession();
  assert.equal(api.currentSessionEpoch(), first + 1);
  api.beginNewSession();
  assert.equal(api.currentSessionEpoch(), first + 2);

  const fired = [];
  api.setOnUnauthorized(() => fired.push(true));
  // Same (current) epoch, but a credential failure code -- must never fire, epoch match or not.
  api.reportUnauthorized(401, "invalid_otp", api.currentSessionEpoch());
  assert.equal(fired.length, 0);
});
