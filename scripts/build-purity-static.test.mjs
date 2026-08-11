import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function source(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function activeRunLines(workflow, jobName) {
  const lines = workflow.split(/\r?\n/u);
  const jobStart = lines.findIndex((line) => new RegExp(`^(\\s*)${jobName}:\\s*$`, "u").test(line));
  assert.notEqual(jobStart, -1, `workflow job ${jobName} must exist`);
  const jobIndent = lines[jobStart].match(/^\s*/u)[0].length;
  const job = [];
  for (let index = jobStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.trimStart().startsWith("#") && line.match(/^\s*/u)[0].length <= jobIndent) break;
    job.push(line);
  }

  const commands = [];
  for (let index = 0; index < job.length; index += 1) {
    const run = job[index].match(/^(\s*)run:\s*(.*)$/u);
    if (!run) continue;
    if (run[2] && run[2] !== "|") {
      commands.push(run[2].trim());
      continue;
    }
    const runIndent = run[1].length;
    for (index += 1; index < job.length; index += 1) {
      const command = job[index];
      if (command.trim() && command.match(/^\s*/u)[0].length <= runIndent) {
        index -= 1;
        break;
      }
      if (command.trim() && !command.trimStart().startsWith("#")) commands.push(command.trim());
    }
  }
  return commands;
}

