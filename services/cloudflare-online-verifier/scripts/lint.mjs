import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const forbidden = [
  "PRIVATE KEY-----\\n",
  "account_id =",
  "api_token",
];

for (const needle of forbidden) {
  if (source.includes(needle)) {
    throw new Error(`forbidden committed secret marker found: ${needle}`);
  }
}

console.log("lint ok");
