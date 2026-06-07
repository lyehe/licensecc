import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cmake",
  ".cpp",
  ".css",
  ".h",
  ".hpp",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".rst",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function pathExt(path) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function isTextPath(path) {
  return TEXT_EXTENSIONS.has(pathExt(path)) || path.includes("CMakeLists.txt") || path.includes("Doxyfile");
}

function gitOutput(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function sanitizeDiffCheckOutput(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => /^[^:\n]+:\d+:/u.test(line))
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function runDiffCheck(args, label) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    label,
    command: `git ${args.join(" ")}`,
    status: result.status ?? 1,
    messages: sanitizeDiffCheckOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
  };
}

function untrackedTextFiles() {
  return gitOutput(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path !== "" && isTextPath(path));
}

function scanTrailingWhitespace(path, content) {
  return content.split("\n").flatMap((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    return /[ \t]$/u.test(line)
      ? [{ path, line: index + 1, kind: "trailing_whitespace" }]
      : [];
  });
}

function scanUntrackedWhitespace(files = untrackedTextFiles()) {
  const findings = [];
  for (const path of files) {
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanTrailingWhitespace(path, content));
  }
  return findings;
}

function runWorkspaceHygieneCheck() {
  const diff_checks = [
    runDiffCheck(["diff", "--check"], "unstaged tracked diff"),
    runDiffCheck(["diff", "--cached", "--check"], "staged tracked diff"),
  ];
  const untracked_findings = scanUntrackedWhitespace();
  return {
    ok: diff_checks.every((check) => check.status === 0) && untracked_findings.length === 0,
    diff_checks,
    untracked_findings,
  };
}

function main() {
  const result = runWorkspaceHygieneCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

export {
  isTextPath,
  runWorkspaceHygieneCheck,
  sanitizeDiffCheckOutput,
  scanTrailingWhitespace,
  scanUntrackedWhitespace,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
