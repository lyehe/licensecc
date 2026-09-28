/**
 * SQL predicate: the device_bound_bindings row aliased `alias` occupies a device slot at `nowSql`
 * (active, or retiring until its hold ends; ADR 0006). Both arguments are owner-controlled SQL.
 */
export function boundOccupiedSql(alias: string, nowSql: string): string;
