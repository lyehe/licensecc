import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkCapabilityRegistry } from "./check-capability-registry.mjs";

const schemaSource = readFileSync(new URL("./capability-registry.schema.json", import.meta.url), "utf8");

function fixture(mutator = (registry) => registry) {
  const root = mkdtempSync(join(tmpdir(), "licensecc-capability-registry-"));
  const files = {
    "doc/capabilities/registry.json": "",
    "scripts/capability-registry.schema.json": schemaSource,
    "doc/capabilities/index.rst": "Capability registry\n===================\n\ncapability: shipped-capability\ncapability: experimental-capability\ncapability: platform-capability\ncapability: planned-capability\ncapability: deprecated-capability\n",
    "doc/public.rst": "Public documentation marker.",
    "doc/analysis/features.rst": "Current capability evidence.\n",
    "doc/guide.rst": "Current guide.\n",
    "doc/usage/concepts.rst": "Current concepts.\n",
    "sdks/dotnet/README.md": "Current .NET SDK support.\n",
    "src/implementation.txt": "implemented marker\nrepeated marker\nrepeated marker\n// comment implementation marker\n# comment automated marker",
    "test/implementation.test.mjs": "automated marker",
    "test/comment.py": "# comment automated marker",
    "src/comment-cases.ts": [
      "const blockStart = true; /* block comment begins",
      "multiline block marker",
      "*/",
      "const inlineComment = true; // inline slash marker",
      "const jsxComment = <div>{/* jsx block marker */}</div>;",
      "const stringLiteral = \"string literal marker\";",
      "    // indented slash marker",
      "    /* indented block marker */",
      "    {/* indented jsx marker */}",
      "    \"indented string marker\";",
    ].join("\n"),
    "test/comment-cases.py": [
      "value = 1 # python inline marker",
      "\"\"\"python docstring marker\"\"\"",
      "    # indented python marker",
      "    \"\"\"indented docstring marker\"\"\"",
    ].join("\n"),
    "src/control.h": "#define REAL_MACRO_MARKER 1\n    #define INDENTED_MACRO_MARKER 1",
    "test/control.test.mjs": "test(\"real test marker\", () => {});\n    test(\"indented test marker\", () => {});",
    "doc/platform.rst": "platform marker",
    "doc/limitation.rst": "limitation marker",
    "docs/plan.md": "plan marker",
    "docs/design.md": "design marker",
    "docs/fail-closed.md": "fail closed marker",
    "test/contracts/backend.json": JSON.stringify({
      service: "cloudflare-licensing-backend",
      allCanonicalRoutes: [{ method: "POST", path: "/v1/verify" }],
    }),
  };
  for (const [relativePath, source] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }

  const evidence = (kind, path, selector, surface = "public API") => ({ kind, path, selector, surface, assertion: `${kind} is evidenced` });
  const base = (id, status, statusEvidence) => ({
    id,
    title: `${id} title`,
    status,
    owner: "Documentation and architecture maintainer",
    surfaces: ["public API"],
    availability: { release: "test", platforms: ["test platform"], limitations: ["test limitation"] },
    evidence: [
      evidence("implementation", "src/implementation.txt", "implemented marker"),
      evidence("automated_test", "test/implementation.test.mjs", "automated marker"),
      ...statusEvidence,
    ],
    references: [],
    replaces: [],
    public_docs: ["doc/public.rst"],
  });
  const registry = {
    schema_version: 1,
    capabilities: [
      base("shipped-capability", "shipped", [evidence("route_contract", "test/contracts/backend.json", "POST /v1/verify")]),
      base("experimental-capability", "experimental", [evidence("limitation", "doc/limitation.rst", "limitation marker")]),
      base("platform-capability", "platform_limited", [
        evidence("platform", "doc/platform.rst", "platform marker"),
        evidence("limitation", "doc/limitation.rst", "limitation marker"),
      ]),
      {
        ...base("planned-capability", "planned", [
          evidence("plan", "docs/plan.md", "plan marker"),
          evidence("design", "docs/design.md", "design marker"),
        ]),
        evidence: [
          evidence("plan", "docs/plan.md", "plan marker"),
          evidence("design", "docs/design.md", "design marker"),
        ],
      },
      {
        ...base("deprecated-capability", "deprecated", []),
        evidence: [evidence("fail_closed", "docs/fail-closed.md", "fail closed marker")],
        replaces: ["shipped-capability"],
      },
    ],
  };
  writeFileSync(join(root, "doc/capabilities/registry.json"), `${JSON.stringify(mutator(registry), null, 2)}\n`);
  return { root, trackedPaths: Object.keys(files) };
}

