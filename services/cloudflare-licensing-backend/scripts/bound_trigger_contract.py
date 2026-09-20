"""Explicit PostgreSQL port contract for the protected-device row triggers.

This supports only the narrow trigger grammar used by migration 0036. Unknown
syntax fails review rather than being ignored. It is a schema-parity tool, not
a runtime SQL translator. PostgreSQL remains fenced to v1 verification.
"""
from __future__ import annotations

import re
import sqlite3


BOUND_TRIGGER_NAMES = frozenset("""
tr_bound_entitlement_revision tr_bound_mode_no_downgrade
tr_bound_mode_requires_migration
tr_bound_entitlement_revision_no_reset tr_bound_customer_revision
tr_bound_customer_revision_no_reset tr_bound_capacity_decrease tr_bound_owner_change
tr_bound_device_identity_immutable tr_bound_binding_identity_immutable
tr_bound_binding_hold_monotonic tr_bound_binding_revision_no_reset
tr_bound_device_revision_no_reset tr_bound_attempt_revision_no_reset
tr_bound_binding_no_resurrection tr_bound_binding_no_early_release
tr_bound_binding_keep_tombstone tr_bound_device_keep_tombstone
tr_bound_device_disable tr_bound_attempt_intent_immutable tr_bound_attempt_terminal
tr_bound_attempt_approval_immutable tr_bound_attempt_consumption_immutable
tr_bound_challenge_immutable tr_bound_operation_immutable tr_bound_operation_tombstone tr_bound_operation_no_replace
tr_bound_reject_legacy_lease tr_bound_reject_legacy_device_insert
tr_bound_reject_legacy_device_update
tr_bound_reject_legacy_seat_insert tr_bound_reject_legacy_seat_update
""".split())


def _port_expression(sql: str) -> str:
    # D1 epoch seconds are floored, not PostgreSQL's rounded bigint cast.
    # clock_timestamp observes queue/delay time, unlike transaction-start now().
    sql = sql.replace("unixepoch()", "FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT")
    sql = re.sub(r"\bIS NOT\s+((?:OLD|NEW)\.\w+)", r"IS DISTINCT FROM \1", sql)
    sql = re.sub(r"SELECT RAISE\(ABORT, ('[^']+')\)", r"RAISE EXCEPTION \1", sql)
    return sql


def postgres_bound_trigger_blocks(sqlite_sql: str) -> dict[str, str]:
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(sqlite_sql)
        rows = connection.execute(
            "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'tr_bound_*' ORDER BY name"
        ).fetchall()
    finally:
        connection.close()
    names = {name for name, _ in rows}
    if names != BOUND_TRIGGER_NAMES:
        raise ValueError(f"protected trigger inventory mismatch: missing={sorted(BOUND_TRIGGER_NAMES-names)}, extra={sorted(names-BOUND_TRIGGER_NAMES)}")
    blocks = {}
    for name, sql in rows:
        match = re.fullmatch(
            r"CREATE TRIGGER (\w+) (BEFORE|AFTER) (INSERT|DELETE|UPDATE(?: OF [\w, ]+)?) ON (\w+)\s*(?:WHEN (.*?)\s*)?BEGIN\s*(.*?)\s*END",
            sql, re.DOTALL,
        )
        if match is None:
            raise ValueError(f"{name}: unreviewed protected trigger syntax")
        _, timing, event, table, condition, body = match.groups()
        body = _port_expression(body)
        if condition:
            body = f"IF {_port_expression(condition)} THEN\n    {body}\n  END IF;"
        returned = "OLD" if event == "DELETE" else "NEW"
        # AFTER triggers ignore the return value; BEFORE triggers preserve the row.
        blocks[name] = (
            f"CREATE OR REPLACE FUNCTION {name}_fn() RETURNS TRIGGER AS $$\n"
            f"BEGIN\n  {body}\n  RETURN {returned};\nEND;\n$$ LANGUAGE plpgsql;\n"
            f"CREATE TRIGGER {name} {timing} {event} ON {table}\n"
            f"FOR EACH ROW EXECUTE FUNCTION {name}_fn();"
        )
    return blocks


def compare_bound_trigger_contract(sqlite_sql: str, pg_sql: str) -> list[str]:
    expected = postgres_bound_trigger_blocks(sqlite_sql)
    problems = []
    # Tokenize rather than lowercase/strip whitespace inside quoted messages.
    def tokens(sql: str) -> list[str]:
        return re.findall(r"'[^']*'|\w+|[^\s]", re.sub(r"--[^\n]*", "", sql))
    for name, block in expected.items():
        pattern = rf"CREATE OR REPLACE FUNCTION {name}_fn\(\).*?\$\$ LANGUAGE plpgsql;\s*CREATE TRIGGER {name}\b.*?;"
        matches = re.findall(pattern, pg_sql, re.DOTALL)
        if len(matches) != 1 or tokens(matches[0]) != tokens(block):
            problems.append(f"{name}: protected trigger/function contract mismatch")
    declared = re.findall(r"CREATE\s+TRIGGER\s+(tr_bound_\w+)\b", pg_sql, re.IGNORECASE)
    functions = re.findall(r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(tr_bound_\w+)_fn\b", pg_sql, re.IGNORECASE)
    if set(declared) != BOUND_TRIGGER_NAMES or len(declared) != len(expected):
        problems.append("Postgres protected trigger inventory mismatch")
    if set(functions) != BOUND_TRIGGER_NAMES or len(functions) != len(expected):
        problems.append("Postgres protected function inventory mismatch")
    return problems
