import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryRelativePath = "doc/capabilities/registry.json";
const schemaRelativePath = "scripts/capability-registry.schema.json";
const indexRelativePath = "doc/capabilities/index.rst";
const retiredClaims = Object.freeze([
  "not yet implemented",
  "not yet on `main`",
  "not yet on main",
  "travis",
  "supported visual studio versions are:",
  "visual studio 2017 used in",
  "ubuntu 18.04-cross compile",
  "usually in ``projects/",
  "source-tree projects/",
  "workflows call `scripts/dev-check.ps1` with ci presets",
  "root npm shortcuts call the same powershell script",
  "run ``scripts/dev-check.ps1`` before submitting.",
]);
const statuses = new Set(["shipped", "experimental", "platform_limited", "planned", "deprecated"]);
const statusesRequiringImplementation = new Set(["shipped", "experimental", "platform_limited"]);
const owners = new Set([
  "C++ ABI and core maintainer",
  "Shared licensing-domain maintainer",
  "Shared Cloudflare-runtime maintainer",
  "Backend deployable maintainer",
  "Admin deployable maintainer",
  "Customer-portal deployable maintainer",
  "D1-backup deployable maintainer",
  "SDK maintainer",
  "API-contract maintainer",
  "Release and CI maintainer",
  "Documentation and architecture maintainer",
]);
const evidenceKinds = new Set([
  "implementation",
  "automated_test",
  "route_contract",
  "platform",
  "limitation",
  "plan",
  "design",
  "fail_closed",
]);
const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const routeSelector = /^([A-Z]+) (\/\S*)$/;
const registryFields = new Set(["schema_version", "capabilities"]);
const capabilityFields = new Set(["id", "title", "status", "owner", "surfaces", "availability", "evidence", "references", "replaces", "public_docs"]);
const availabilityFields = new Set(["release", "platforms", "limitations"]);
const evidenceFields = new Set(["kind", "path", "selector", "surface", "assertion"]);

function normalize(relativePath) {
  return String(relativePath).replaceAll("\\", "/");
}

function isSafeRelativePath(value) {
  const path = normalize(value);
  return path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:\//.test(path) && !path.split("/").includes("..");
}

function trackedPathsFromGit(root) {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(normalize);
}

function sourceAt(root, relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function addError(errors, code, capability, detail) {
  errors.push({ code, capability: capability?.id ?? null, detail });
}

function rejectUnknownFields(value, allowed, code, capability, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) addError(errors, code, capability, field);
  }
}

function expectedSchema() {
  const identifierSchema = { type: "string", minLength: 1, pattern: identifier.source };
  const stringSchema = { type: "string", minLength: 1 };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://licensecc.dev/schemas/capability-registry.schema.json",
    title: "Licensecc capability registry",
    description: "Versioned, static evidence inventory. The repository checker applies cross-entry, tracked-file, selector, route-contract, and status rules that JSON Schema cannot express.",
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "capabilities"],
    properties: {
      schema_version: { const: 1 },
      capabilities: { type: "array", minItems: 1, items: { $ref: "#/$defs/capability" } },
    },
    $defs: {
      capability: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "status", "owner", "surfaces", "availability", "evidence", "replaces", "public_docs"],
        properties: {
          id: identifierSchema,
          title: stringSchema,
          status: { enum: [...statuses] },
          owner: { enum: [...owners] },
          surfaces: { type: "array", minItems: 1, items: stringSchema, uniqueItems: true },
          availability: {
            type: "object",
            additionalProperties: false,
            required: ["release", "platforms", "limitations"],
            properties: {
              release: stringSchema,
              platforms: { type: "array", minItems: 1, items: stringSchema, uniqueItems: true },
              limitations: { type: "array", minItems: 1, items: stringSchema, uniqueItems: true },
            },
          },
          evidence: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/$defs/evidence" } },
          references: { type: "array", items: { $ref: "#/$defs/capabilityId" }, uniqueItems: true },
          replaces: { type: "array", items: { $ref: "#/$defs/capabilityId" }, uniqueItems: true },
          public_docs: { type: "array", minItems: 1, items: stringSchema, uniqueItems: true },
        },
      },
      capabilityId: identifierSchema,
      evidence: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "selector", "surface", "assertion"],
        properties: {
          kind: { enum: [...evidenceKinds] },
          path: stringSchema,
          selector: stringSchema,
          surface: stringSchema,
          assertion: stringSchema,
        },
      },
    },
  };
}