function errors(result) {
  return result.errors.map(({ code }) => code);
}

function check(subject) {
  return checkCapabilityRegistry({ root: subject.root, trackedPaths: subject.trackedPaths });
}

test("accepts a complete registry using tracked evidence and contract selectors", (t) => {
  const subject = fixture();
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(check(subject).errors, []);
});

test("rejects duplicate identifiers and titles plus unknown status or owner", (t) => {
  const subject = fixture((registry) => {
    registry.capabilities[1].id = registry.capabilities[0].id;
    registry.capabilities[2].title = registry.capabilities[0].title;
    registry.capabilities[3].status = "future";
    registry.capabilities[4].owner = "";
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), ["duplicate_id", "duplicate_title", "invalid_status", "invalid_owner"]);
});

test("enforces the documented registry shape without a runtime schema dependency", (t) => {
  const subject = fixture((registry) => {
    registry.unexpected = true;
    registry.capabilities[0].unexpected = true;
    registry.capabilities[0].availability.unexpected = true;
    registry.capabilities[0].evidence[0].unexpected = true;
    registry.capabilities[1].evidence = {};
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), [
    "unknown_registry_field",
    "unknown_capability_field",
    "unknown_availability_field",
    "unknown_evidence_field",
    "invalid_evidence",
    "status_evidence",
  ]);
});

test("requires concrete platform and limitation availability facts", (t) => {
  const subject = fixture((registry) => {
    registry.capabilities[0].availability.platforms = [];
    registry.capabilities[1].availability.limitations = [];
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), ["invalid_availability", "invalid_availability"]);
});

test("requires a non-empty capability registry and schema contract file", (t) => {
  const empty = fixture((registry) => ({ ...registry, capabilities: [] }));
  const deletedSchema = fixture();
  const invalidSchema = fixture();
  deletedSchema.trackedPaths = deletedSchema.trackedPaths.filter((path) => path !== "scripts/capability-registry.schema.json");
  writeFileSync(join(invalidSchema.root, "scripts/capability-registry.schema.json"), "{");
  t.after(() => rmSync(empty.root, { recursive: true, force: true }));
  t.after(() => rmSync(deletedSchema.root, { recursive: true, force: true }));
  t.after(() => rmSync(invalidSchema.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(empty)), ["empty_capabilities"]);
  assert.deepEqual(errors(check(deletedSchema)), ["untracked_schema"]);
  assert.deepEqual(errors(check(invalidSchema)), ["invalid_schema_json"]);
});

