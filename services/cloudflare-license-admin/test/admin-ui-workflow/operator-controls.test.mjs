import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { loadWorkflowModules } from "./helpers.mjs";

// The operator-controls hooks run under the real React server renderer: hook
// state set while rendering re-renders the probe, while callbacks invoked
// afterwards act on refs and injected spies (post-render state updates are
// no-ops on the server). Effects never run here; the browser suite covers them.

const HOOK_MODULES = [
  "shared/operationGate.ts",
  "shared/operatorFocus.ts",
  "shared/useActionNotice.ts",
  "shared/useConfirmDialog.tsx",
  "shared/useKeyedMutation.ts",
  "shared/operatorActions.ts",
];

async function loadHooks() {
  const [gate, focus, notice, dialog, keyed, actions] = await loadWorkflowModules(HOOK_MODULES);
  return { ...gate, ...focus, ...notice, ...dialog, ...keyed, ...actions };
}

function renderHooks(useHooks) {
  let result;
  function Probe() {
    result = useHooks();
    return result.element ?? null;
  }
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(Probe));
  return { ...result, markup };
}

/** The few browser globals focus capture reads; nothing here is focusable. */
async function withBrowserGlobals(run, extra = {}) {
  class StubElement {}
  const globals = {
    HTMLElement: StubElement,
    document: {
      activeElement: null,
      body: new StubElement(),
      documentElement: new StubElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { requestAnimationFrame: () => 0 },
    ...extra,
  };
  const saved = Object.fromEntries(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, globals);
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function findElement(node, matches) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, matches);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (matches(node)) return node;
  return findElement(node.props?.children, matches);
}

const button = (label) => (element) => element.type === "button" && element.props.children === label;
const noFocus = { invokingElement: null, rowKey: null, sectionKey: null };

test("useActionNotice publishes generations, locks the gate while recoverable and only acknowledges settled notices", async () => {
  const hooks = await loadHooks();
  const recovery = { label: "Reconcile status", run: async () => "applied" };
  let published = false;
  const locked = renderHooks(() => {
    const gate = hooks.useOperationGate();
    const notice = hooks.useActionNotice(gate);
    if (!published) {
      published = true;
      notice.publishActionNotice({ message: hooks.CONFIRM_MUTATION_UNKNOWN_MESSAGE, manualRefresh: recovery, focusTarget: noFocus, dismissible: false, unresolvedKey: "key-1" });
    }
    return { gate, notice };
  });
  assert.equal(locked.notice.actionNotice.generation, 1);
  assert.equal(locked.notice.actionNotice.unresolvedKey, "key-1");
  assert.equal(locked.notice.actionNoticeRef.current, locked.notice.actionNotice, "the ref mirrors the rendered notice");
  assert.equal(locked.notice.operationLocked, true, "a recoverable notice locks other operations");

  // An unresolved notice cannot be acknowledged away; only reconciliation clears it.
  locked.notice.acknowledgeNotice();
  assert.equal(locked.notice.actionNoticeRef.current.unresolvedKey, "key-1");

  // Publishing is synchronous on the ref and always advances the generation.
  locked.notice.publishActionNotice({ message: "action_failed", focusTarget: noFocus, dismissible: true });
  const dismissible = locked.notice.actionNoticeRef.current;
  assert.equal(dismissible.generation, 2);
  locked.notice.replaceActionNotice({ ...dismissible, message: "revised" });
  assert.deepEqual(locked.notice.actionNoticeRef.current, { ...dismissible, message: "revised" }, "a revision keeps its generation");

  // A running recovery blocks acknowledgement.
  locked.notice.noticePendingRef.current = true;
  locked.notice.acknowledgeNotice();
  assert.notEqual(locked.notice.actionNoticeRef.current, null);
  locked.notice.noticePendingRef.current = false;

  // Acknowledging a settled notice clears it and releases a consequence owner.
  locked.gate.operationOwnerRef.current = "consequence";
  locked.gate.operationBusyRef.current = true;
  locked.notice.acknowledgeNotice();
  assert.equal(locked.notice.actionNoticeRef.current, null);
  assert.equal(locked.gate.operationOwnerRef.current, null);
  assert.equal(locked.gate.operationBusyRef.current, false);

  const renderPublished = (input) => {
    let publishedOnce = false;
    return renderHooks(() => {
      const notice = hooks.useActionNotice(hooks.useOperationGate());
      if (!publishedOnce) {
        publishedOnce = true;
        notice.publishActionNotice(input);
      }
      return { notice };
    }).notice;
  };
  const refreshOnly = renderPublished({ message: hooks.CONFIRM_REFRESH_FAILURE_MESSAGE, manualRefresh: { label: "Refresh status", run: async () => "applied" }, focusTarget: noFocus, dismissible: false });
  assert.equal(refreshOnly.actionNotice.unresolvedKey, undefined);
  assert.equal(refreshOnly.operationLocked, true, "a status-refresh control alone still locks operations");
  const informational = renderPublished({ message: "action_failed", focusTarget: noFocus, dismissible: true });
  assert.equal(informational.actionNotice.message, "action_failed");
  assert.equal(informational.operationLocked, false, "a plain dismissible notice does not lock operations");
});

