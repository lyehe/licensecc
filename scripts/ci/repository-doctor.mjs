import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function finding(severity, code, message, detail = undefined) {
  return { severity, code, message, ...(detail === undefined ? {} : { detail }) };
}

function toolFinding(tool) {
  if (!tool.available) return finding("warning", "DOCTOR_TOOL_MISSING", `${tool.name} is unavailable.`, tool.expected);
  if (!tool.matches) {
    return finding(
      "warning",
      "DOCTOR_TOOL_VERSION",
      `${tool.name} does not match the repository toolchain contract.`,
      `expected ${tool.expected}; found ${tool.actual}`,
    );
  }
  return null;
}

export function evaluateRepositorySnapshot(snapshot, { strictLocal = false } = {}) {
  const findings = [];
  if (snapshot.repositoryContract?.status !== 0) {
    const detail = snapshot.repositoryContract?.output?.split(/\r?\n/u).find(Boolean) ?? "architecture check unavailable";
    findings.push(finding("error", "DOCTOR_REPOSITORY_CONTRACT", "The canonical architecture/repository contract failed.", detail));
  }
  if ((snapshot.statusEntries ?? []).length > 0) {
    findings.push(finding("warning", "DOCTOR_DIRTY_WORKTREE", "The active worktree has preserved or uncommitted changes.", `${snapshot.statusEntries.length} entries`));
  }
  if ((snapshot.worktrees ?? []).length > 1) {
    findings.push(finding("warning", "DOCTOR_MULTIPLE_WORKTREES", "Multiple Git worktrees exist; keep only intentional active checkouts.", `${snapshot.worktrees.length} worktrees`));
  }
  if ((snapshot.branches ?? []).length > 10) {
    findings.push(finding("warning", "DOCTOR_BRANCH_ACCUMULATION", "Local branch count is above the repository hygiene target.", `${snapshot.branches.length} branches`));
  }

  const remotes = snapshot.remotes ?? {};
  if (remotes.origin && !/github\.com[/:]lyehe\/licensecc(?:\.git)?$/iu.test(remotes.origin)) {
    findings.push(finding("warning", "DOCTOR_ORIGIN_REMOTE", "origin should name the maintained lyehe/licensecc repository.", remotes.origin));
  }
  if (remotes.upstream && !/github\.com[/:]open-license-manager\/licensecc(?:\.git)?$/iu.test(remotes.upstream)) {
    findings.push(finding("warning", "DOCTOR_UPSTREAM_REMOTE", "upstream should name the historical open-license-manager repository.", remotes.upstream));
  }
  if (!remotes.origin) findings.push(finding("warning", "DOCTOR_ORIGIN_MISSING", "The canonical origin remote is missing."));
  if (!remotes.upstream) findings.push(finding("warning", "DOCTOR_UPSTREAM_MISSING", "The historical upstream remote is missing."));

  const divergence = snapshot.mainDivergence;
  if (divergence && (divergence.ahead > 0 || divergence.behind > 0)) {
    findings.push(finding("warning", "DOCTOR_MAIN_DIVERGENCE", "Local main is not synchronized with origin/main.", `${divergence.ahead} ahead, ${divergence.behind} behind`));
  }
  if ((snapshot.localOutputs ?? []).length > 0) {
    findings.push(finding("warning", "DOCTOR_LOCAL_OUTPUTS", "Ignored local output trees are present.", snapshot.localOutputs.join(", ")));
  }
  for (const tool of snapshot.tools ?? []) {
    const result = toolFinding(tool);
    if (result) findings.push(result);
  }

  findings.sort((left, right) => {
    const severity = { error: 0, warning: 1 };
    return severity[left.severity] - severity[right.severity]
      || left.code.localeCompare(right.code)
      || (left.detail ?? "").localeCompare(right.detail ?? "");
  });
  const errors = findings.filter(({ severity }) => severity === "error").length;
  const warnings = findings.length - errors;
  return {
    findings,
    summary: { errors, warnings },
    exitCode: errors > 0 || (strictLocal && warnings > 0) ? 1 : 0,
  };
}

