import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Confirms the customer portal and the admin console share the same named CSS
// custom properties for their design tokens, so a value change on one side is
// caught immediately instead of silently drifting apart.

const repositoryRoot = resolve(import.meta.dirname, "..");
const adminTokensPath = resolve(
  repositoryRoot,
  "services/cloudflare-license-admin/src/ui/shared/console.css",
);
const portalTokensPath = resolve(
  repositoryRoot,
  "services/cloudflare-customer-portal/src/ui/styles.css",
);

// The token names the portal must share with admin: the base palette, the
// reconciled status colors, and the type scale. Listed explicitly (rather than
// inferred from whatever overlap already exists between the two files) so this
// test fails when a required name goes missing from either side, not only when
// a name both sides already define drifts in value.
const REQUIRED_SHARED_TOKENS = [
  "--canvas", "--surface", "--ink", "--muted", "--border",
  "--accent", "--accent-soft", "--danger", "--radius", "--font-ui",
  "--text-small", "--text-body", "--text-section", "--text-display",
  "--weight-normal", "--weight-strong",
  "--status-ok-bg", "--status-ok-ink",
  "--status-warn-bg", "--status-warn-ink",
  "--status-danger-bg", "--status-danger-ink",
];

// Strips /* ... */ comments so a comment can never hide, or fake, a declaration.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

// Finds the body of the first `:root { ... }` block, honoring brace nesting so a
// stray `{`/`}` inside a later rule cannot shift where the block is thought to
// end. Returns null when no `:root` block is present, so callers can fail closed
// instead of silently treating "no block" as "zero tokens".
function findRootBody(css) {
  const source = stripComments(css);
  const opener = /:root\s*\{/u.exec(source);
  if (!opener) return null;
  const start = opener.index + opener[0].length;
  let depth = 1;
  let index = start;
  for (; index < source.length && depth > 0; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
  }
  if (depth !== 0) return null;
  return source.slice(start, index - 1);
}

// Parses only named custom properties (`--name: value;`) out of a `:root` body.
// Splitting declarations on `;` handles both the one-declaration-per-line style
// and the compact style that packs several declarations onto one line, since
// none of these declarations' values ever contain a literal semicolon.
function parseCustomProperties(rootBody) {
  const tokens = new Map();
  for (const rawDeclaration of rootBody.split(";")) {
    const declaration = rawDeclaration.trim();
    if (!declaration) continue;
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    const value = declaration.slice(colon + 1).trim().replace(/\s+/gu, " ");
    tokens.set(name, value);
  }
  return tokens;
}

// Parses the named custom properties defined in a stylesheet's `:root` block.
// Returns null when the stylesheet has no `:root` block at all.
function parseRootTokens(css) {
  const body = findRootBody(css);
  if (body === null) return null;
  return parseCustomProperties(body);
}

// Returns the shared names whose values differ, after whitespace normalisation
// (already applied while parsing).
function diffSharedTokens(tokensA, tokensB) {
  const mismatches = [];
  for (const [name, valueA] of tokensA) {
    if (!tokensB.has(name)) continue;
    const valueB = tokensB.get(name);
    if (valueA !== valueB) mismatches.push({ name, a: valueA, b: valueB });
  }
  return mismatches.sort((left, right) => left.name.localeCompare(right.name));
}

test("parses the compact one-line-per-group style and ignores comments", () => {
  const css = `
    /* leading comment */
    :root {
      --canvas: #0f0f0f; --surface: #161616; /* inline comment */ --border: #2a2a2a;
      --radius: 6px;
      color: var(--surface);
    }
    .unrelated { --not-in-root: #ffffff; }
  `;
  const tokens = parseRootTokens(css);
  assert.deepEqual([...tokens.entries()], [
    ["--canvas", "#0f0f0f"],
    ["--surface", "#161616"],
    ["--border", "#2a2a2a"],
    ["--radius", "6px"],
  ]);
});

test("parses the one-declaration-per-line style and ignores comments", () => {
  const css = `
    :root {
      /* base palette */
      --surface:#161616;
      --border:#2a2a2a;
      --muted:#a8a8a8
    }
  `;
  const tokens = parseRootTokens(css);
  assert.deepEqual([...tokens.entries()], [
    ["--surface", "#161616"],
    ["--border", "#2a2a2a"],
    ["--muted", "#a8a8a8"],
  ]);
});

test("a differing shared value is reported as a mismatch", () => {
  const tokensA = parseRootTokens(":root { --status-ok-bg: #203020; }");
  const tokensB = parseRootTokens(":root { --status-ok-bg: #203026; }");
  const mismatches = diffSharedTokens(tokensA, tokensB);
  assert.deepEqual(mismatches, [{ name: "--status-ok-bg", a: "#203020", b: "#203026" }]);
});

test("a missing :root block is reported, not treated as zero tokens", () => {
  assert.equal(parseRootTokens(".no-root { color: red; }"), null);
});

test("admin and portal define the same value for every required shared token", () => {
  const adminTokens = parseRootTokens(readFileSync(adminTokensPath, "utf8"));
  const portalTokens = parseRootTokens(readFileSync(portalTokensPath, "utf8"));
  assert.notEqual(adminTokens, null, `${adminTokensPath} has no :root block`);
  assert.notEqual(portalTokens, null, `${portalTokensPath} has no :root block`);

  const problems = [];
  for (const name of REQUIRED_SHARED_TOKENS) {
    const adminValue = adminTokens.get(name);
    const portalValue = portalTokens.get(name);
    if (adminValue === undefined) problems.push(`admin is missing required token ${name}`);
    else if (portalValue === undefined) problems.push(`portal is missing required token ${name}`);
    else if (adminValue !== portalValue) {
      problems.push(`${name} drifted: admin=${adminValue} portal=${portalValue}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("no other shared token has drifted between admin and portal", () => {
  const adminTokens = parseRootTokens(readFileSync(adminTokensPath, "utf8"));
  const portalTokens = parseRootTokens(readFileSync(portalTokensPath, "utf8"));
  assert.notEqual(adminTokens, null, `${adminTokensPath} has no :root block`);
  assert.notEqual(portalTokens, null, `${portalTokensPath} has no :root block`);
  const mismatches = diffSharedTokens(adminTokens, portalTokens);
  assert.deepEqual(mismatches, [], `drifted shared tokens: ${JSON.stringify(mismatches)}`);
});
