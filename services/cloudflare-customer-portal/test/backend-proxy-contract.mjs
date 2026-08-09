// The portal wraps, but deliberately does not normalize, backend failures. Keep the portal's
// declared proxy surface derived from the reviewed backend canonical OpenAPI rather than a second
// hand-maintained error-code list. Backend examples carry bare codes (for example `unauthorized`)
// while its response descriptions enumerate the alternate machine codes for a status.

import { readFileSync } from "node:fs";

const backendContract = JSON.parse(
  readFileSync(new URL("../../../test/contracts/backend.json", import.meta.url), "utf8"),
);
const backendOpenApi = backendContract.openApiSpec;

if (!backendOpenApi || typeof backendOpenApi !== "object" || !backendOpenApi.paths || typeof backendOpenApi.paths !== "object") {
  throw new Error("The reviewed backend canonical OpenAPI is unavailable to the portal proxy contract test.");
}

const PROXIED_ERROR_STATUSES = Object.freeze(["400", "401", "403", "409", "410", "500", "502", "503"]);
const BACKEND_STUB_STATUSES = Object.freeze(["400", "401", "403", "409", "410", "500", "503"]);

function unique(values) {
  return [...new Set(values)];
}

function freezeErrorCodes(errorCodes) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(errorCodes).map(([status, codes]) => [status, Object.freeze([...codes])]),
    ),
  );
}

function backendResponse(path, status) {
  const response = backendOpenApi.paths[path]?.post?.responses?.[String(status)];
  if (response === undefined) return null;
  if (!response || typeof response !== "object") {
    throw new Error(`Backend canonical response ${path} ${status} is not an object.`);
  }
  return response;
}

function backendSchemaReference(schema) {
  if (!schema || typeof schema !== "object") {
    throw new Error("Backend canonical response schema is unavailable.");
  }
  if (typeof schema.$ref !== "string") return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) {
    throw new Error(`Backend canonical schema reference ${schema.$ref} is not a component schema.`);
  }
  const resolved = backendOpenApi.components?.schemas?.[schema.$ref.slice(prefix.length)];
  if (!resolved || typeof resolved !== "object") {
    throw new Error(`Backend canonical schema reference ${schema.$ref} is missing.`);
  }
  return resolved;
}

function backendSuccessSchema(path) {
  const response = backendResponse(path, "200");
  const schema = response?.content?.["application/json"]?.schema;
  return backendSchemaReference(schema);
}

function successFieldDescriptor(schema, label) {
  if (!schema || typeof schema !== "object" || typeof schema.type !== "string") {
    throw new Error(`Backend canonical success field ${label} must declare one exact type.`);
  }
  const descriptor = { type: schema.type };
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.every((value) => typeof value === "string")) {
      throw new Error(`Backend canonical success field ${label} has a non-string enum.`);
    }
    descriptor.enum = [...schema.enum];
  }
  return descriptor;
}

function codeExamples(response) {
  const examples = response.content?.["application/json"]?.examples;
  if (!examples || typeof examples !== "object") return [];
  return Object.values(examples)
    .map((example) => example?.value?.code)
    .filter((code) => typeof code === "string");
}

