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

// Scans a whole stylesheet for `:root { ... }` blocks that sit at the top
// level -- not nested inside an `@media`, `@supports`, or any other rule --
// and returns each one's body. A `:root` nested inside another rule is walked
// over, so brace depth stays correct for whatever follows it, but it is never
// returned: it does not describe the page's actual custom properties the way
// a top-level `:root` does, and must not be mistaken for one.
function findAllTopLevelRootBodies(css) {
  const source = stripComments(css);
  const bodies = [];
  let depth = 0;
  let preludeStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      const prelude = source.slice(preludeStart, index).trim();
      if (depth === 0 && prelude === ":root") {
        let innerDepth = 1;
        let cursor = index + 1;
        for (; cursor < source.length && innerDepth > 0; cursor += 1) {
          if (source[cursor] === "{") innerDepth += 1;
          else if (source[cursor] === "}") innerDepth -= 1;
        }
        if (innerDepth !== 0) throw new Error("unterminated :root block");
        bodies.push(source.slice(index + 1, cursor - 1));
        index = cursor - 1;
        preludeStart = cursor;
        continue;
      }
      depth += 1;
      preludeStart = index + 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      preludeStart = index + 1;
      continue;
    }
    if (char === ";" && depth === 0) {
      preludeStart = index + 1;
    }
  }
  return bodies;
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

// Parses the named custom properties defined in a stylesheet's single
// top-level `:root` block. Throws a descriptive error when there is not
// exactly one, so "no block" and "an ambiguous second block" each fail
// closed with a clear message instead of being mistaken for zero tokens.
function parseRootTokens(css) {
  const bodies = findAllTopLevelRootBodies(css);
  if (bodies.length === 0) {
    throw new Error(
      "no top-level :root block found (a :root nested inside another rule, such as @media, does not count)",
    );
  }
  if (bodies.length > 1) {
    throw new Error(`expected exactly one top-level :root block, found ${bodies.length}`);
  }
  return parseCustomProperties(bodies[0]);
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

test("a missing :root block throws instead of yielding an empty token map", () => {
  assert.throws(() => parseRootTokens(".no-root { color: red; }"), /no top-level :root/u);
});

test("a :root nested inside @media before the real one is ignored", () => {
  const css = `
    @media (prefers-color-scheme: dark) {
      :root { --accent: #000000; }
    }
    :root {
      --accent: #b8b8b8;
      --border: #2a2a2a;
    }
  `;
  const tokens = parseRootTokens(css);
  assert.deepEqual([...tokens.entries()], [
    ["--accent", "#b8b8b8"],
    ["--border", "#2a2a2a"],
  ]);
});

test("two top-level :root blocks fail closed instead of silently picking one", () => {
  const css = `
    :root { --accent: #b8b8b8; }
    :root { --accent: #ffffff; }
  `;
  assert.throws(() => parseRootTokens(css), /exactly one top-level :root/u);
});

test("a :root that exists only nested inside @media is not a top-level block", () => {
  const css = `
    @media (prefers-color-scheme: dark) {
      :root { --accent: #000000; }
    }
  `;
  assert.throws(() => parseRootTokens(css), /no top-level :root/u);
});

test("admin and portal define the same value for every required shared token", () => {
  const adminTokens = parseRootTokens(readFileSync(adminTokensPath, "utf8"));
  const portalTokens = parseRootTokens(readFileSync(portalTokensPath, "utf8"));

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
  const mismatches = diffSharedTokens(adminTokens, portalTokens);
  assert.deepEqual(mismatches, [], `drifted shared tokens: ${JSON.stringify(mismatches)}`);
});
