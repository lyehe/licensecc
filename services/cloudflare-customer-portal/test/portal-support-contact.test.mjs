// Every customer-facing instruction to contact someone renders <SupportContact/>. It links
// to the operator's configured support contact (PORTAL_SUPPORT_CONTACT, published by the providers
// envelope) and otherwise falls back to "Contact your administrator".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "@typescript/typescript6";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const UI_SOURCE_ROOT = fileURLToPath(new URL("../src/ui", import.meta.url));
const COMPONENT_SOURCE = new URL("../src/ui/shared/SupportContact.tsx", import.meta.url);

// Transpile the component on its own and import it. The temporary copy cannot resolve bare package
// names, so its React imports are pinned to the modules this test (and react-dom/server) resolve:
// one React instance, or neither hooks nor context would cross the boundary.
async function loadSupportContact() {
  const transpiled = ts.transpileModule(readFileSync(COMPONENT_SOURCE, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, specifier) => `from "${import.meta.resolve(specifier)}"`);
  const dir = mkdtempSync(join(tmpdir(), "licensecc-portal-support-"));
  const file = join(dir, "SupportContact.mjs");
  writeFileSync(file, transpiled, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function collectSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(full);
    return entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name)) ? [full] : [];
  });
}

test("SupportContact links a configured contact and otherwise names the administrator", async () => {
  const { SupportContact } = await loadSupportContact();
  const render = (props) => renderToStaticMarkup(createElement(SupportContact, props));
  assert.equal(render({ support: "https://support.example.com/help" }), '<a href="https://support.example.com/help">Contact support</a>');
  assert.equal(render({ support: "mailto:help@example.com" }), '<a href="mailto:help@example.com">Contact support</a>');
  assert.equal(render({ support: null }), "Contact your administrator");
  assert.equal(render({}), "Contact your administrator");
});

test("SupportContact never places a scheme other than https: or mailto: in an href", async () => {
  const { SupportContact } = await loadSupportContact();
  for (const unsafe of ["javascript:alert(1)", "http://support.example.com", "data:text/html,support", "/support", ""]) {
    assert.equal(renderToStaticMarkup(createElement(SupportContact, { support: unsafe })), "Contact your administrator", unsafe);
  }
});

test("SupportContact uses the app-wide contact unless it is given one", async () => {
  const { SupportContact, SupportContactContext } = await loadSupportContact();
  const within = (value, props = {}) => renderToStaticMarkup(createElement(SupportContactContext.Provider, { value }, createElement(SupportContact, props)));
  assert.equal(within("mailto:help@example.com"), '<a href="mailto:help@example.com">Contact support</a>');
  assert.equal(within(null), "Contact your administrator");
  assert.equal(within("mailto:help@example.com", { support: null }), "Contact your administrator");
});

test("portal UI copy says 'contact your administrator' only through SupportContact", () => {
  const offenders = collectSourceFiles(UI_SOURCE_ROOT)
    .filter((file) => /contact your administrator/i.test(readFileSync(file, "utf8")))
    .map((file) => relative(UI_SOURCE_ROOT, file).split(sep).join("/"))
    .filter((file) => file !== "shared/SupportContact.tsx");
  assert.deepEqual(offenders, [], "render <SupportContact/> so a configured support contact replaces the administrator fallback");
});
