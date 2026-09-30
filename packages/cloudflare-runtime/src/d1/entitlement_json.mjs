// D1 has a production SQLite function-argument cap of 32. Entitlement audit
// payloads deliberately contain more fields than fit in one json_object(), so
// build them from small objects and nested json_set() calls. json_set retains
// an explicit SQL NULL as a JSON null; json_patch would instead remove it.

export const D1_SQLITE_MAX_FUNCTION_ARGS = 32;

// json_set(document, path, value, ...) consumes one argument for the document.
// Fifteen key/value pairs therefore stay below the production limit (31 args)
// for both json_object and json_set, including future wrapper changes.
const MAX_JSON_PAIRS_PER_CALL = 15;

function sqlJsonPath(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error("invalid_json_key");
  }
  return `'$.${key}'`;
}

function objectArguments(entries) {
  return entries.flatMap(([key, value]) => [`'${key}'`, value]).join(", ");
}

/**
 * Render a JSON object without ever exceeding D1's 32-argument SQLite limit.
 * Values are SQL expressions, not JSON strings, so SQL NULL remains an
 * explicit JSON null at every nested json_set step.
 */
export function d1SafeJsonObjectSql(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "json_object()";
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("invalid_json_entry");
    }
    sqlJsonPath(entry[0]);
  }
  let expression = `json_object(${objectArguments(entries.slice(0, MAX_JSON_PAIRS_PER_CALL))})`;
  for (let start = MAX_JSON_PAIRS_PER_CALL; start < entries.length; start += MAX_JSON_PAIRS_PER_CALL) {
    const chunk = entries.slice(start, start + MAX_JSON_PAIRS_PER_CALL);
    const setArguments = chunk.flatMap(([key, value]) => [sqlJsonPath(key), value]).join(", ");
    expression = `json_set(${expression}, ${setArguments})`;
  }
  return expression;
}

function column(alias, name) {
  return alias === "" ? name : `${alias}.${name}`;
}

/**
 * Canonical entitlement representation used by both the general entitlement
 * mutation adapter and the plan-projection protocol.
 */
export function entitlementCurrentJsonSql(alias, idExpression) {
  const value = (name) => column(alias, name);
  return d1SafeJsonObjectSql([
    ["project", value("project")],
    ["feature", value("feature")],
    ["license_fingerprint", value("license_fingerprint")],
    ["status", value("status")],
    ["revocation_seq", value("revocation_seq")],
    ["valid_from", value("valid_from")],
    ["valid_until", value("valid_until")],
    ["notes", value("notes")],
    ["customer_id", value("customer_id")],
    ["license_id", value("license_id")],
    ["policy_id", value("policy_id")],
    ["is_trial", value("is_trial")],
    ["trial_expiration_basis", value("trial_expiration_basis")],
    ["trial_duration_sec", value("trial_duration_sec")],
    ["trial_one_per_device", value("trial_one_per_device")],
    ["trial_started_at", value("trial_started_at")],
    ["trial_device_key_id", value("trial_device_key_id")],
    ["max_active_devices", value("max_active_devices")],
    ["lease_seconds", value("lease_seconds")],
    ["license_mode", `CASE WHEN ${value("is_trial")} = 1 THEN 'trial' ELSE 'node_locked' END`],
    ["created_at", value("created_at")],
    ["updated_at", value("updated_at")],
    ["id", idExpression],
  ]);
}

function skipQuoted(sql, index) {
  const quote = sql[index];
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return cursor;
}

/** Return argument counts for every json_object/json_set call in SQL. */
export function d1JsonFunctionArgumentCounts(sql) {
  const calls = [];
  const matcher = /\b(json_object|json_set)\s*\(/gi;
  let match;
  while ((match = matcher.exec(sql)) !== null) {
    let depth = 1;
    let count = 1;
    let hasContent = false;
    let cursor = matcher.lastIndex;
    for (; cursor < sql.length && depth > 0; cursor += 1) {
      const char = sql[cursor];
      if (char === "'" || char === '"') {
        hasContent = true;
        cursor = skipQuoted(sql, cursor) - 1;
      } else if (char === "(") {
        hasContent = true;
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      } else if (char === "," && depth === 1) {
        count += 1;
      } else if (!/\s/.test(char)) {
        hasContent = true;
      }
    }
    if (depth !== 0) throw new Error("invalid_json_sql");
    calls.push({ functionName: match[1].toLowerCase(), argumentCount: hasContent ? count : 0 });
    matcher.lastIndex = match.index + 1;
  }
  return calls;
}

export function assertD1JsonFunctionArity(sql) {
  for (const call of d1JsonFunctionArgumentCounts(sql)) {
    if (call.argumentCount > D1_SQLITE_MAX_FUNCTION_ARGS) {
      throw new Error(`d1_json_function_argument_limit:${call.functionName}:${call.argumentCount}`);
    }
  }
}