function schemaDrift(schema) {
  return canonicalValue(schema) === canonicalValue(expectedSchema()) ? null : "schema must exactly match the checker contract";
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hasDuplicates(values, key = (value) => value) {
  const seen = new Set();
  return values.some((value) => {
    const normalized = key(value);
    if (seen.has(normalized)) return true;
    seen.add(normalized);
    return false;
  });
}

function hasEvidence(evidenceByKind, ...required) {
  return required.every((kind) => evidenceByKind.has(kind));
}

function routeKeys(contract) {
  const keys = new Set();
  for (const [name, value] of Object.entries(contract)) {
    if (!Array.isArray(value)) continue;
    if (name === "allCanonicalRoutes" || name === "ALL_ROUTES" || name.endsWith("_ROUTES")) {
      for (const route of value) {
        if (route && typeof route.method === "string" && typeof route.path === "string") {
          keys.add(`${route.method} ${route.path}`);
        }
      }
    }
    if (name.endsWith("ROUTE_KEYS")) {
      for (const key of value) if (typeof key === "string") keys.add(key);
    }
  }
  return keys;
}

function validateRouteContract(root, evidence, capability, errors) {
  const path = normalize(evidence.path);
  if (!/^test\/contracts\/[^/]+\.json$/u.test(path)) {
    addError(errors, "invalid_route_contract_path", capability, path);
    return;
  }
  const match = routeSelector.exec(evidence.selector);
  if (!match) {
    addError(errors, "invalid_route_contract_selector", capability, evidence.selector);
    return;
  }
  try {
    const contract = JSON.parse(sourceAt(root, path));
    if (!routeKeys(contract).has(evidence.selector)) {
      addError(errors, "unknown_route_contract", capability, evidence.selector);
    }
  } catch {
    addError(errors, "invalid_route_contract", capability, path);
  }
}

function selectorOffsets(source, selector) {
  const offsets = [];
  let offset = source.indexOf(selector);
  while (offset !== -1) {
    offsets.push(offset);
    offset = source.indexOf(selector, offset + 1);
  }
  return offsets;
}

function regexLiteralStartsAt(source, offset) {
  const prefix = source.slice(0, offset).trimEnd();
  if (prefix.endsWith("=>")) return true;
  return prefix.length === 0 || /[([{=,:;!&|?]$/u.test(prefix);
}

/** Return true when a selector starts in a comment, string, or Python docstring. */
function selectorStartsInNonCode(source, offset, path) {
  const python = /\.pyi?$/iu.test(path);
  let state = "code";
  let cursor = 0;
  while (cursor < offset) {
    const character = source[cursor];
    const next = source[cursor + 1];
    const triple = source.slice(cursor, cursor + 3);
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      cursor += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        cursor += 2;
      } else cursor += 1;
      continue;
    }
    if (state === "regex") {
      if (character === "\\") cursor += 2;
      else if (character === "/") {
        state = "code";
        cursor += 1;
      } else cursor += 1;
      continue;
    }
    if (state === "triple-single" || state === "triple-double") {
      const delimiter = state === "triple-single" ? "'''" : '"""';
      if (triple === delimiter) {
        state = "code";
        cursor += 3;
      } else cursor += 1;
      continue;
    }
    if (state === "single-quote" || state === "double-quote" || state === "template") {
      const delimiter = state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";
      if (character === "\\") cursor += 2;
      else if (character === delimiter) {
        state = "code";
        cursor += 1;
      } else cursor += 1;
      continue;
    }

    if (python && (triple === "'''" || triple === '"""')) {
      state = triple === "'''" ? "triple-single" : "triple-double";
      cursor += 3;
    } else if (!python && character === "/" && next === "/") {
      state = "line-comment";
      cursor += 2;
    } else if (!python && character === "/" && next === "*") {
      state = "block-comment";
      cursor += 2;
    } else if (!python && character === "/" && regexLiteralStartsAt(source, cursor)) {
      state = "regex";
      cursor += 1;
    } else if (python && character === "#") {
      state = "line-comment";
      cursor += 1;
    } else if (character === "'") {
      state = "single-quote";
      cursor += 1;
    } else if (character === '"') {
      state = "double-quote";
      cursor += 1;
    } else if (character === "`") {
      state = "template";
      cursor += 1;
    } else cursor += 1;
  }
  if (state !== "code") return true;
  const triple = source.slice(offset, offset + 3);
  return python && source[offset] === "#"
    || !python && (source.startsWith("//", offset) || source.startsWith("/*", offset))
    || python && (triple === "'''" || triple === '"""')
    || source[offset] === "'" || source[offset] === '"' || source[offset] === "`";
}

function validateEvidence(root, trackedPaths, capability, errors) {
  const evidenceByKind = new Map();
  if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
    addError(errors, "invalid_evidence", capability, "evidence must be a non-empty array");
    return evidenceByKind;
  }
  if (hasDuplicates(capability.evidence, canonicalValue)) addError(errors, "duplicate_evidence", capability, "evidence contains duplicate items");
  for (const evidence of capability.evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      addError(errors, "invalid_evidence", capability, "evidence must be an object");
      continue;
    }
    const { kind, path, selector, surface, assertion } = evidence;
    rejectUnknownFields(evidence, evidenceFields, "unknown_evidence_field", capability, errors);
    if (!evidenceKinds.has(kind) || typeof assertion !== "string" || !assertion.trim()) {
      addError(errors, "invalid_evidence", capability, kind ?? "missing kind");
      continue;
    }
    if (typeof surface !== "string" || !capability.surfaces?.includes(surface)) {
      addError(errors, "invalid_evidence_surface", capability, surface ?? "missing surface");
      continue;
    }
    const coveredSurfaces = evidenceByKind.get(kind) ?? new Set();
    coveredSurfaces.add(surface);
    evidenceByKind.set(kind, coveredSurfaces);
    if (typeof path !== "string" || !isSafeRelativePath(path) || !trackedPaths.has(normalize(path))) {
      addError(errors, "untracked_evidence_path", capability, path ?? "missing path");
      continue;
    }
    if (typeof selector !== "string" || !selector.trim()) {
      addError(errors, "invalid_selector", capability, path);
      continue;
    }
    if (kind === "route_contract") {
      validateRouteContract(root, evidence, capability, errors);
      continue;
    }
    try {
      const source = sourceAt(root, path);
      const offsets = selectorOffsets(source, selector);
      if (offsets.length === 0) addError(errors, "missing_selector", capability, selector);
      else if (offsets.length > 1) addError(errors, "duplicate_selector", capability, selector);
      else if ((kind === "implementation" || kind === "automated_test") && selectorStartsInNonCode(source, offsets[0], path)) addError(errors, "comment_only_selector", capability, selector);
    } catch {
      addError(errors, "unreadable_evidence_path", capability, path);
    }
  }
  return evidenceByKind;
}

