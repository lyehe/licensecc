export const D1_SQLITE_MAX_FUNCTION_ARGS: number;

export type SqlJsonEntry = readonly [key: string, sqlExpression: string];

export function d1SafeJsonObjectSql(entries: readonly SqlJsonEntry[]): string;
export function entitlementCurrentJsonSql(
  alias: string,
  idExpression: string,
  options?: { includeCacheTtl?: boolean },
): string;
export function d1JsonFunctionArgumentCounts(sql: string): Array<{
  functionName: "json_object" | "json_set";
  argumentCount: number;
}>;
export function assertD1JsonFunctionArity(sql: string): void;
