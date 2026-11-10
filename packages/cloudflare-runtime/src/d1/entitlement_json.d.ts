export const D1_SQLITE_MAX_FUNCTION_ARGS: number;

export type SqlJsonEntry = readonly [key: string, sqlExpression: string];

export function d1SafeJsonObjectSql(entries: readonly SqlJsonEntry[]): string;
export function entitlementCurrentJsonSql(alias: string, idExpression: string): string;
