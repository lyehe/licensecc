import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "sdks", "java", "src");
const output = join(root, "build", "java-sdk");
const classes = join(output, "classes");
const tests = join(output, "test-classes");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith(".java") ? [path] : [];
  }).sort((left, right) => Buffer.from(relative(root, left)).compare(Buffer.from(relative(root, right))));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(classes, { recursive: true });
mkdirSync(tests, { recursive: true });

run("javac", ["--release", "17", "-Xlint:all", "-Werror", "-d", classes,
  ...files(join(sourceRoot, "main", "java"))]);
run("javac", ["--release", "17", "--add-modules", "jdk.httpserver", "-Xlint:all", "-Werror",
  "-cp", classes, "-d", tests, ...files(join(sourceRoot, "test", "java"))]);
run("java", ["--add-modules", "jdk.httpserver", "-cp", `${classes}${process.platform === "win32" ? ";" : ":"}${tests}`,
  "io.licensecc.client.SdkTest", root]);
run("jar", ["--create", "--file", join(output, "licensecc-client-0.1.0-rc.1.jar"),
  "--manifest", join(root, "sdks", "java", "MANIFEST.MF"), "-C", classes, "."]);