function validateSurfaceCoverage(capability, evidenceByKind, errors) {
  if (!statusesRequiringImplementation.has(capability.status)) return;
  for (const kind of ["implementation", "automated_test"]) {
    const covered = evidenceByKind.get(kind);
    if (!covered) continue;
    for (const surface of capability.surfaces ?? []) {
      if (!covered.has(surface)) addError(errors, "surface_evidence", capability, `${kind} missing for ${surface}`);
    }
  }
}

function validateStatus(capability, evidenceByKind, hasReplacement, errors) {
  switch (capability.status) {
    case "shipped":
      if (!hasEvidence(evidenceByKind, "implementation", "automated_test")) addError(errors, "status_evidence", capability, "shipped requires implementation and automated_test evidence");
      break;
    case "experimental":
      if (!hasEvidence(evidenceByKind, "implementation", "automated_test", "limitation")) addError(errors, "status_evidence", capability, "experimental requires implementation, automated_test, and limitation evidence");
      break;
    case "platform_limited":
      if (!hasEvidence(evidenceByKind, "implementation", "automated_test", "platform", "limitation")) addError(errors, "status_evidence", capability, "platform_limited requires implementation, automated_test, platform, and limitation evidence");
      break;
    case "planned": {
      const plannedOnly = [...evidenceByKind].every(([kind]) => kind === "plan" || kind === "design");
      if ((!evidenceByKind.has("plan") && !evidenceByKind.has("design")) || !plannedOnly) addError(errors, "planned_implementation_claim", capability, "planned evidence must be plan/design only");
      break;
    }
    case "deprecated":
      if (!hasReplacement && !evidenceByKind.has("fail_closed")) addError(errors, "status_evidence", capability, "deprecated requires a replacement or fail_closed evidence");
      break;
    default:
      break;
  }
}