function codeNamesInDescription(response) {
  if (typeof response.description !== "string") return [];
  // Backend path descriptions deliberately enumerate alternative machine codes such as
  // `forbidden_scope, no_active_entitlement, ...`. Require an underscore and punctuation after the
  // token so policy field names such as `pool_size` and `max_borrow_sec` are not mistaken for codes.
  return [...response.description.matchAll(/(?:^|,\s*|\bor\s+|\.\s+)([a-z][a-z0-9]*_[a-z0-9_]+)(?=\s*(?:\(|:|,|\.|\bor\b))/g)]
    .map((match) => match[1]);
}

export function canonicalBackendErrorCodes(backendPath, status) {
  const response = backendResponse(backendPath, status);
  return response === null ? [] : unique([...codeExamples(response), ...codeNamesInDescription(response)]);
}

// The backend's shared fetch-handler fallback returns the canonical verification error at 500 for
// an otherwise unhandled route error. Its canonical /v1/verify response is the reviewed source for
// that envelope, so the portal keeps it alongside each operation-specific 500 alternative.
const BACKEND_TOP_LEVEL_500_CODES = Object.freeze(canonicalBackendErrorCodes("/v1/verify", "500"));
if (BACKEND_TOP_LEVEL_500_CODES.length === 0) {
  throw new Error("The backend canonical OpenAPI no longer declares its top-level 500 fallback.");
}

export const proxiedBackendOperations = Object.freeze([
  Object.freeze({
    name: "checkout",
    portalPath: "/api/portal/checkout",
    backendPath: "/v1/checkout",
    requestBody: (entitlementId) => ({ entitlement_id: entitlementId, client_instance_id: "i1", nonce: "e".repeat(64) }),
    localErrorCodes: freezeErrorCodes({
      "400": ["invalid_json"],
      "401": ["unauthorized"],
      "403": ["cross_site_forbidden"],
      "500": ["portal_error"],
      "502": ["backend_unreachable", "backend_invalid_response"],
      "503": ["backend_unconfigured", "config_error"],
    }),
  }),
  Object.freeze({
    name: "heartbeat",
    portalPath: "/api/portal/heartbeat",
    backendPath: "/v1/heartbeat",
    requestBody: (entitlementId) => ({
      entitlement_id: entitlementId,
      client_instance_id: "i1",
      nonce: "e".repeat(64),
      seat_id: "seat-1",
    }),
    localErrorCodes: freezeErrorCodes({
      "400": ["invalid_json"],
      "401": ["unauthorized"],
      "403": ["cross_site_forbidden"],
      "500": ["portal_error"],
      "502": ["backend_unreachable", "backend_invalid_response"],
      "503": ["backend_unconfigured", "config_error"],
    }),
  }),
  Object.freeze({
    name: "release",
    portalPath: "/api/portal/release",
    backendPath: "/v1/release",
    requestBody: (entitlementId) => ({
      entitlement_id: entitlementId,
      client_instance_id: "i1",
      nonce: "e".repeat(64),
      seat_id: "seat-1",
    }),
    localErrorCodes: freezeErrorCodes({
      "400": ["invalid_json"],
      "401": ["unauthorized"],
      "403": ["cross_site_forbidden"],
      "500": ["portal_error"],
      "502": ["backend_unreachable", "backend_invalid_response"],
      "503": ["backend_unconfigured", "config_error"],
    }),
  }),
  Object.freeze({
    name: "download",
    portalPath: "/api/portal/download",
    backendPath: "/v1/activate",
    requestBody: (entitlementId) => ({ entitlement_id: entitlementId, device_key_id: "dk_a" }),
    localErrorCodes: freezeErrorCodes({
      "400": ["invalid_json", "device_key_required"],
      "401": ["unauthorized"],
      "403": ["cross_site_forbidden"],
      "500": ["portal_error"],
      "502": ["backend_unreachable", "backend_invalid_response"],
      "503": ["backend_unconfigured", "config_error"],
    }),
  }),
]);

export function expectedProxyErrorCodes(operation, status) {
  return unique([
    ...canonicalBackendErrorCodes(operation.backendPath, status),
    ...(String(status) === "500" ? BACKEND_TOP_LEVEL_500_CODES : []),
    ...(operation.localErrorCodes[String(status)] ?? []),
  ]);
}

export function backendStubCases(operation) {
  return BACKEND_STUB_STATUSES.flatMap((status) => unique([
    ...canonicalBackendErrorCodes(operation.backendPath, status),
    ...(status === "500" ? BACKEND_TOP_LEVEL_500_CODES : []),
  ]).map((code) => ({ status: Number(status), code })));
}

export function canonicalBackendErrorManifest(operation) {
  return Object.fromEntries(
    BACKEND_STUB_STATUSES.flatMap((status) => {
      const codes = unique([
        ...canonicalBackendErrorCodes(operation.backendPath, status),
        ...(status === "500" ? BACKEND_TOP_LEVEL_500_CODES : []),
      ]);
      return codes.length === 0 ? [] : [[status, codes]];
    }),
  );
}

export function canonicalBackendSuccessManifest(operation) {
  const schema = backendSuccessSchema(operation.backendPath);
  if (schema.type !== "object" || !Array.isArray(schema.required) || !schema.required.includes("ok")) {
    throw new Error(`${operation.name} backend 200 response must require an object ok field.`);
  }
  const ok = schema.properties?.ok;
  if (!ok || !Array.isArray(ok.enum) || ok.enum.length !== 1 || ok.enum[0] !== true) {
    throw new Error(`${operation.name} backend 200 response must pin ok:true.`);
  }
  const code = schema.properties?.code;
  let codes = [];
  if (code !== undefined) {
    if (typeof code.const === "string") codes = [code.const];
    else if (Array.isArray(code.enum) && code.enum.every((value) => typeof value === "string")) codes = [...code.enum];
    else throw new Error(`${operation.name} backend 200 code must be exact when present.`);
  }
  const fields = {};
  for (const name of schema.required) {
    if (name === "ok" || name === "code") continue;
    fields[name] = successFieldDescriptor(schema.properties?.[name], `${operation.name}.${name}`);
  }
  return { codes, fields };
}

export { BACKEND_STUB_STATUSES, PROXIED_ERROR_STATUSES };