test("useKeyedMutation retains an unknown outcome under its key and reconciles by replaying that exact request", async () => {
  const hooks = await loadHooks();
  await withBrowserGlobals(async () => {
    const render = () => {
      const messages = [];
      const feedback = [];
      const rendered = renderHooks(() => {
        const gate = hooks.useOperationGate();
        const focus = hooks.useOperatorFocus();
        const notice = hooks.useActionNotice(gate);
        const keyed = hooks.useKeyedMutation({ gate, focus, notice, confirmActionRef: { current: null }, setMessage: (message) => messages.push(message), setFeedback: (value) => feedback.push(value) });
        return { gate, notice, keyed };
      });
      return { ...rendered, messages, feedback };
    };
    const success = (value, phase) => ({ kind: "success", code: "created", requestId: `req-${phase}`, data: value });

    // 1. The first send fails in transit: the outcome is unknown, so the request is retained.
    const unknown = render();
    const sent = [];
    const applied = [];
    const action = {
      request: { method: "POST", path: "/api/admin/policies", body: "{\"name\":\"standard\"}" },
      send: async (attempt) => {
        sent.push(attempt);
        if (sent.length === 1) throw new Error("connection reset");
        return "stored";
      },
      parse: success,
      onApplied: (result) => applied.push(result.requestId),
      refresh: async () => hooks.EXACT_READ_PROOF,
    };
    await unknown.keyed.runKeyedMutation(action);
    assert.equal(sent.length, 1);
    const [attempt] = sent;
    assert.ok(Object.isFrozen(attempt));
    assert.equal(attempt.method, "POST");
    assert.equal(attempt.path, "/api/admin/policies");
    assert.equal(attempt.body, "{\"name\":\"standard\"}");
    assert.match(attempt.idempotencyKey, /^[0-9a-f-]{36}$/u);
    assert.equal(unknown.gate.unresolvedOperationRef.current.idempotencyKey, attempt.idempotencyKey);
    assert.equal(unknown.gate.unresolvedOperationRef.current.request, attempt);
    assert.equal(unknown.gate.operationOwnerRef.current, "ordinary", "the retained request keeps the operation gate");
    const retained = unknown.notice.actionNoticeRef.current;
    assert.equal(retained.message, hooks.CONFIRM_MUTATION_UNKNOWN_MESSAGE);
    assert.equal(retained.unresolvedKey, attempt.idempotencyKey);
    assert.equal(retained.dismissible, false);
    assert.equal(retained.manualRefresh.label, "Reconcile status");
    assert.deepEqual(unknown.feedback.at(-1), { tone: "error", message: hooks.CONFIRM_MUTATION_UNKNOWN_MESSAGE });

    // 2. Nothing else may start while the outcome is unknown.
    await unknown.keyed.runKeyedMutation({ ...action, request: { method: "POST", path: "/api/admin/policies", body: "{}" } });
    assert.equal(sent.length, 1);

    // 3. Reconciling replays the identical frozen request, then requires the strict read.
    await unknown.keyed.runNoticeRecovery();
    assert.equal(sent.length, 2);
    assert.equal(sent[1], attempt, "the replay reuses the retained key and body");
    assert.deepEqual(applied, ["req-replay"]);
    assert.equal(unknown.gate.unresolvedOperationRef.current, null);
    assert.equal(unknown.notice.actionNoticeRef.current, null);
    assert.equal(unknown.gate.operationOwnerRef.current, null);
    assert.deepEqual(unknown.feedback.at(-1), { tone: "success", message: "Status reconciled." });

    // 4. A known write whose strict read fails keeps a GET-only recovery and is never re-sent.
    const knownWrite = render();
    const knownSent = [];
    let proof = null;
    await knownWrite.keyed.runKeyedMutation({
      ...action,
      send: async (value) => {
        knownSent.push(value);
        return "stored";
      },
      refresh: async () => proof,
    });
    assert.equal(knownSent.length, 1);
    assert.equal(knownWrite.gate.unresolvedOperationRef.current, null);
    assert.equal(knownWrite.gate.operationOwnerRef.current, null);
    const refreshNotice = knownWrite.notice.actionNoticeRef.current;
    assert.equal(refreshNotice.message, hooks.CONFIRM_REFRESH_FAILURE_MESSAGE);
    assert.equal(refreshNotice.manualRefresh.label, "Refresh status");
    assert.equal(refreshNotice.manualRefresh.settlesKnownSuccess, true);
    assert.equal(refreshNotice.unresolvedKey, undefined);
    assert.deepEqual(knownWrite.messages, [hooks.CONFIRM_REFRESH_FAILURE_MESSAGE]);
    proof = hooks.EXACT_READ_PROOF;
    await knownWrite.keyed.runNoticeRecovery();
    assert.equal(knownSent.length, 1, "refreshing a known write never replays it");
    assert.equal(knownWrite.notice.actionNoticeRef.current, null);
    assert.deepEqual(knownWrite.feedback.at(-1), { tone: "success", message: "Status reconciled." });

    // 5. A definitive rejection concludes the attempt without retaining anything.
    const rejected = render();
    await rejected.keyed.runKeyedMutation({ ...action, send: async () => "rejected", parse: () => ({ kind: "failure", code: "policy_exists", requestId: "req-9" }) });
    assert.equal(rejected.gate.unresolvedOperationRef.current, null);
    assert.equal(rejected.gate.operationOwnerRef.current, null);
    assert.equal(rejected.notice.actionNoticeRef.current, null);
    assert.deepEqual(rejected.feedback, [{ tone: "error", message: "policy_exists (req-9)" }]);
  });
});

