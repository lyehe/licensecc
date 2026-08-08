import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function source(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
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
  assert.match(finder, /bootstrap\.ps1/);
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
  assert.match(bootstrap, /submodule\s+update\s+--init\s+--recursive/);
  assert.doesNotMatch(bootstrap, /--remote/);
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
  }
  assert.match(windows, /\.\/build\/\$\{\{ matrix\.preset \}\}\/install\/bin\/test\/lccinspector\.exe/);
});
