import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepositoryFile = (relativePath) =>
  readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const cmake = readRepositoryFile("CMakeLists.txt");
const presets = JSON.parse(readRepositoryFile("CMakePresets.json"));
const fuzzCmake = readRepositoryFile("fuzz/CMakeLists.txt");
const activationHarness = readRepositoryFile("fuzz/activation_request_fuzzer.cpp");
const assertionHarness = readRepositoryFile("fuzz/online_assertion_fuzzer.cpp");
const workflow = readRepositoryFile(".github/workflows/native-security.yml");

test("sanitizers and fuzzers are opt-in, Clang-only, and fail closed", () => {
  assert.match(
    cmake,
    /option\(LCC_ENABLE_SANITIZERS\s+"[^"]+"\s+OFF\)/,
    "the sanitizer option must default to OFF",
  );
  assert.match(
    cmake,
    /option\(LCC_BUILD_FUZZERS\s+"[^"]+"\s+OFF\)/,
    "the fuzzer option must default to OFF",
  );
  assert.match(cmake, /CMAKE_CXX_COMPILER_ID MATCHES "Clang"/);
  assert.match(cmake, /LCC_BUILD_FUZZERS AND NOT BUILD_TESTING/);
  assert.match(cmake, /LCC_BUILD_FUZZERS AND NOT LCC_ENABLE_SANITIZERS/);

  const sanitizerConditional = cmake.slice(
    cmake.indexOf("if(LCC_ENABLE_SANITIZERS)"),
    cmake.indexOf("if(LCC_ENABLE_WINDOWS_TPM AND NOT WIN32)"),
  );
  assert.match(sanitizerConditional, /-fsanitize=address,undefined/);
  assert.match(sanitizerConditional, /-fno-omit-frame-pointer/);
  assert.match(sanitizerConditional, /-fno-sanitize-recover=all/);
  assert.match(sanitizerConditional, /-fsanitize=fuzzer-no-link/);
  assert.match(cmake, /if\(LCC_BUILD_FUZZERS\)\s+add_subdirectory\(fuzz\)\s+endif\(\)/);
});

test("only the dedicated Linux Clang preset enables native-security instrumentation", () => {
  const configurePresets = presets.configurePresets;
  const sanitizerPreset = configurePresets.find(({ name }) => name === "ci-linux-sanitizers");
  assert.ok(sanitizerPreset, "missing ci-linux-sanitizers configure preset");
  assert.equal(sanitizerPreset.inherits, "ci-linux-debug");
  assert.equal(sanitizerPreset.generator, "Ninja");
  assert.equal(sanitizerPreset.environment.CC, "clang");
  assert.equal(sanitizerPreset.environment.CXX, "clang++");
  assert.equal(sanitizerPreset.cacheVariables.LCC_ENABLE_SANITIZERS, "TRUE");
  assert.equal(sanitizerPreset.cacheVariables.LCC_BUILD_FUZZERS, "TRUE");

  for (const preset of configurePresets.filter(({ name }) => name !== "ci-linux-sanitizers")) {
    assert.notEqual(
      preset.cacheVariables?.LCC_ENABLE_SANITIZERS,
      "TRUE",
      `${preset.name} must not enable sanitizers`,
    );
    assert.notEqual(
      preset.cacheVariables?.LCC_BUILD_FUZZERS,
      "TRUE",
      `${preset.name} must not enable fuzzers`,
    );
  }

  assert.ok(
    presets.buildPresets.some(
      ({ name, configurePreset }) =>
        name === "ci-linux-sanitizers" && configurePreset === "ci-linux-sanitizers",
    ),
    "missing matching sanitizer build preset",
  );
  const testPreset = presets.testPresets.find(({ name }) => name === "ci-linux-sanitizers");
  assert.ok(testPreset, "missing matching sanitizer test preset");
  assert.match(testPreset.environment.ASAN_OPTIONS, /detect_leaks=1/);
  assert.match(testPreset.environment.ASAN_OPTIONS, /abort_on_error=1/);
  assert.match(testPreset.environment.UBSAN_OPTIONS, /halt_on_error=1/);
});

