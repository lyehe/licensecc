import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const forbidden = [
  ["D1", "REST", "API", "TOKEN"].join("_") + "=",
  ["BACKUP", "TRIGGER", "TOKEN"].join("_") + "=",
  ["CLOUDFLARE", "API", "TOKEN"].join("_") + "=",
  "PRIVATE KEY-----\\n",
  ["account", "id"].join("_") + " =",
  /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];

function* files(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (["node_modules", "dist", ".wrangler"].includes(entry)) {
        continue;
      }
      yield* files(path);
    } else {
      yield path;
    }
  }
}

for (const file of files(".")) {
  const content = readFileSync(file, "utf8");
  for (const needle of forbidden) {
    if (typeof needle === "string" ? content.includes(needle) : needle.test(content)) {
      console.error(`forbidden backup secret marker in ${file}: ${needle.toString()}`);
      process.exit(1);
    }
  }
}

console.log("lint ok");