test("rejects schema drift instead of treating the JSON Schema as an unverified comment", (t) => {
  const mutations = [
    (schema) => { schema.$defs.evidence.required = schema.$defs.evidence.required.filter((field) => field !== "selector"); },
    (schema) => { schema.$defs.capability.properties.surfaces.maxItems = 1; },
    (schema) => { schema.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const subject = fixture();
    const schemaPath = join(subject.root, "scripts/capability-registry.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    mutate(schema);
    writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
    t.after(() => rmSync(subject.root, { recursive: true, force: true }));
    assert.deepEqual(errors(check(subject)), ["schema_drift"]);
  }
});

test("enforces schema unique-item collections", (t) => {
  const subject = fixture((registry) => {
    const capability = registry.capabilities[0];
    capability.surfaces.push(capability.surfaces[0]);
    capability.availability.platforms.push(capability.availability.platforms[0]);
    capability.availability.limitations.push(capability.availability.limitations[0]);
    capability.public_docs.push(capability.public_docs[0]);
    capability.evidence.push({ ...capability.evidence[0] });
    capability.references = ["experimental-capability", "experimental-capability"];
    capability.replaces = ["planned-capability", "planned-capability"];
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), [
    "duplicate_surfaces",
    "duplicate_platforms",
    "duplicate_limitations",
    "duplicate_evidence",
    "invalid_references",
    "invalid_replaces",
    "duplicate_public_docs",
  ]);
});

test("requires evidence to name an advertised surface and covers every surface", (t) => {
  const subject = fixture((registry) => {
    registry.capabilities[0].evidence[0].surface = "unknown surface";
    registry.capabilities[1].surfaces.push("SDK API");
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), ["invalid_evidence_surface", "status_evidence", "surface_evidence", "surface_evidence"]);
});

test("accepts only a shipped inbound successor as deprecated replacement evidence", (t) => {
  const limitationEvidence = {
    kind: "limitation",
    path: "doc/limitation.rst",
    selector: "limitation marker",
    surface: "public API",
    assertion: "limitation is evidenced",
  };
  const inbound = fixture((registry) => {
    const deprecated = registry.capabilities[4];
    deprecated.evidence = [limitationEvidence];
    registry.capabilities[0].replaces = [deprecated.id];
    return registry;
  });
  const outbound = fixture((registry) => {
    const deprecated = registry.capabilities[4];
    deprecated.evidence = [limitationEvidence];
    deprecated.replaces = [registry.capabilities[0].id];
    return registry;
  });
  t.after(() => rmSync(inbound.root, { recursive: true, force: true }));
  t.after(() => rmSync(outbound.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(inbound)), []);
  assert.deepEqual(errors(check(outbound)), ["status_evidence"]);
});

test("rejects untracked paths and evidence selectors that are not literal source snippets", (t) => {
  const subject = fixture((registry) => {
    registry.capabilities[0].evidence[0].path = "src/untracked.txt";
    registry.capabilities[1].evidence[0].selector = "not present";
    registry.capabilities[2].public_docs = ["doc/untracked.rst"];
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), ["untracked_evidence_path", "missing_selector", "untracked_public_doc"]);
});

test("requires each non-route selector exactly once and rejects comment-only implementation evidence", (t) => {
  const duplicate = fixture((registry) => {
    registry.capabilities[0].evidence[0].selector = "repeated marker";
    return registry;
  });
  const comments = fixture((registry) => {
    registry.capabilities[0].evidence[0].selector = "// comment implementation marker";
    const automated = registry.capabilities[0].evidence.find((item) => item.kind === "automated_test");
    automated.path = "test/comment.py";
    automated.selector = "# comment automated marker";
    return registry;
  });
  t.after(() => rmSync(duplicate.root, { recursive: true, force: true }));
  t.after(() => rmSync(comments.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(duplicate)), ["duplicate_selector"]);
  assert.deepEqual(errors(check(comments)), ["comment_only_selector", "comment_only_selector"]);
});

test("rejects selectors beginning in lexical comments or literals while accepting real code", (t) => {
  const comments = fixture((registry) => {
    const capability = registry.capabilities[0];
    capability.evidence = [
      { kind: "implementation", path: "src/comment-cases.ts", selector: "multiline block marker", surface: "public API", assertion: "block comment" },
      { kind: "automated_test", path: "src/comment-cases.ts", selector: "inline slash marker", surface: "public API", assertion: "inline slash" },
      { kind: "automated_test", path: "src/comment-cases.ts", selector: "jsx block marker", surface: "public API", assertion: "JSX block" },
      { kind: "automated_test", path: "test/comment-cases.py", selector: "python inline marker", surface: "public API", assertion: "Python inline" },
      { kind: "automated_test", path: "src/comment-cases.ts", selector: "string literal marker", surface: "public API", assertion: "string literal" },
      { kind: "automated_test", path: "test/comment-cases.py", selector: "python docstring marker", surface: "public API", assertion: "docstring" },
    ];
    return registry;
  });
  const controls = fixture((registry) => {
    const capability = registry.capabilities[0];
    capability.evidence = [
      { kind: "implementation", path: "src/control.h", selector: "#define REAL_MACRO_MARKER 1", surface: "public API", assertion: "preprocessor macro" },
      { kind: "automated_test", path: "test/control.test.mjs", selector: "test(\"real test marker\"", surface: "public API", assertion: "test declaration" },
    ];
    return registry;
  });
  t.after(() => rmSync(comments.root, { recursive: true, force: true }));
  t.after(() => rmSync(controls.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(comments)), [
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
  ]);
  assert.deepEqual(check(controls).errors, []);
});

test("classifies an indented selector by its first non-whitespace token", (t) => {
  const comments = fixture((registry) => {
    const capability = registry.capabilities[0];
    capability.evidence = [
      { kind: "implementation", path: "src/comment-cases.ts", selector: "    // indented slash marker", surface: "public API", assertion: "indented slash" },
      { kind: "automated_test", path: "test/comment-cases.py", selector: "    # indented python marker", surface: "public API", assertion: "indented Python" },
      { kind: "automated_test", path: "src/comment-cases.ts", selector: "    \"indented string marker\"", surface: "public API", assertion: "indented string" },
      { kind: "automated_test", path: "test/comment-cases.py", selector: "    \"\"\"indented docstring marker\"\"\"", surface: "public API", assertion: "indented docstring" },
      { kind: "automated_test", path: "src/comment-cases.ts", selector: "    /* indented block marker */", surface: "public API", assertion: "indented block" },
      { kind: "automated_test", path: "src/comment-cases.ts", selector: "    {/* indented jsx marker */}", surface: "public API", assertion: "indented JSX" },
    ];
    return registry;
  });
  const controls = fixture((registry) => {
    const capability = registry.capabilities[0];
    capability.evidence = [
      { kind: "implementation", path: "src/control.h", selector: "    #define INDENTED_MACRO_MARKER 1", surface: "public API", assertion: "indented macro" },
      { kind: "automated_test", path: "test/control.test.mjs", selector: "    test(\"indented test marker\"", surface: "public API", assertion: "indented test declaration" },
    ];
    return registry;
  });
  t.after(() => rmSync(comments.root, { recursive: true, force: true }));
  t.after(() => rmSync(controls.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(comments)), [
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
    "comment_only_selector",
  ]);
  assert.deepEqual(check(controls).errors, []);
});

test("parses route-contract selectors instead of treating route keys as JSON text", (t) => {
  const subject = fixture((registry) => {
    registry.capabilities[0].evidence.at(-1).selector = "POST /v1/missing";
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), ["unknown_route_contract"]);
});

test("enforces status-specific evidence and valid capability references", (t) => {
  const subject = fixture((registry) => {
    registry.capabilities[0].evidence = registry.capabilities[0].evidence.filter((item) => item.kind !== "automated_test");
    registry.capabilities[1].evidence = registry.capabilities[1].evidence.filter((item) => item.kind !== "limitation");
    registry.capabilities[2].evidence = registry.capabilities[2].evidence.filter((item) => item.kind !== "platform");
    registry.capabilities[3].evidence.push({ kind: "implementation", path: "src/implementation.txt", selector: "implemented marker", surface: "public API", assertion: "claim" });
    registry.capabilities[4].replaces = ["missing-capability"];
    return registry;
  });
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), [
    "status_evidence",
    "status_evidence",
    "status_evidence",
    "planned_implementation_claim",
    "invalid_replaces",
  ]);
});