test("both libFuzzer harnesses enforce the same strict 16 KiB input cap", () => {
  assert.match(fuzzCmake, /target_link_options\([^\n]+-fsanitize=fuzzer\)/);
  assert.match(fuzzCmake, /fuzz_activation_request/);
  assert.match(fuzzCmake, /fuzz_online_assertion/);

  for (const [name, source] of [
    ["activation request", activationHarness],
    ["online assertion", assertionHarness],
  ]) {
    assert.match(source, /kMaxInputSize = 16U \* 1024U/);
    assert.match(source, /size > kMaxInputSize/, `${name} harness must reject oversized input`);
    assert.match(source, /LLVMFuzzerTestOneInput/);
  }
  assert.match(activationHarness, /parse_activation_request\(input, fields, error\)/);
  assert.match(assertionHarness, /split_envelope\(assertion, "lccoa1", "online assertion"/);
  assert.match(assertionHarness, /parse_fields_in_order/);
  assert.match(assertionHarness, /verify_assertion_envelope/);
});

test("fuzzer seeds are small, protocol-shaped, and synthetic", () => {
  const corpusRoots = [
    "fuzz/corpus/activation_request",
    "fuzz/corpus/online_assertion",
  ];
  for (const corpusRoot of corpusRoots) {
    const absoluteRoot = path.join(repositoryRoot, corpusRoot);
    const seeds = readdirSync(absoluteRoot);
    assert.ok(seeds.length >= 2, `${corpusRoot} must retain at least two seeds`);
    for (const seed of seeds) {
      const absoluteSeed = path.join(absoluteRoot, seed);
      assert.ok(statSync(absoluteSeed).size > 0, `${seed} must not be empty`);
      assert.ok(statSync(absoluteSeed).size <= 16 * 1024, `${seed} exceeds the harness cap`);
      const contents = readFileSync(absoluteSeed, "utf8");
      assert.doesNotMatch(contents, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
      assert.doesNotMatch(contents, /https?:\/\//i);
    }
  }
  assert.match(readRepositoryFile("fuzz/README.md"), /synthetic protocol-shaped data/i);
});

test("native-security workflow is least-privilege, pinned, and fully triggered", () => {
  assert.match(workflow, /\non:\s*\n/);
  assert.match(workflow, /\n {2}push:\s*\n/);
  assert.match(workflow, /\n {2}pull_request:\s*\n/);
  assert.match(workflow, /\n {2}schedule:\s*\n/);
  assert.match(workflow, /\n {2}workflow_dispatch:\s*\n/);
  assert.match(workflow, /permissions:\s*\n {2}contents: read\s*\n/);
  assert.doesNotMatch(workflow, /^\s+[\w-]+: write\s*$/m);
  assert.match(workflow, /persist-credentials: false/);

  const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actions.length > 0, "workflow must use the pinned checkout action");
  for (const action of actions) {
    assert.match(action, /@[0-9a-f]{40}$/i, `${action} must use a full commit SHA`);
  }
});

test("workflow runs the full sanitizer suite and bounds both corpus fuzz smokes", () => {
  assert.match(workflow, /cmake --preset ci-linux-sanitizers/);
  assert.match(workflow, /cmake --build --preset ci-linux-sanitizers/);
  assert.match(workflow, /ctest --preset ci-linux-sanitizers --no-tests=error/);
  assert.match(workflow, /fuzz\/corpus\/activation_request/);
  assert.match(workflow, /fuzz\/corpus\/online_assertion/);

  const maxLengths = [...workflow.matchAll(/-max_len=(\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(maxLengths, [16384, 16384]);
  const fuzzBudgets = [...workflow.matchAll(/-max_total_time=(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(fuzzBudgets.length, 2);
  assert.ok(fuzzBudgets.every((seconds) => seconds > 0 && seconds <= 30));
  const processBudgets = [...workflow.matchAll(/--kill-after=5s (\d+)s/g)].map((match) => Number(match[1]));
  assert.deepEqual(processBudgets, [30, 30]);
  assert.doesNotMatch(workflow, /\b(?:curl|wget)\b/);
});