test("useConfirmDialog renders an accessible modal, keeps the non-native fallback and retains a key only for an unknown outcome", async () => {
  const hooks = await loadHooks();
  const runs = [];
  const action = {
    title: "Revoke license",
    body: "Activated devices stop validating.",
    details: React.createElement("p", null, "2 activated devices lose access."),
    requiresReason: true,
    run: async ({ idempotencyKey }) => {
      runs.push(idempotencyKey);
      return runs.length === 1 ? { ok: false, retryable: true, message: "reason_too_short" } : { ok: false, unknown: true };
    },
  };
  const renderDialog = (typedReason) => {
    let requested = false;
    return renderHooks(() => {
      const gate = hooks.useOperationGate();
      const focus = hooks.useOperatorFocus();
      const notice = hooks.useActionNotice(gate);
      const confirm = hooks.useConfirmDialog({ gate, focus, notice, setMessage: () => {} });
      if (!requested) {
        requested = true;
        confirm.requestConfirm(action);
        if (typedReason !== undefined) confirm.setReason(typedReason);
      }
      return { gate, focus, notice, confirm, element: confirm.dialog };
    });
  };

  await withBrowserGlobals(async () => {
    // Without a native <dialog> the equivalent overlay modal renders.
    const blank = renderDialog();
    assert.equal(blank.confirm.modalActive, true);
    assert.equal(blank.confirm.confirmActionRef.current, action);
    assert.equal(blank.gate.operationOwnerRef.current, "consequence", "an open confirmation owns the operation gate");
    assert.doesNotMatch(blank.markup, /<dialog/u);
    assert.match(blank.markup, /<div class="modalOverlay" role="presentation"><div class="modal danger" role="dialog" aria-modal="true"/u);
    const labelledBy = blank.markup.match(/aria-labelledby="([^"]+)"/u)[1];
    assert.ok(blank.markup.includes(`<h2 id="${labelledBy}">Revoke license</h2>`));
    assert.match(blank.markup, /<section class="modalDetails" aria-label="Action consequences"><p>2 activated devices lose access\.<\/p><\/section>/u);
    assert.match(blank.markup, /Reason \(required\)<input/u);
    assert.match(blank.markup, /<button type="button" class="danger" disabled="">Confirm<\/button>/u, "Confirm waits for a reason");
    assert.equal(blank.confirm.currentReason(), "");

    // Another operation cannot open over the open confirmation. The refused
    // request must never touch focus state; a sentinel proves this assertion
    // can actually fail (the server render otherwise writes no state at all).
    blank.focus.pendingRestoreFocusRef.current = "sentinel";
    blank.confirm.requestConfirm({ ...action, title: "Second" });
    assert.equal(blank.confirm.confirmActionRef.current, action);
    assert.equal(blank.focus.pendingRestoreFocusRef.current, "sentinel");

    // With a reason typed, Confirm runs the action.
    const typed = renderDialog("Customer request");
    assert.equal(typed.confirm.currentReason(), "Customer request");
    assert.match(typed.markup, /<button type="button" class="danger">Confirm<\/button>/u);
    const confirmButton = findElement(typed.element, button("Confirm"));

    // A documented rejection concludes the attempt: nothing is retained and the next try uses a new key.
    confirmButton.props.onClick();
    await settle();
    assert.equal(runs.length, 1);
    assert.equal(typed.gate.confirmPendingRef.current, false);
    assert.equal(typed.gate.unresolvedOperationRef.current, null);
    assert.equal(typed.notice.actionNoticeRef.current, null);

    // An unknown outcome retains that attempt's key and publishes a locked notice.
    confirmButton.props.onClick();
    await settle();
    assert.equal(runs.length, 2);
    assert.notEqual(runs[1], runs[0]);
    assert.equal(typed.gate.unresolvedOperationRef.current.idempotencyKey, runs[1]);
    const notice = typed.notice.actionNoticeRef.current;
    assert.equal(notice.message, hooks.CONFIRM_MUTATION_UNKNOWN_MESSAGE);
    assert.equal(notice.unresolvedKey, runs[1]);
    assert.equal(notice.dismissible, false);

    // Cancel closes the dialog but the retained operation keeps the gate.
    findElement(typed.element, button("Cancel")).props.onClick();
    assert.equal(typed.gate.operationOwnerRef.current, "consequence");
    assert.deepEqual(typed.focus.pendingRestoreFocusRef.current, noFocus);
  });

  class StubDialog {
    showModal() {}
  }
  await withBrowserGlobals(async () => {
    const native = renderDialog();
    assert.match(native.markup, /^<dialog class="modal danger" role="dialog" aria-modal="true"/u);
    assert.doesNotMatch(native.markup, /modalOverlay/u);
  }, { HTMLDialogElement: StubDialog });
});

