import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryRelativePath = "doc/capabilities/registry.json";
const indexRelativePath = "doc/capabilities/index.rst";
const publicSurfaces = Object.freeze([
  "doc/analysis/features.rst",
  "doc/usage/concepts.rst",
  "sdks/dotnet/README.md",
]);
const retiredPhrases = Object.freeze(["not yet implemented", "not yet on `main`", "not yet on main"]);
const statuses = new Set(["shipped", "experimental", "platform_limited", "planned", "deprecated"]);
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
const evidenceFields = new Set(["kind", "path", "selector", "assertion"]);

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

function hasEvidence(kinds, ...required) {
  return required.every((kind) => kinds.has(kind));
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

function validateEvidence(root, trackedPaths, capability, errors) {
  const kinds = new Set();
  if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
    addError(errors, "invalid_evidence", capability, "evidence must be a non-empty array");
    return kinds;
  }
  for (const evidence of capability.evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      addError(errors, "invalid_evidence", capability, "evidence must be an object");
      continue;
    }
    const { kind, path, selector, assertion } = evidence;
    rejectUnknownFields(evidence, evidenceFields, "unknown_evidence_field", capability, errors);
    if (!evidenceKinds.has(kind) || typeof assertion !== "string" || !assertion.trim()) {
      addError(errors, "invalid_evidence", capability, kind ?? "missing kind");
      continue;
    }
    kinds.add(kind);
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
      if (!sourceAt(root, path).includes(selector)) addError(errors, "missing_selector", capability, selector);
    } catch {
      addError(errors, "unreadable_evidence_path", capability, path);
    }
  }
  return kinds;
}

function validateStatus(capability, kinds, hasReplacement, errors) {
  switch (capability.status) {
    case "shipped":
      if (!hasEvidence(kinds, "implementation", "automated_test")) addError(errors, "status_evidence", capability, "shipped requires implementation and automated_test evidence");
      break;
    case "experimental":
      if (!hasEvidence(kinds, "implementation", "automated_test", "limitation")) addError(errors, "status_evidence", capability, "experimental requires implementation, automated_test, and limitation evidence");
      break;
    case "platform_limited":
      if (!hasEvidence(kinds, "implementation", "automated_test", "platform", "limitation")) addError(errors, "status_evidence", capability, "platform_limited requires implementation, automated_test, platform, and limitation evidence");
      break;
    case "planned": {
      const plannedOnly = [...kinds].every((kind) => kind === "plan" || kind === "design");
      if ((!kinds.has("plan") && !kinds.has("design")) || !plannedOnly) addError(errors, "planned_implementation_claim", capability, "planned evidence must be plan/design only");
      break;
    }
    case "deprecated":
      if (!hasReplacement && !kinds.has("fail_closed")) addError(errors, "status_evidence", capability, "deprecated requires a replacement or fail_closed evidence");
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

/**
 * Validate the capability evidence registry using only JSON fixtures and tracked text.
 * This intentionally does not import service modules or execute application code.
 */
export function checkCapabilityRegistry({ root = repositoryRoot, trackedPaths = trackedPathsFromGit(root) } = {}) {
  const errors = [];
  const tracked = new Set(trackedPaths.map(normalize));
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
    const availability = capability.availability;
    if (!availability || typeof availability !== "object" || Array.isArray(availability) || typeof availability.release !== "string" || !availability.release.trim() || !Array.isArray(availability.platforms) || availability.platforms.length === 0 || !Array.isArray(availability.limitations) || availability.limitations.length === 0 || availability.platforms.some((platform) => typeof platform !== "string" || !platform.trim()) || availability.limitations.some((limitation) => typeof limitation !== "string" || !limitation.trim())) addError(errors, "invalid_availability", capability, "availability requires release, platforms, and limitations");
    else rejectUnknownFields(availability, availabilityFields, "unknown_availability_field", capability, errors);
  }

  for (const capability of registry.capabilities) {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) continue;
    const kinds = validateEvidence(root, tracked, capability, errors);
    const hasReplacement = Array.isArray(capability.replaces) && capability.replaces.length > 0
      || registry.capabilities.some((other) => Array.isArray(other?.replaces) && other.replaces.includes(capability.id));
    validateStatus(capability, kinds, hasReplacement, errors);
    validateReferenceList(capability, "references", identifiers, errors);
    validateReferenceList(capability, "replaces", identifiers, errors);
    validatePublicDocs(root, tracked, capability, errors);
  }
  for (const path of publicSurfaces) {
    if (!tracked.has(path)) {
      errors.push({ code: "untracked_public_surface", capability: null, detail: path });
      continue;
    }
    const content = sourceAt(root, path).toLowerCase();
    for (const phrase of retiredPhrases) {
      if (content.includes(phrase)) errors.push({ code: "retired_phrase", capability: null, detail: `${path}: ${phrase}` });
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