test("requires public capability entries in the index and rejects retired claims in public surfaces", (t) => {
  const subject = fixture();
  writeFileSync(join(subject.root, "doc/capabilities/index.rst"), "Capability registry\n===================\n");
  writeFileSync(join(subject.root, "doc/guide.rst"), "Travis CI publishes source-tree projects/ output.");
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), [
    "missing_index_representation",
    "missing_index_representation",
    "missing_index_representation",
    "missing_index_representation",
    "missing_index_representation",
    "retired_phrase",
    "retired_phrase",
  ]);
});

test("rejects targeted dev-check stale claims only in maintained documentation", (t) => {
  const subject = fixture();
  const workflowPath = join(subject.root, "doc/analysis/Development-And-Usage-Workflow.md");
  const historicalPlanPath = join(subject.root, "doc/analysis/historical-plan.md");
  mkdirSync(join(workflowPath, ".."), { recursive: true });
  writeFileSync(workflowPath, "The workflows call `scripts/dev-check.ps1` with CI presets.\nRoot npm shortcuts call the same PowerShell script.");
  writeFileSync(historicalPlanPath, "The workflows call `scripts/dev-check.ps1` with CI presets.");
  writeFileSync(join(subject.root, "doc/index.rst"), "run ``scripts/dev-check.ps1`` before submitting.");
  subject.trackedPaths.push("doc/analysis/Development-And-Usage-Workflow.md", "doc/analysis/historical-plan.md", "doc/index.rst");
  t.after(() => rmSync(subject.root, { recursive: true, force: true }));
  assert.deepEqual(errors(check(subject)), ["retired_phrase", "retired_phrase", "retired_phrase"]);
});