test("useConfirmDialog gates a renamed Confirm behind an exact typed phrase and offers reason presets", async () => {
  const hooks = await loadHooks();
  const action = {
    title: "Revoke selected entitlements",
    body: "Revocation is TERMINAL and cannot be undone.",
    requiresReason: true,
    confirmLabel: "Revoke",
    typedConfirmation: "REVOKE 4",
    reasonPresets: ["Payment failed", "Customer request", "Fraud review"],
    run: async () => ({ ok: true }),
  };
  const renderDialog = () => {
    let requested = false;
    return renderHooks(() => {
      const gate = hooks.useOperationGate();
      const focus = hooks.useOperatorFocus();
      const notice = hooks.useActionNotice(gate);
      const confirm = hooks.useConfirmDialog({ gate, focus, notice, setMessage: () => {} });
      if (!requested) {
        requested = true;
        confirm.requestConfirm(action);
      }
      return { gate, focus, notice, confirm, element: confirm.dialog };
    });
  };

  await withBrowserGlobals(async () => {
    const rendered = renderDialog();
    // The typed phrase gets its own labelled field, so a screen reader announces exactly what to type.
    assert.match(rendered.markup, /Type REVOKE 4 to confirm<input/u);
    // The button is renamed and stays really disabled (the `disabled` attribute, not just styling)
    // on a fresh open, before either the reason or the exact typed phrase is supplied.
    assert.match(rendered.markup, /<button type="button" class="danger" disabled="">Revoke<\/button>/u);
    // Reason presets are plain, keyboard-reachable buttons; they never disable the reason field.
    assert.match(rendered.markup, /<div class="reasonPresets"><button type="button">Payment failed<\/button><button type="button">Customer request<\/button><button type="button">Fraud review<\/button><\/div>/u);
    assert.doesNotMatch(rendered.markup, /Reason \(required\)<input[^>]*disabled=""/u);
  });
});
