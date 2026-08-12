import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function expectedPlatformTag(root = repositoryRoot) {
  let contract;
  try {
    contract = JSON.parse(readFileSync(resolve(root, "version.json"), "utf8"));
  } catch {
    throw new Error("version.json is not valid JSON");
  }
  if (contract?.schema_version !== 1 || typeof contract.platform_version !== "string" || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u.test(contract.platform_version)) throw new Error("version.json has no valid platform version");
  return `platform-v${contract.platform_version}`;
}

export function checkPlatformTag(tag, root = repositoryRoot) {
  const expected = expectedPlatformTag(root);
  if (tag !== expected) throw new Error(`release tag must be exactly ${expected}; received ${tag || "<empty>"}`);
  return expected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(checkPlatformTag(process.argv[2] ?? process.env.GITHUB_REF_NAME));
}