function run(command, args, root = repositoryRoot) {
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", windowsHide: true });
  return {
    available: result.error?.code !== "ENOENT",
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function git(args, root = repositoryRoot) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function remoteUrls(root) {
  const remotes = {};
  for (const name of git(["remote"], root).split(/\r?\n/u).filter(Boolean)) {
    const result = run("git", ["remote", "get-url", name], root);
    if (result.status === 0) remotes[name] = result.output;
  }
  return remotes;
}

function versionTool(name, command, args, expected, matches, root) {
  const result = run(command, args, root);
  return {
    name,
    expected,
    available: result.available && result.status === 0,
    actual: result.output,
    matches: result.available && result.status === 0 && matches(result.output),
  };
}

function collectTools(root) {
  const toolchains = JSON.parse(readFileSync(resolve(root, "release-toolchains.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const npmVersion = packageJson.packageManager.replace(/^npm@/u, "");
  const npmTool = process.env.npm_execpath && existsSync(process.env.npm_execpath)
    ? versionTool("npm", process.execPath, [process.env.npm_execpath, "--version"], npmVersion, (value) => value.trim() === npmVersion, root)
    : versionTool("npm", "npm", ["--version"], npmVersion, (value) => value.trim() === npmVersion, root);
  return [
    {
      name: "Node.js",
      expected: packageJson.engines.node,
      available: true,
      actual: process.version,
      matches: Number(process.versions.node.split(".")[0]) >= 22,
    },
    npmTool,
    versionTool("Python", "python", ["--version"], toolchains.python_version, (value) => value.includes(toolchains.python_version), root),
    versionTool("uv", "uv", ["--version"], toolchains.uv_version, (value) => value.trim().startsWith(`uv ${toolchains.uv_version}`), root),
    versionTool(".NET SDK", "dotnet", ["--version"], toolchains.dotnet_sdk_version, (value) => value.trim() === toolchains.dotnet_sdk_version, root),
    versionTool("Java compiler", "javac", ["-version"], toolchains.java_version, (value) => value.includes(toolchains.java_version), root),
    versionTool("CMake", "cmake", ["--version"], ">=3.21", (value) => /cmake version (?:[3-9]\d?|\d{3,})\.(?:2[1-9]|[3-9]\d|\d{3,})|cmake version (?:[4-9]|\d{2,})\./u.test(value), root),
    versionTool("PowerShell", "pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], ">=7", (value) => Number(value.split(".")[0]) >= 7, root),
  ];
}

export function collectRepositorySnapshot({ root = repositoryRoot } = {}) {
  const architectureCheck = run(process.execPath, [resolve(root, "scripts/check-architecture.mjs")], root);
  const status = execFileSync("git", ["status", "--ignored", "--porcelain=v1", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).split("\0").filter(Boolean);
  const divergenceResult = run("git", ["rev-list", "--left-right", "--count", "main...origin/main"], root);
  let mainDivergence = null;
  if (divergenceResult.status === 0) {
    const [ahead, behind] = divergenceResult.output.split(/\s+/u).map(Number);
    mainDivergence = { ahead, behind };
  }
  return {
    repositoryContract: { status: architectureCheck.status, output: architectureCheck.output },
    statusEntries: status.filter((entry) => !entry.startsWith("!! ")),
    worktrees: git(["worktree", "list", "--porcelain"], root).split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)),
    branches: git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root).split(/\r?\n/u).filter(Boolean),
    remotes: remoteUrls(root),
    mainDivergence,
    localOutputs: status.filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3)),
    tools: collectTools(root),
  };
}

export function formatDoctorReport(result) {
  const lines = ["Licensecc repository doctor"];
  for (const item of result.findings) {
    lines.push(`${item.severity === "error" ? "ERROR" : "WARN "} ${item.code}: ${item.message}${item.detail ? ` (${item.detail})` : ""}`);
  }
  if (result.findings.length === 0) lines.push("OK    No repository contract or local-hygiene findings.");
  lines.push(`Summary: ${result.summary.errors} errors, ${result.summary.warnings} warnings`);
  return lines.join("\n");
}

function main() {
  const allowed = new Set(["--json", "--strict-local"]);
  const unknown = process.argv.slice(2).filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) throw new Error(`unknown repository-doctor argument: ${unknown.join(", ")}`);
  const result = evaluateRepositorySnapshot(collectRepositorySnapshot(), { strictLocal: process.argv.includes("--strict-local") });
  console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : formatDoctorReport(result));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
