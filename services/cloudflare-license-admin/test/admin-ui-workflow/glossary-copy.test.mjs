// Task F1 (doc/architecture/glossary.md): the admin console and the customer portal share one
// vocabulary for the same underlying records. A term the glossary retired must never resurface
// in UI source in either app. This guard scans the admin console's src/ui tree; the portal has
// an equivalent test at test/portal-glossary-copy.test.mjs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const UI_SOURCE_ROOT = fileURLToPath(new URL("../../src/ui", import.meta.url));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Each entry names the exact retired string plus the glossary's replacement, so a failure here
// is self-explanatory without cross-referencing the plan. See doc/architecture/glossary.md.
const RETIRED_TERMS = [
  { name: "'Binding:' identifier label (protected binding)", pattern: /\bBinding:/, useInstead: '"Connection ID:"' },
  { name: "'Retire connection' action (protected binding)", pattern: /Retire connection/, useInstead: '"Disconnect"' },
  { name: "'Registered nodes' list label (legacy device)", pattern: /Registered nodes/, useInstead: '"Activated devices"' },
  { name: "'Floating sessions' list label (floating seat)", pattern: /Floating sessions/, useInstead: '"Floating seats"' },
  { name: '\'"enabled"\' as a displayed status', pattern: /"enabled"/, useInstead: '"active"' },
];

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

test("admin UI source never reintroduces a term the F1 glossary retired", () => {
  const offenses = [];
  for (const file of collectSourceFiles(UI_SOURCE_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const term of RETIRED_TERMS) {
      if (term.pattern.test(text)) {
        offenses.push(`${file}: found ${term.name} — use ${term.useInstead} (doc/architecture/glossary.md)`);
      }
    }
  }
  assert.deepEqual(offenses, [], offenses.join("\n"));
});