function validateReferenceList(capability, field, identifiers, errors) {
  const values = capability[field];
  if (field === "references" && values === undefined) return;
  if (!Array.isArray(values)) {
    addError(errors, `invalid_${field}`, capability, `${field} must be an array`);
    return;
  }
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !identifier.test(value) || value === capability.id || !identifiers.has(value) || seen.has(value)) {
      addError(errors, `invalid_${field}`, capability, value ?? "invalid reference");
    }
    seen.add(value);
  }
}

function validatePublicDocs(root, trackedPaths, capability, errors) {
  if (!Array.isArray(capability.public_docs) || capability.public_docs.length === 0) {
    addError(errors, "invalid_public_docs", capability, "public_docs must be a non-empty array");
    return;
  }
  if (hasDuplicates(capability.public_docs)) addError(errors, "duplicate_public_docs", capability, "public_docs contains duplicates");
  for (const path of capability.public_docs) {
    if (typeof path !== "string" || !isSafeRelativePath(path) || !trackedPaths.has(normalize(path))) {
      addError(errors, "untracked_public_doc", capability, path ?? "invalid public_docs path");
    }
  }
  try {
    const index = sourceAt(root, indexRelativePath);
    if (!index.includes(capability.id)) addError(errors, "missing_index_representation", capability, indexRelativePath);
  } catch {
    addError(errors, "unreadable_capability_index", capability, indexRelativePath);
  }
}

function maintainedPublicDocPaths(trackedPaths) {
  return trackedPaths.filter((path) => {
    if (path === "sdks/dotnet/README.md") return true;
    if (!/^doc\/.*\.(?:rst|md)$/u.test(path)) return false;
    if (path.startsWith("doc/architecture/decisions/")) return false;
    return !/^doc\/analysis\/.*(?:plan|report).*\.md$/iu.test(path);
  });
}

/**
 * Validate the capability evidence registry using only JSON fixtures and tracked text.
 * This intentionally does not import service modules or execute application code.
 */
