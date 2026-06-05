import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const forbidden = [
  ["ONLINE", "SIGNING", "PRIVATE", "KEY"].join("_"),
  ["ONLINE", "SIGNING", "PRIVATE", "KEY", "PKCS8", "PEM"].join("_"),
  ["CLOUDFLARE", "API", "TOKEN"].join("_") + "=",
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

for (const file of files(".")) {
  const content = readFileSync(file, "utf8");
  for (const needle of forbidden) {
    if (content.includes(needle)) {
      console.error(`forbidden admin secret reference in ${file}: ${needle}`);
      process.exit(1);
    }
  }
}

console.log("lint ok");
