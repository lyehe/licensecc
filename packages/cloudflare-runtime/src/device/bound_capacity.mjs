// Device-slot occupancy for protected (device-bound) grants, ADR 0006. A binding holds one of its
// entitlement's device slots while it is active, and while it is retiring until its hold ends. The
// licensing backend's lease issue and commit, and the admin console's capacity answer, count with
// this one predicate. The schema triggers (tr_bound_capacity_decrease, tr_bound_owner_change) state
// the same rule in SQL; a backend test pins the two together.

const SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQL predicate: the device_bound_bindings row aliased `alias` occupies a device slot at `nowSql`.
 * Both arguments are owner-controlled SQL (a table alias, and a time expression such as
 * `unixepoch()` or a bound `?`), never request data.
 */
export function boundOccupiedSql(alias, nowSql) {
  if (!SQL_ALIAS.test(alias)) throw new TypeError("boundOccupiedSql needs an SQL alias");
  return `(${alias}.state = 'active' OR (${alias}.state = 'retiring' AND ${alias}.hold_until > ${nowSql}))`;
}