export function checkCapabilityRegistry({ root = repositoryRoot, trackedPaths = trackedPathsFromGit(root) } = {}) {
  const errors = [];
  const tracked = new Set(trackedPaths.map(normalize));
  if (!tracked.has(schemaRelativePath)) {
    return { errors: [{ code: "untracked_schema", capability: null, detail: schemaRelativePath }] };
  }
  let schema;
  try {
    schema = JSON.parse(sourceAt(root, schemaRelativePath));
  } catch {
    return { errors: [{ code: "invalid_schema_json", capability: null, detail: schemaRelativePath }] };
  }
  const schemaIssue = schemaDrift(schema);
  if (schemaIssue) return { errors: [{ code: "schema_drift", capability: null, detail: schemaIssue }] };
  if (!tracked.has(registryRelativePath)) {
    return { errors: [{ code: "untracked_registry", capability: null, detail: registryRelativePath }] };
  }
  let registry;
  try {
    registry = JSON.parse(sourceAt(root, registryRelativePath));
  } catch {
    return { errors: [{ code: "invalid_registry_json", capability: null, detail: registryRelativePath }] };
  }
  if (!registry || registry.schema_version !== 1 || !Array.isArray(registry.capabilities)) {
    return { errors: [{ code: "invalid_registry_shape", capability: null, detail: "schema_version 1 and capabilities array are required" }] };
  }
  if (registry.capabilities.length === 0) return { errors: [{ code: "empty_capabilities", capability: null, detail: "capabilities must be non-empty" }] };
  rejectUnknownFields(registry, registryFields, "unknown_registry_field", null, errors);

  const identifiers = new Set();
  const titles = new Set();
  for (const capability of registry.capabilities) {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
      addError(errors, "invalid_capability", capability, "capability must be an object");
      continue;
    }
    rejectUnknownFields(capability, capabilityFields, "unknown_capability_field", capability, errors);
    if (typeof capability.id !== "string" || !identifier.test(capability.id)) addError(errors, "invalid_id", capability, capability.id ?? "missing id");
    else if (identifiers.has(capability.id)) addError(errors, "duplicate_id", capability, capability.id);
    identifiers.add(capability.id);
    if (typeof capability.title !== "string" || !capability.title.trim()) addError(errors, "invalid_title", capability, capability.title ?? "missing title");
    else if (titles.has(capability.title)) addError(errors, "duplicate_title", capability, capability.title);
    titles.add(capability.title);
    if (!statuses.has(capability.status)) addError(errors, "invalid_status", capability, capability.status ?? "missing status");
    if (!owners.has(capability.owner)) addError(errors, "invalid_owner", capability, capability.owner ?? "missing owner");
    if (!Array.isArray(capability.surfaces) || capability.surfaces.length === 0 || capability.surfaces.some((surface) => typeof surface !== "string" || !surface.trim())) addError(errors, "invalid_surfaces", capability, "surfaces must be a non-empty string array");
    else if (hasDuplicates(capability.surfaces)) addError(errors, "duplicate_surfaces", capability, "surfaces contains duplicates");
    const availability = capability.availability;
    if (!availability || typeof availability !== "object" || Array.isArray(availability) || typeof availability.release !== "string" || !availability.release.trim() || !Array.isArray(availability.platforms) || availability.platforms.length === 0 || !Array.isArray(availability.limitations) || availability.limitations.length === 0 || availability.platforms.some((platform) => typeof platform !== "string" || !platform.trim()) || availability.limitations.some((limitation) => typeof limitation !== "string" || !limitation.trim())) addError(errors, "invalid_availability", capability, "availability requires release, platforms, and limitations");
    else {
      if (hasDuplicates(availability.platforms)) addError(errors, "duplicate_platforms", capability, "platforms contains duplicates");
      if (hasDuplicates(availability.limitations)) addError(errors, "duplicate_limitations", capability, "limitations contains duplicates");
      rejectUnknownFields(availability, availabilityFields, "unknown_availability_field", capability, errors);
    }
  }

  for (const capability of registry.capabilities) {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) continue;
    const evidenceByKind = validateEvidence(root, tracked, capability, errors);
    const hasReplacement = registry.capabilities.some((other) => other?.status !== "planned" && other?.status !== "deprecated" && Array.isArray(other?.replaces) && other.replaces.includes(capability.id));
    validateStatus(capability, evidenceByKind, hasReplacement, errors);
    validateSurfaceCoverage(capability, evidenceByKind, errors);
    validateReferenceList(capability, "references", identifiers, errors);
    validateReferenceList(capability, "replaces", identifiers, errors);
    validatePublicDocs(root, tracked, capability, errors);
  }
  for (const path of maintainedPublicDocPaths([...tracked])) {
    const content = sourceAt(root, path).toLowerCase();
    for (const claim of retiredClaims) {
      if (content.includes(claim)) errors.push({ code: "retired_phrase", capability: null, detail: `${path}: ${claim}` });
    }
  }
  return { errors };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { errors } = checkCapabilityRegistry();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`capability-registry ${error.code}${error.capability ? ` [${error.capability}]` : ""}: ${error.detail}`);
    }
    process.exitCode = 1;
  }
}
