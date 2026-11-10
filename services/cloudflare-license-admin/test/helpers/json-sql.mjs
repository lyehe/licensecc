import { D1_SQLITE_MAX_FUNCTION_ARGS } from "@licensecc/cloudflare-runtime/d1/entitlement_json";

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
