export type PathEntry = readonly [path: string, item: Readonly<Record<string, unknown>>];
export type ComponentEntry = readonly [name: string, value: unknown];
export type ComponentNamespace = readonly [namespace: string, entries: readonly ComponentEntry[]];

export interface LabeledPathFragment {
  readonly label: string;
  readonly entries: readonly PathEntry[];
}

export interface LabeledComponentFragment {
  readonly label: string;
  readonly namespaces: readonly ComponentNamespace[];
}

export interface OpenApiComponents {
  readonly securitySchemes: Record<string, unknown>;
  readonly schemas: Record<string, unknown>;
  readonly [namespace: string]: Record<string, unknown>;
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`OpenAPI ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assemblePaths(...fragments: readonly LabeledPathFragment[]): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const origins = new Map<string, Map<string, string>>();
  for (const fragment of fragments) {
    for (const [path, item] of fragment.entries) {
      const incoming = asRecord(item, `path item for ${JSON.stringify(path)}`);
      let target = hasOwn(result, path) ? result[path]! : undefined;
      let pathOrigins = origins.get(path);
      if (!target) {
        target = {};
        result[path] = target;
        pathOrigins = new Map();
        origins.set(path, pathOrigins);
      }
      for (const [field, value] of Object.entries(incoming)) {
        if (hasOwn(target, field)) {
          const prior = pathOrigins?.get(field) ?? "an earlier fragment";
          throw new Error(`Duplicate OpenAPI path item field ${JSON.stringify(field)} for path ${JSON.stringify(path)} from ${JSON.stringify(fragment.label)}; already declared by ${JSON.stringify(prior)}.`);
        }
        target[field] = value;
        pathOrigins?.set(field, fragment.label);
      }
    }
  }
  return result;
}

export function assembleComponents(...fragments: readonly LabeledComponentFragment[]): OpenApiComponents {
  const result: Record<string, Record<string, unknown>> = {};
  const origins = new Map<string, Map<string, string>>();
  for (const fragment of fragments) {
    for (const [namespace, entries] of fragment.namespaces) {
      let target = hasOwn(result, namespace) ? result[namespace]! : undefined;
      let namespaceOrigins = origins.get(namespace);
      if (!target) {
        target = {};
        result[namespace] = target;
        namespaceOrigins = new Map();
        origins.set(namespace, namespaceOrigins);
      }
      for (const [name, value] of entries) {
        if (hasOwn(target, name)) {
          const prior = namespaceOrigins?.get(name) ?? "an earlier fragment";
          throw new Error(`Duplicate OpenAPI component key ${JSON.stringify(name)} in ${namespace} from ${JSON.stringify(fragment.label)}; already declared by ${JSON.stringify(prior)}.`);
        }
        target[name] = value;
        namespaceOrigins?.set(name, fragment.label);
      }
    }
  }
  if (!hasOwn(result, "securitySchemes") || !hasOwn(result, "schemas")) {
    throw new Error("OpenAPI components must declare securitySchemes and schemas namespaces.");
  }
  return result as OpenApiComponents;
}

export function assertUniqueOperationIds(paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>): void {
  const seen = new Map<string, string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const operationRecord = asRecord(operation, `operation ${method.toUpperCase()} ${path}`);
      const operationId = operationRecord.operationId;
      if (typeof operationId !== "string") continue;
      const current = `${method.toUpperCase()} ${path}`;
      const prior = seen.get(operationId);
      if (prior !== undefined) {
        throw new Error(`Duplicate OpenAPI operationId ${JSON.stringify(operationId)} for ${current}; already declared by ${prior}.`);
      }
      seen.set(operationId, current);
    }
  }
}
