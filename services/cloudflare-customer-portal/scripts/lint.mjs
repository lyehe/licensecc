import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Forbidden literal secret references in committed source. The portal never persists or commits a
// backend signing key, a Cloudflare API token, or a pepper secret. (The reserved-word join trick
// keeps THIS scanner from matching itself.)
const forbidden = [
  ["ONLINE", "SIGNING", "PRIVATE", "KEY"].join("_"),
  ["ONLINE", "SIGNING", "PRIVATE", "KEY", "PKCS8", "PEM"].join("_"),
  ["LEASE", "SIGNING", "PRIVATE", "KEY", "PKCS8", "PEM"].join("_"),
  ["CLOUDFLARE", "API", "TOKEN"].join("_") + "=",
  "BEGIN PRIVATE KEY",
  "BEGIN RSA PRIVATE KEY",
];

function* files(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (["node_modules", "dist", "dist-worker", ".wrangler"].includes(entry)) {
        continue;
      }
      yield* files(path);
    } else {
      yield path;
    }
  }
}

let failed = false;
for (const file of files(".")) {
  // Don't scan this scanner (it names the needles) or compiled output.
  if (file.endsWith("scripts/lint.mjs") || file.replace(/\\/g, "/").endsWith("scripts/lint.mjs")) {
    continue;
  }
  const content = readFileSync(file, "utf8");
  for (const needle of forbidden) {
    if (content.includes(needle)) {
      console.error(`forbidden portal secret reference in ${file}: ${needle}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("lint ok");