test("CMake generator discovery is read-only and has one recovery path", () => {
  const finder = source("cmake/Findlccgen.cmake");
  const root = source("CMakeLists.txt");
  const library = source("src/library/CMakeLists.txt");

  for (const cmake of [finder, root, library]) {
    assert.doesNotMatch(cmake, /find_package\s*\(\s*Git\b/i);
    assert.doesNotMatch(cmake, /GIT_SUBMODULE/i);
    assert.doesNotMatch(cmake, /execute_process\s*\([^)]*git/i);
  }
  assert.match(finder, /LCC_LOCATION/);
  assert.match(finder, /extern\/license-generator\/CMakeLists\.txt/);
  assert.doesNotMatch(finder, /bootstrap\.ps1/);
  assert.match(root, /add_custom_command\s*\(\s*OUTPUT\s+"\$\{LCC_PROJECT_PUBLIC_KEY\}"/s);
  assert.match(root, /add_custom_target\s*\(\s*project_public_header\s+DEPENDS\s+"\$\{LCC_PROJECT_PUBLIC_KEY\}"/s);
  assert.match(root, /DEPENDS\s+license_generator::lccgen/s);
  assert.match(root, /CMAKE_BINARY_DIR/);
  assert.match(root, /string\(TOLOWER/s);
  assert.match(root, /CMAKE_BINARY_DIR must resolve outside and must not contain the source tree/);
  assert.doesNotMatch(root, /add_custom_target\s*\(\s*project_initialize/i);
  assert.doesNotMatch(root, /(?:OUTPUT|BYPRODUCTS)[^\n)]*private_key/i);
  assert.doesNotMatch(root, /install\([^)]*private_key/i);
  assert.match(library, /add_dependencies\(licensecc_static project_public_header\)/);
});

test("generator test support is explicit before CTest creates test targets", () => {
  const finder = source("cmake/Findlccgen.cmake");
  const root = source("CMakeLists.txt");
  const functionalTests = source("test/functional/CMakeLists.txt");
  const libraryTests = source("test/library/CMakeLists.txt");

  assert.match(finder, /LCCGEN_TEST_SUPPORT_TARGET/);
  assert.match(finder, /license_generator::test_support/);
  assert.match(root, /option\(BUILD_TESTING\s+"Build the testing tree\."\s+ON\)/);
  assert.match(root, /BUILD_TESTING=ON requires generator test support/);

  for (const tests of [functionalTests, libraryTests]) {
    assert.doesNotMatch(tests, /\blicense_generator_lib\b/);
    assert.match(tests, /\$\{LCCGEN_TEST_SUPPORT_TARGET\}/);
  }
});

test("developer checks do not edit or invoke Git", () => {
  const devCheck = source("scripts/dev-check.ps1");

  assert.doesNotMatch(devCheck, /\bgit\b/i);
  assert.doesNotMatch(devCheck, /\bapply\b/i);
  assert.doesNotMatch(devCheck, /license-generator-cstdint\.patch/i);
  assert.match(devCheck, /check-build-purity\.ps1/i);
});

test("presets and Python marker keep all generated state below build", () => {
  const presets = JSON.parse(source("CMakePresets.json"));
  const ignored = source(".gitignore");

  for (const preset of presets.configurePresets) {
    const installPrefix = preset.cacheVariables?.CMAKE_INSTALL_PREFIX;
    assert.equal(
      installPrefix,
      `\${sourceDir}/build/${preset.name}/install`,
      `${preset.name} install prefix`,
    );
  }
  assert.match(ignored, /^\/pyvenv\.cfg$/m);
  assert.match(ignored, /^\/\.venv\/$/m);
});

test("purity and bootstrap scripts retain the explicit operational boundaries", () => {
  const bootstrap = source("scripts/bootstrap.ps1");
  const purity = source("scripts/check-build-purity.ps1");

  assert.match(bootstrap, /CheckOnly/);
  assert.match(bootstrap, /Generator vendored/);
  assert.doesNotMatch(bootstrap, /\bsubmodule\b/i);
  assert.doesNotMatch(bootstrap, /\bgit\b/i);
  assert.match(purity, /finally/i);
  assert.match(purity, /--untracked-files=all/);
  assert.match(purity, /projects/i);
  assert.match(purity, /install/i);
});

test("CI uses purity checks and local preset installation paths", () => {
  const linux = source(".github/workflows/linux.yml");
  const windows = source(".github/workflows/windows.yml");

  for (const workflow of [linux, windows]) {
    assert.match(workflow, /check-build-purity\.ps1/);
    assert.match(workflow, /bootstrap\.ps1 -CheckOnly/);
    assert.doesNotMatch(workflow, /C:\/licensecc/i);
    assert.doesNotMatch(workflow, /\bsubmodules\s*:/i);
  }
  assert.match(windows, /\.\/build\/\$\{\{ matrix\.preset \}\}\/install\/bin\/test\/lccinspector\.exe/);
});

test("device-identity presets are accepted by both PowerShell entrypoints", () => {
  const presetNames = [
    "dev-device-identity-off",
    "dev-device-identity-test",
    "ci-linux-device-identity-test",
    "ci-windows-device-identity-test",
  ];
  for (const script of [source("scripts/check-build-purity.ps1"), source("scripts/dev-check.ps1")]) {
    for (const preset of presetNames) assert.match(script, new RegExp(`"${preset}"`, "u"));
  }
});

test("platform CI actively runs the exact identity suite and installed consumers", () => {
  const cases = [
    {
      workflow: source(".github/workflows/linux.yml"),
      job: "build-linux",
      preset: "ci-linux-device-identity-test",
    },
    {
      workflow: source(".github/workflows/windows.yml"),
      job: "build-windows",
      preset: "ci-windows-device-identity-test",
    },
  ];
  for (const item of cases) {
    const commands = activeRunLines(item.workflow, item.job);
    assert.ok(item.workflow.split(/\r?\n/u).some((line) =>
      !line.trimStart().startsWith("#") && line.includes(item.preset)));
    assert.ok(commands.some((line) => line === "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset ${{ matrix.preset }}"));
    assert.ok(commands.some((line) => line === `ctest --preset ${item.preset} --no-tests=error -R "^device_identity_(abi|vectors|policy|concurrency)_test$"`));
    assert.ok(commands.some((line) => line.startsWith(`cmake --install build/${item.preset} `)));
    assert.ok(commands.some((line) => line === `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/ci/run-installed-device-identity-consumer.ps1 -InstallPrefix build/${item.preset}/install -RequireC99`));
  }

  const windowsCommands = activeRunLines(source(".github/workflows/windows.yml"), "build-windows");
  assert.ok(windowsCommands.some((line) => /^\$cachePath\s*=.*CMakeCache\.txt/u.test(line)));
  assert.ok(windowsCommands.some((line) => /CMAKE_LINKER:FILEPATH=/u.test(line)));
  assert.ok(windowsCommands.some((line) => /\$linkerEntries\.Count\s+-ne\s+1/u.test(line)));
  assert.ok(windowsCommands.some((line) => /Test-Path\s+-LiteralPath\s+\$linker\s+-PathType\s+Leaf/u.test(line)));
  assert.ok(windowsCommands.some((line) => /^\$dumpbin\s*=\s*Join-Path\s+.*dumpbin\.exe/u.test(line)));
  assert.ok(windowsCommands.some((line) => /Test-Path\s+-LiteralPath\s+\$dumpbin\s+-PathType\s+Leaf/u.test(line)));
  assert.ok(windowsCommands.some((line) => /^\$imports\s*=\s*&\s*\$dumpbin\s+\/dependents/u.test(line)));
  assert.ok(windowsCommands.some((line) => /^if\s*\(\$imports\s+-match\s+.*(?:ssl|crypto)/iu.test(line)));
  assert.ok(windowsCommands.some((line) => /^\$directives\s*=\s*&\s*\$dumpbin\s+\/directives/u.test(line)));
  assert.ok(windowsCommands.some((line) => /^if\s*\(\$directives\s+-match\s+.*(?:ssl|crypto)/iu.test(line)));
  assert.doesNotMatch(windowsCommands.join("\n"), /&\s*dumpbin(?:\.exe)?\b/iu);
});

test("installed consumer makes C99 mandatory only when its CI gate requests it", () => {
  const runner = source("scripts/ci/run-installed-device-identity-consumer.ps1");
  const cmake = source("test/consumer/device_identity/CMakeLists.txt");

  assert.match(runner, /\[switch\]\$RequireC99/u);
  assert.match(runner, /LCC_DEVICE_IDENTITY_REQUIRE_C99=ON/u);
  assert.match(runner, /LCC_DEVICE_IDENTITY_REQUIRE_C99=OFF/u);
  assert.match(cmake, /option\(\s*LCC_DEVICE_IDENTITY_REQUIRE_C99\s+"[^"]*"\s+OFF\s*\)/u);
  assert.match(cmake, /elseif\(LCC_DEVICE_IDENTITY_REQUIRE_C99\)[\s\S]*message\(FATAL_ERROR\s+"[^"]*C99/u);
  assert.match(cmake, /C_STANDARD\s+99/u);
});

test("platform identity CI presets pin isolated feature-enabled builds", () => {
  const presets = JSON.parse(source("CMakePresets.json"));
  for (const name of ["ci-linux-device-identity-test", "ci-windows-device-identity-test"]) {
    const configure = presets.configurePresets.find((preset) => preset.name === name);
    assert.ok(configure, `${name} configure preset`);
    assert.equal(configure.binaryDir, `\${sourceDir}/build/${name}`);
    assert.equal(configure.cacheVariables.CMAKE_INSTALL_PREFIX, `\${sourceDir}/build/${name}/install`);
    assert.equal(configure.cacheVariables.LCC_ENABLE_DEVICE_IDENTITY, "TRUE");
    assert.equal(configure.cacheVariables.LCC_ENABLE_WINDOWS_TPM, "FALSE");
    assert.equal(configure.cacheVariables.LCC_ENABLE_TPM2_OPENSSL, "FALSE");
    assert.equal(configure.cacheVariables.LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER, "TRUE");
    assert.ok(presets.buildPresets.some((preset) => preset.name === name && preset.configurePreset === name));
    assert.ok(presets.testPresets.some((preset) => preset.name === name && preset.configurePreset === name));
  }
  const windows = presets.configurePresets.find((preset) => preset.name === "ci-windows-device-identity-test");
  assert.equal(windows.cacheVariables.CMAKE_DISABLE_FIND_PACKAGE_OpenSSL, "TRUE");
});

test("device-identity sensitive state and provider metadata use centralized contracts", () => {
  const crypto = source("src/library/device_identity/p256_crypto.hpp");
  const provider = source("src/library/device_identity/device_key_provider.hpp");
  const windowsCrypto = source("src/library/device_identity/p256_crypto_windows.cpp");
  const opensslProvider = source("src/library/device_identity/providers/software_test.cpp");

  assert.match(crypto, /class\s+SensitiveArray/);
  assert.match(crypto, /class\s+SensitiveVector/);
  assert.match(windowsCrypto, /SensitiveVector\s+object/);
  assert.match(provider, /provider_contract_for_backend/);
  assert.match(provider, /provider_metadata_matches_contract/);
  assert.match(opensslProvider, /unique_ptr<EVP_PKEY_CTX/);
});

test("installed C smoke is linked into and called by the C++ consumer", () => {
  const cmake = source("test/consumer/device_identity/CMakeLists.txt");
  const consumer = source("test/consumer/device_identity/cpp_link_smoke.cpp");

  assert.match(cmake, /\$<TARGET_OBJECTS:device_identity_c_header_smoke>/);
  assert.match(cmake, /LCC_DEVICE_IDENTITY_C_SMOKE_LINKED=1/);
  assert.match(consumer, /extern\s+"C"\s+int\s+lcc_device_identity_c_header_smoke\(void\)/);
  assert.match(consumer, /if\s*\(lcc_device_identity_c_header_smoke\(\)\s*!=\s*0\)/);
});
