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
    "ci-linux-debug-tpm2-capability",
    "ci-linux-release-tpm2-capability",
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

test("Windows TPM presets are isolated and matching non-TPM presets stay dependency-free", () => {
  const presets = JSON.parse(source("CMakePresets.json"));
  const variants = [
    ["ci-windows-msvc-debug-dynamic", "ci-windows-msvc-debug-dynamic-tpm", "Debug"],
    ["ci-windows-msvc-debug-static", "ci-windows-msvc-debug-static-tpm", "Debug"],
    ["ci-windows-msvc-release-dynamic", "ci-windows-msvc-release-dynamic-tpm", "Release"],
    ["ci-windows-msvc-release-static", "ci-windows-msvc-release-static-tpm", "Release"],
  ];
  for (const [offName, tpmName, configuration] of variants) {
    const off = presets.configurePresets.find((preset) => preset.name === offName);
    const tpm = presets.configurePresets.find((preset) => preset.name === tpmName);
    assert.ok(off, `${offName} configure preset`);
    assert.ok(tpm, `${tpmName} configure preset`);
    assert.equal(off.cacheVariables.LCC_ENABLE_DEVICE_IDENTITY, "FALSE");
    assert.equal(off.cacheVariables.LCC_ENABLE_WINDOWS_TPM, "FALSE");
    assert.equal(off.cacheVariables.LCC_ENABLE_TPM2_OPENSSL, "FALSE");
    assert.equal(off.cacheVariables.LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER, "FALSE");
    assert.equal(tpm.inherits, offName);
    assert.equal(tpm.binaryDir, `\${sourceDir}/build/${tpmName}`);
    assert.equal(tpm.cacheVariables.CMAKE_INSTALL_PREFIX, `\${sourceDir}/build/${tpmName}/install`);
    assert.equal(tpm.cacheVariables.LCC_ENABLE_DEVICE_IDENTITY, "TRUE");
    assert.equal(tpm.cacheVariables.LCC_ENABLE_WINDOWS_TPM, "TRUE");
    assert.equal(tpm.cacheVariables.LCC_ENABLE_TPM2_OPENSSL, "FALSE");
    assert.equal(tpm.cacheVariables.LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER, "FALSE");
    assert.ok(presets.buildPresets.some((preset) =>
      preset.name === tpmName && preset.configurePreset === tpmName && preset.configuration === configuration));
    assert.ok(presets.testPresets.some((preset) =>
      preset.name === tpmName && preset.configurePreset === tpmName && preset.configuration === configuration));
  }

  for (const script of [source("scripts/check-build-purity.ps1"), source("scripts/dev-check.ps1")]) {
    for (const [, tpmName] of variants) assert.match(script, new RegExp(`"${tpmName}"`, "u"));
  }

  const library = source("src/library/CMakeLists.txt");
  const providerCmake = source("src/library/device_identity/CMakeLists.txt");
  assert.match(library, /if\(LCC_ENABLE_WINDOWS_TPM\)[\s\S]*target_link_libraries\(licensecc_static PUBLIC ncrypt\)/u);
  assert.match(providerCmake, /if\(LCC_ENABLE_WINDOWS_TPM\)[\s\S]*providers\/windows_tpm\.cpp/u);
  assert.match(providerCmake, /if\(LCC_ENABLE_WINDOWS_TPM\)[\s\S]*target_link_libraries\(device_identity PRIVATE ncrypt\)/u);
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

test("Windows TPM shim, real-test skip, consumers, and example remain explicit", () => {
  const provider = source("src/library/device_identity/providers/windows_tpm.cpp");
  const seam = source("src/library/device_identity/providers/windows_cng_api.hpp");
  const tests = source("test/library/device_identity/CMakeLists.txt");
  const runner = source("scripts/ci/run-installed-device-identity-consumer.ps1");
  const consumerCmake = source("test/consumer/device_identity/CMakeLists.txt");
  const exampleCmake = source("examples/device_identity/CMakeLists.txt");

  assert.match(seam, /make_windows_tpm_provider\(\s*std::shared_ptr<WindowsCngApi>/u);
  assert.doesNotMatch(provider, /static\s+.*WindowsCngApi/u);
  assert.match(provider, /MS_PLATFORM_CRYPTO_PROVIDER/u);
  assert.doesNotMatch(provider, /NCRYPT_OVERWRITE_KEY_FLAG/u);
  assert.doesNotMatch(provider, /NCRYPT_SECURITY_DESCR_PROPERTY|NCRYPT_UI_POLICY_PROPERTY/u);
  assert.match(tests, /add_test\(NAME device_identity_windows_shim/u);
  assert.match(tests, /add_test\(NAME device_identity_windows_real/u);
  assert.match(tests, /device_identity_windows_real PROPERTIES SKIP_RETURN_CODE 77/u);
  assert.match(runner, /\[ValidateSet\("Debug", "Release"\)\]/u);
  assert.match(runner, /\[string\]\$BuildDirectory/u);
  assert.match(runner, /\[switch\]\$ExpectWindowsTpm/u);
  assert.match(runner, /\[switch\]\$BuildWindowsTpmExample/u);
  assert.match(runner, /\[switch\]\$StaticRuntime/u);
  assert.match(runner, /CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDebug/u);
  assert.match(runner, /CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded/u);
  assert.match(consumerCmake, /LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM/u);
  assert.match(exampleCmake, /find_package\(licensecc CONFIG REQUIRED\)/u);
  assert.match(exampleCmake, /LCC_ENABLE_WINDOWS_TPM/u);
});

test("Ubuntu TPM2 capability probe is isolated, exact-digest, and simulator-scoped", () => {
  const capability = source("test/library/device_identity/tpm2_openssl_test.cpp");
  const testCmake = source("test/library/device_identity/CMakeLists.txt");
  const script = source("scripts/ci/run-swtpm-device-identity.sh");
  const workflow = source(".github/workflows/linux.yml");
  const presets = JSON.parse(source("CMakePresets.json"));

  assert.match(capability, /OSSL_LIB_CTX_new\(\)/u);
  assert.match(capability, /OSSL_PROVIDER_load\([^\n]*"default"/u);
  assert.match(capability, /OSSL_PROVIDER_load\([^\n]*"tpm2"/u);
  assert.match(capability, /EVP_PKEY_sign\(/u);
  assert.doesNotMatch(capability, /EVP_DigestSign/u);
  assert.match(capability, /der_to_p1363/u);
  assert.match(capability, /SHA256\(digest\)/u);
  assert.match(capability, /return\s+77/u);
  assert.match(testCmake, /LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST/u);
  assert.match(testCmake, /add_executable\(device_identity_tpm2_openssl_test\s+tpm2_openssl_test\.cpp\)/u);
  assert.match(script, /^set -euo pipefail/mu);
  assert.match(script, /swtpm\s+socket/u);
  assert.match(script, /TPM2OPENSSL_TCTI=/u);
  assert.match(script, /device_identity_tpm2_openssl_test/u);
  assert.match(script, /trap\s+/u);
  assert.match(workflow, /ubuntu-22\.04/u);
  assert.match(workflow, /ubuntu-24\.04/u);
  assert.match(workflow, /tpm2-openssl/u);
  assert.match(workflow, /run-swtpm-device-identity\.sh/u);

  for (const name of ["ci-linux-debug-tpm2-capability", "ci-linux-release-tpm2-capability"]) {
    const configure = presets.configurePresets.find((preset) => preset.name === name);
    assert.ok(configure, `${name} configure preset`);
    assert.equal(configure.cacheVariables.LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST, "TRUE");
    assert.equal(configure.cacheVariables.LCC_ENABLE_TPM2_OPENSSL, "FALSE");
    assert.equal(configure.cacheVariables.LCC_ENABLE_WINDOWS_TPM, "FALSE");
    assert.ok(presets.buildPresets.some((preset) => preset.name === name && preset.configurePreset === name));
    assert.ok(presets.testPresets.some((preset) => preset.name === name && preset.configurePreset === name));
  }
});

test("Ubuntu TPM2 production integration is explicit and remains opt-in", () => {
  const provider = source("src/library/device_identity/providers/tpm2_openssl.cpp");
  const presets = JSON.parse(source("CMakePresets.json"));
  const consumer = source("test/consumer/device_identity/CMakeLists.txt");
  const consumerSource = source("test/consumer/device_identity/cpp_link_smoke.cpp");
  const runner = source("scripts/ci/run-installed-device-identity-consumer.ps1");
  const swtpm = source("scripts/ci/run-swtpm-device-identity.sh");
  const example = source("examples/device_identity/CMakeLists.txt");
  const exampleReadme = source("examples/device_identity/README.md");
  const productionTest = source("test/library/device_identity/tpm2_openssl_test.cpp");
  const workflow = source(".github/workflows/linux.yml");

  for (const name of ["ci-linux-debug", "ci-linux-release", "ci-linux-core"]) {
    const configure = presets.configurePresets.find((preset) => preset.name === name);
    assert.equal(configure.cacheVariables.LCC_ENABLE_TPM2_OPENSSL, "FALSE", `${name} TPM2 OFF pin`);
  }
  for (const [name, configuration] of [["ci-linux-debug-tpm2", "Debug"], ["ci-linux-release-tpm2", "Release"]]) {
    const configure = presets.configurePresets.find((preset) => preset.name === name);
    assert.ok(configure, `${name} configure preset`);
    assert.equal(configure.cacheVariables.LCC_ENABLE_DEVICE_IDENTITY, "TRUE");
    assert.equal(configure.cacheVariables.LCC_ENABLE_WINDOWS_TPM, "FALSE");
    assert.equal(configure.cacheVariables.LCC_ENABLE_TPM2_OPENSSL, "TRUE");
    assert.equal(configure.cacheVariables.LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER, "FALSE");
    assert.equal(configure.cacheVariables.LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST, "FALSE");
    assert.ok(presets.buildPresets.some((preset) =>
      preset.name === name && preset.configurePreset === name && preset.configuration === configuration));
    assert.ok(presets.testPresets.some((preset) =>
      preset.name === name && preset.configurePreset === name && preset.configuration === configuration));
  }
  assert.match(consumer, /LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL/u);
  assert.match(consumer, /LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY/u);
  assert.match(consumerSource, /LCC_DEVICE_BACKEND_TPM2_OPENSSL/u);
  assert.match(consumerSource, /tpm2-openssl/u);
  assert.match(runner, /ExpectTpm2OpenSsl/u);
  assert.match(runner, /BuildTpm2OpenSslExample/u);
  assert.match(swtpm, /--real/u);
  assert.match(swtpm, /TPM2OPENSSL_TCTI=/u);
  assert.match(example, /LCC_ENABLE_TPM2_OPENSSL/u);
  assert.match(example, /licensecc_tpm2_openssl/u);
  assert.match(workflow, /build-linux-tpm2:/u);
  assert.match(workflow, /preset: ci-linux-debug-tpm2/u);
  assert.match(workflow, /preset: ci-linux-release-tpm2/u);
  assert.match(workflow, /run-swtpm-device-identity\.sh build\/\$\{\{ matrix\.preset \}\} build\/\$\{\{ matrix\.preset \}\}\/install/u);
  assert.doesNotMatch(provider, /std::getenv|std::system|tpm2-tools/u);
  assert.match(provider, /md_fetch\(libctx_, "SHA256", "provider=default"\)/u);
  assert.match(provider, /store_eof\(store\.get\(\)\) == 1/u);
  assert.match(provider, /AT_SYMLINK_FOLLOW/u);
  assert.match(provider, /\/proc\/self\/fd\//u);
  assert.match(provider, /store_open_ex\(uri\.c_str\(\), libctx_, "\?provider=tpm2"/u);
  assert.match(provider, /PrivateKeyInfo/u);
  assert.match(provider, /clear_free\(data_, size_\)/u);
  assert.match(provider, /d2i_public_key\(libctx_/u);
  assert.doesNotMatch(provider, /sha256\(spki\.data\(\)/u);
  assert.doesNotMatch(provider, /verify_p256_p1363\(spki/u);
  assert.match(provider, /cleanup_temporary\(directory, temporary, expected_identity\)/u);
  assert.match(provider, /ERR_GET_RFLAGS/u);
  assert.match(provider, /out of memory for object contexts/u);
  assert.match(provider, /O_NONBLOCK/u);
  assert.match(provider, /valid_tss2_private_pem/u);
  const packageConfig = source("src/cmake/licensecc-config.cmake");
  assert.match(packageConfig, /find_package\(OpenSSL 3\.0 REQUIRED COMPONENTS Crypto\)/u);
  assert.match(packageConfig, /elseif\("HAS_OPENSSL" IN_LIST COMPILE_DEF/u);
  assert.match(consumer, /NOT LCC_ENABLE_TPM2_OPENSSL/u);
  assert.match(consumer, /LCC_DEVICE_IDENTITY_PRE_FIND_OPENSSL/u);
  assert.match(consumer, /find_package\(OpenSSL 3\.0 REQUIRED COMPONENTS Crypto\)/u);
  assert.match(swtpm, /script_directory=/u);
  assert.match(exampleReadme, /TPM2OPENSSL_TCTI/u);
  assert.match(exampleReadme, /TPM2OPENSSL_PARENT_AUTH/u);
  assert.match(exampleReadme, /\/dev\/tpmrm0/u);
  assert.match(exampleReadme, /tpm2-abrmd/u);
  assert.match(exampleReadme, /not cryptographic erasure/u);
  assert.match(exampleReadme, /`tpm2-tools`\s+and `swtpm` are diagnostic\/CI-only/u);
  assert.match(exampleReadme, /\/proc\/self\/fd/u);
  assert.match(productionTest, /LCC_RUN_REAL_TPM2_TESTS/u);
  assert.match(source("test/library/device_identity/CMakeLists.txt"), /device_identity_tpm2_openssl_real/u);
});
