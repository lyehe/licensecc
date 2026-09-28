import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

/*
 * A minimal fake DOM, just expressive enough to drive usableFocusTarget's and
 * reopenAncestorDisclosure's ancestor-walking logic (closest/:scope > summary/
 * contains/parentElement) without pulling in a real DOM implementation.
 */

function matchesSimpleSelector(element, simple) {
  const trimmed = simple.trim();
  if (trimmed === "details" || trimmed === "summary") return element.tag === trimmed;
  const attribute = trimmed.match(/^\[([a-zA-Z-]+)(?:=("[^"]*"|'[^']*'))?\]$/);
  if (attribute === null) return false;
  const [, name, rawValue] = attribute;
  if (!element.hasAttribute(name)) return false;
  return rawValue === undefined || element.getAttribute(name) === rawValue.slice(1, -1);
}

function matchesSelector(element, selector) {
  return selector.split(",").some((part) => matchesSimpleSelector(element, part));
}

class FakeElement {
  constructor(tag, attributes = {}) {
    this.tag = tag;
    this.attributes = attributes;
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    if (tag === "details") this.open = attributes.open === true;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attributes, name);
  }

  getAttribute(name) {
    return this.hasAttribute(name) ? this.attributes[name] : null;
  }

  getClientRects() {
    return [{}];
  }

  closest(selector) {
    let node = this;
    while (node !== null) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    if (selector.trim() === ":scope > summary") {
      return this.children.find((child) => child.tag === "summary") ?? null;
    }
    for (const child of this.children) {
      if (matchesSelector(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found !== null) return found;
    }
    return null;
  }

  contains(other) {
    let node = other;
    while (node !== null) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
}

async function withFakeDom(run) {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  };
  const body = new FakeElement("body");
  Object.assign(globalThis, {
    document: { body, querySelector: () => null, querySelectorAll: () => [] },
    window: { getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
  });
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

test("usableFocusTarget treats a closed outer <details> as unreachable even when the nearest disclosure is open", async () => {
  const { usableFocusTarget, reopenAncestorDisclosure } = await loadWorkflowModule("shared/workspaceFocus.ts");
  await withFakeDom(() => {
    // outer (closed) > div > inner (open) > button
    const outer = new FakeElement("details", { open: false });
    const div = outer.appendChild(new FakeElement("div"));
    const inner = div.appendChild(new FakeElement("details", { open: true }));
    const button = inner.appendChild(new FakeElement("button"));
    assert.equal(usableFocusTarget(button), false, "a closed outer disclosure must still block a button under an open inner one");

    reopenAncestorDisclosure(button);
    assert.equal(outer.open, true, "reopening must reach every closed ancestor, not just the nearest");
    assert.equal(inner.open, true);
    assert.equal(usableFocusTarget(button), true, "once every ancestor disclosure is open the button is reachable again");
  });
});

test("usableFocusTarget still exempts an element that sits inside its own closed disclosure's summary", async () => {
  const { usableFocusTarget } = await loadWorkflowModule("shared/workspaceFocus.ts");
  await withFakeDom(() => {
    const outer = new FakeElement("details", { open: false });
    const summary = outer.appendChild(new FakeElement("summary"));
    const summaryLink = summary.appendChild(new FakeElement("a", { href: "#" }));
    assert.equal(usableFocusTarget(summaryLink), true, "a closed disclosure's own summary content stays reachable");

    const content = outer.appendChild(new FakeElement("div"));
    const contentButton = content.appendChild(new FakeElement("button"));
    assert.equal(usableFocusTarget(contentButton), false, "content outside the summary is still blocked while closed");
  });
});

test("usableFocusTarget blocks a closed inner disclosure inside an open outer one", async () => {
  const { usableFocusTarget } = await loadWorkflowModule("shared/workspaceFocus.ts");
  await withFakeDom(() => {
    const outer = new FakeElement("details", { open: true });
    const inner = outer.appendChild(new FakeElement("details", { open: false }));
    const button = inner.appendChild(new FakeElement("button"));
    assert.equal(usableFocusTarget(button), false);
  });
});
