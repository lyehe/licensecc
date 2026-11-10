import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function listFiles(root, flags, paths) {
  const output = execFileSync("git", ["ls-files", ...flags, "-z", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return [...new Set(output.split("\0").filter(Boolean))];
}

// Cached paths remain evidence for hygiene checks even after an unstaged deletion.
export function trackedFiles(root, paths = []) {
  return listFiles(root, ["--cached"], paths);
}

export function candidateFiles(root, paths = []) {
  return listFiles(root, ["--cached", "--others", "--exclude-standard"], paths)
    .filter(path => existsSync(resolve(root, path)));
}
