#!/usr/bin/env python3
"""Review the semantic contract between the D1 and PostgreSQL snapshots.

``check-schema-parity.py`` proves that the canonical D1 snapshot is the result
of the D1 migration history. This checker reviews the separate, fenced
PostgreSQL bootstrap against that final D1 shape. It deliberately compares the
parts on which queries and invariants depend: table/column presence, the
reviewed INTEGER-to-PostgreSQL type policy, nullability and defaults, primary
and unique keys, foreign keys, CHECK constraints, explicit indexes, generated
audit/event ids, and the plan-projection generation triggers.

The contract is dialect-aware rather than text-equal. D1 ``INTEGER`` values are
``BIGINT`` in PostgreSQL except for the explicit INT4 boolean-flag allowlist;
SQLite AUTOINCREMENT audit/event ids become PostgreSQL identity columns; and
SQLite's three row triggers per source table map to one PostgreSQL statement
trigger covering INSERT/UPDATE/DELETE. Any new exception must be reviewed here
rather than silently weakening parity.

Run via:
  uv run --directory scripts/pg-parity --locked python ../check-pg-parity.py
"""
from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import sqlglot
from sqlglot import exp


ROOT = Path(__file__).resolve().parents[1]
SQLITE_SNAPSHOT = ROOT / "schema.sql"
PG_SNAPSHOT = ROOT / "supabase-postgres" / "schema.pg.sql"

# These values are stored as 0/1 flags and intentionally remain PostgreSQL
# INTEGER (int4). Every other D1 INTEGER column is 64-bit-intent and must be
# PostgreSQL BIGINT. This small allowlist makes a new narrowing review-visible.
POSTGRES_INT4_COLUMNS = frozenset(
    {
        ("entitlements", "is_trial"),
        ("entitlements", "trial_one_per_device"),
        ("entitlements", "trial_require_device_proof"),
        ("entitlement_policies", "trial_one_per_device"),
        ("entitlement_policies", "trial_require_device_proof"),
    }
)

# SQLite INTEGER PRIMARY KEY AUTOINCREMENT maps to BIGINT GENERATED ALWAYS AS
# IDENTITY. Most of these are append-only audit/event streams; keeping the list
# explicit prevents a missing identity clause from looking like type parity.
POSTGRES_IDENTITY_COLUMNS = frozenset(
    {
        ("account_token_events", "id"),
        ("audit_digests", "id"),
        ("catalog_events", "id"),
        ("customer_events", "id"),
        ("entitlement_events", "id"),
        ("lease_issuance", "id"),
        ("license_plan_assignment_events", "id"),
        ("policy_events", "id"),
        ("usage_events", "id"),
        ("webhook_deliveries", "id"),
        ("webhook_events", "id"),
    }
)

# These keys are conflict/replay arbiters, not merely descriptive shape. Keep
# their D1 contract explicit so coordinated edits to both snapshots cannot
# accidentally erase the invariant without changing this reviewed allowlist.
LOAD_BEARING_PRIMARY_KEYS = {
    "rate_limit_counters": ("namespace", "rate_key", "window_start"),
    "request_proof_nonces": (
        "project",
        "feature",
        "license_fingerprint",
        "device_key_id",
        "nonce",
    ),
}

# D1 uses one trigger per event because SQLite has no multi-event trigger
# syntax. PostgreSQL uses one statement trigger per table; generation is an
# invalidation token, not a row counter, so both contracts mean "any mutation
# invalidates previews".
GENERATION_TRIGGER_TABLES = {
    "catalog_features": "catalog_features",
    "catalog_plans": "catalog_plans",
    "catalog_plan_features": "catalog_plan_features",
    "entitlement_policies": "entitlement_policies",
    "entitlements": "entitlements",
    "license_plan_assignments": "assignments",
}
GENERATION_EVENTS = ("INSERT", "UPDATE", "DELETE")
GENERATION_EVENT_SET = frozenset(GENERATION_EVENTS)
GENERATION_FUNCTION = "bump_license_plan_projection_generation"


@dataclass(frozen=True)
class ColumnContract:
    declared_type: str
    explicit_not_null: bool
    default: str | None
    checks: tuple[str, ...]
    auto_increment: bool = False
    identity: bool = False


@dataclass(frozen=True, order=True)
class ForeignKeyContract:
    columns: tuple[str, ...]
    referenced_table: str
    referenced_columns: tuple[str, ...]
    on_delete: str
    on_update: str


@dataclass(frozen=True)
class TableContract:
    columns: dict[str, ColumnContract]
    primary_key: tuple[str, ...]
    uniques: frozenset[tuple[str, ...]]
    foreign_keys: frozenset[ForeignKeyContract]
    table_checks: tuple[str, ...]


@dataclass(frozen=True)
class IndexContract:
    table: str
    unique: bool
    method: str | None
    columns: tuple[tuple[str, bool], ...]
    include: tuple[str, ...]
    predicate: str | None


@dataclass(frozen=True)
class ParsedSchema:
    tables: dict[str, TableContract]
    indexes: dict[str, IndexContract]


@dataclass(frozen=True)
class PgTriggerContract:
    table: str
    events: frozenset[str]
    timing: str
    for_each: str
    function: str


def _canonical_sql(expression: exp.Expression | None) -> str | None:
    if expression is None:
        return None
    # sqlglot represents SQLite ``x IS NOT NULL`` as ``NOT (x IS NULL)`` but
    # PostgreSQL as a negated IS node. Collapse that parser-only difference.
    def normalize_is_not(node: exp.Expression) -> exp.Expression:
        if (
            isinstance(node, exp.Not)
            and isinstance(node.this, exp.Is)
            and isinstance(node.this.expression, exp.Null)
        ):
            return exp.Is(
                this=node.this.this.copy(), expression=exp.Null(), negate=True
            )
        return node

    normalized = expression.copy().transform(normalize_is_not)
    rendered = normalized.sql(
        dialect="postgres", pretty=False, comments=False, normalize=True
    )
    return " ".join(rendered.split())


def _identifier_names(expressions: list[exp.Expression]) -> tuple[str, ...]:
    return tuple(expression.name.lower() for expression in expressions)


def _constraint_kind(column_constraint: exp.ColumnConstraint) -> exp.Expression:
    return column_constraint.args["kind"]


def _column_contract(column: exp.ColumnDef, dialect: str) -> ColumnContract:
    data_type = column.args.get("kind")
    if not isinstance(data_type, exp.DataType):
        raise ValueError(f"{column.name}: missing declared type in {dialect} schema")

    dtype = data_type.this
    if dtype == exp.DataType.Type.TEXT:
        declared_type = "TEXT"
    elif dtype == exp.DataType.Type.INT:
        declared_type = "INTEGER"
    elif dtype == exp.DataType.Type.BIGINT:
        declared_type = "BIGINT"
    else:
        declared_type = data_type.sql(dialect="postgres").upper()

    explicit_not_null = False
    default: str | None = None
    checks: list[str] = []
    auto_increment = False
    identity = False
    for constraint in column.args.get("constraints") or []:
        kind = _constraint_kind(constraint)
        if isinstance(kind, exp.NotNullColumnConstraint):
            explicit_not_null = not bool(kind.args.get("allow_null"))
        elif isinstance(kind, exp.DefaultColumnConstraint):
            default = _canonical_sql(kind.this)
        elif isinstance(kind, exp.CheckColumnConstraint):
            check = _canonical_sql(kind.this)
            if check is not None:
                checks.append(check)
        elif isinstance(kind, exp.AutoIncrementColumnConstraint):
            auto_increment = True
        elif isinstance(kind, exp.GeneratedAsIdentityColumnConstraint):
            identity = True

    return ColumnContract(
        declared_type=declared_type,
        explicit_not_null=explicit_not_null,
        default=default,
        checks=tuple(sorted(checks)),
        auto_increment=auto_increment,
        identity=identity,
    )


def _reference_actions(reference: exp.Reference) -> tuple[str, str]:
    options = " ".join(str(option) for option in reference.args.get("options") or [])

    def action(kind: str) -> str:
        match = re.search(
            rf"\bON\s+{kind}\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)\b",
            options,
            re.IGNORECASE,
        )
        return " ".join(match.group(1).upper().split()) if match else "NO ACTION"

    return action("DELETE"), action("UPDATE")


def _foreign_key_contract(foreign_key: exp.ForeignKey) -> ForeignKeyContract:
    reference = foreign_key.args.get("reference")
    if not isinstance(reference, exp.Reference) or not isinstance(reference.this, exp.Schema):
        raise ValueError(f"unparseable foreign key: {foreign_key}")
    target = reference.this
    on_delete, on_update = _reference_actions(reference)
    return ForeignKeyContract(
        columns=_identifier_names(list(foreign_key.expressions)),
        referenced_table=target.this.name.lower(),
        referenced_columns=_identifier_names(list(target.expressions)),
        on_delete=on_delete,
        on_update=on_update,
    )


def _table_contract(schema: exp.Schema, dialect: str) -> tuple[str, TableContract]:
    table_name = schema.this.name.lower()
    columns: dict[str, ColumnContract] = {}
    inline_primary_key: list[str] = []
    table_primary_key: tuple[str, ...] | None = None
    uniques: set[tuple[str, ...]] = set()
    foreign_keys: set[ForeignKeyContract] = set()
    table_checks: list[str] = []

    for item in schema.expressions:
        if isinstance(item, exp.ColumnDef):
            column_name = item.name.lower()
            if column_name in columns:
                raise ValueError(f"{table_name}.{column_name}: duplicate column")
            columns[column_name] = _column_contract(item, dialect)
            for constraint in item.args.get("constraints") or []:
                kind = _constraint_kind(constraint)
                if isinstance(kind, exp.PrimaryKeyColumnConstraint):
                    inline_primary_key.append(column_name)
                elif isinstance(kind, exp.UniqueColumnConstraint):
                    uniques.add((column_name,))
                elif isinstance(kind, exp.Reference):
                    target = kind.this
                    if not isinstance(target, exp.Schema):
                        raise ValueError(f"unparseable inline reference: {kind}")
                    on_delete, on_update = _reference_actions(kind)
                    foreign_keys.add(
                        ForeignKeyContract(
                            columns=(column_name,),
                            referenced_table=target.this.name.lower(),
                            referenced_columns=_identifier_names(list(target.expressions)),
                            on_delete=on_delete,
                            on_update=on_update,
                        )
                    )
        elif isinstance(item, exp.PrimaryKey):
            table_primary_key = _identifier_names(list(item.expressions))
        elif isinstance(item, exp.UniqueColumnConstraint):
            unique_schema = item.this
            if not isinstance(unique_schema, exp.Schema):
                raise ValueError(f"unparseable UNIQUE constraint: {item}")
            uniques.add(_identifier_names(list(unique_schema.expressions)))
        elif isinstance(item, exp.ForeignKey):
            foreign_keys.add(_foreign_key_contract(item))
        elif isinstance(item, exp.CheckColumnConstraint):
            check = _canonical_sql(item.this)
            if check is not None:
                table_checks.append(check)

    primary_key = table_primary_key or tuple(inline_primary_key)
    return table_name, TableContract(
        columns=columns,
        primary_key=primary_key,
        uniques=frozenset(uniques),
        foreign_keys=frozenset(foreign_keys),
        table_checks=tuple(sorted(table_checks)),
    )


def _index_contract(index: exp.Index, unique: bool) -> tuple[str, IndexContract]:
    params = index.args.get("params")
    if not isinstance(params, exp.IndexParameters):
        raise ValueError(f"{index.name}: missing index parameters")

    columns: list[tuple[str, bool]] = []
    for ordered in params.args.get("columns") or []:
        expression = ordered.this if isinstance(ordered, exp.Ordered) else ordered
        canonical = _canonical_sql(expression)
        if canonical is None:
            raise ValueError(f"{index.name}: missing index expression")
        columns.append((canonical, bool(ordered.args.get("desc"))))

    where = params.args.get("where")
    predicate = _canonical_sql(where.this if isinstance(where, exp.Where) else where)
    method = _canonical_sql(params.args.get("using"))
    include = tuple(
        canonical
        for item in params.args.get("include") or []
        if (canonical := _canonical_sql(item)) is not None
    )
    return index.name.lower(), IndexContract(
        table=index.args["table"].name.lower(),
        unique=unique,
        method=method,
        columns=tuple(columns),
        include=include,
        predicate=predicate,
    )


def parse_schema(sql: str, dialect: str) -> ParsedSchema:
    logging.getLogger("sqlglot").setLevel(logging.ERROR)
    tables: dict[str, TableContract] = {}
    indexes: dict[str, IndexContract] = {}

    for statement in sqlglot.parse(sql, read=dialect):
        if statement is None:
            continue
        if isinstance(statement, exp.Create):
            kind = str(statement.args.get("kind") or "").upper()
            if kind == "TABLE" and isinstance(statement.this, exp.Schema):
                table_name, table = _table_contract(statement.this, dialect)
                if table_name in tables:
                    raise ValueError(f"{table_name}: duplicate CREATE TABLE")
                tables[table_name] = table
            elif kind == "INDEX" and isinstance(statement.this, exp.Index):
                index_name, index = _index_contract(
                    statement.this, bool(statement.args.get("unique"))
                )
                indexes[index_name] = index
        elif isinstance(statement, exp.Drop):
            kind = str(statement.args.get("kind") or "").upper()
            if kind == "INDEX":
                indexes.pop(statement.this.name.lower(), None)

    return ParsedSchema(tables=tables, indexes=indexes)


def _effective_not_null(table: TableContract, column_name: str) -> bool:
    return table.columns[column_name].explicit_not_null or column_name in table.primary_key


def _expected_pg_type(table: str, column: str, sqlite_type: str) -> str:
    if sqlite_type == "TEXT":
        return "TEXT"
    if sqlite_type == "INTEGER":
        return "INTEGER" if (table, column) in POSTGRES_INT4_COLUMNS else "BIGINT"
    raise ValueError(f"{table}.{column}: unreviewed D1 type {sqlite_type}")


def _format_contract(value: object) -> str:
    if isinstance(value, (set, frozenset)):
        return "[" + ", ".join(repr(item) for item in sorted(value)) + "]"
    return repr(value)


def compare_relational_contract(sqlite: ParsedSchema, postgres: ParsedSchema) -> list[str]:
    problems: list[str] = []
    sqlite_names = set(sqlite.tables)
    pg_names = set(postgres.tables)
    sqlite_column_keys = {
        (table_name, column_name)
        for table_name, table in sqlite.tables.items()
        for column_name in table.columns
    }
    for table_name, column_name in sorted(
        (POSTGRES_INT4_COLUMNS | POSTGRES_IDENTITY_COLUMNS) - sqlite_column_keys
    ):
        problems.append(
            f"{table_name}.{column_name}: stale reviewed dialect-contract entry"
        )
    for table_name, expected in LOAD_BEARING_PRIMARY_KEYS.items():
        table = sqlite.tables.get(table_name)
        if table is None or table.primary_key != expected:
            actual = None if table is None else table.primary_key
            problems.append(
                f"{table_name}: load-bearing primary key contract mismatch "
                f"(expected={expected!r}, D1={actual!r})"
            )

    for table in sorted(sqlite_names - pg_names):
        problems.append(f"table only in schema.sql (missing from Postgres port): {table}")
    for table in sorted(pg_names - sqlite_names):
        problems.append(f"table only in schema.pg.sql (not in D1): {table}")

    for table_name in sorted(sqlite_names & pg_names):
        sqlite_table = sqlite.tables[table_name]
        pg_table = postgres.tables[table_name]
        sqlite_columns = set(sqlite_table.columns)
        pg_columns = set(pg_table.columns)
        for column in sorted(sqlite_columns - pg_columns):
            problems.append(f"{table_name}.{column}: missing from schema.pg.sql")
        for column in sorted(pg_columns - sqlite_columns):
            problems.append(f"{table_name}.{column}: only in schema.pg.sql")

        for column_name in sorted(sqlite_columns & pg_columns):
            sqlite_column = sqlite_table.columns[column_name]
            pg_column = pg_table.columns[column_name]
            try:
                expected_type = _expected_pg_type(
                    table_name, column_name, sqlite_column.declared_type
                )
            except ValueError as error:
                problems.append(str(error))
            else:
                if pg_column.declared_type != expected_type:
                    problems.append(
                        f"{table_name}.{column_name}: type mismatch "
                        f"(D1 {sqlite_column.declared_type} requires Postgres "
                        f"{expected_type}, got {pg_column.declared_type})"
                    )

            sqlite_not_null = _effective_not_null(sqlite_table, column_name)
            pg_not_null = _effective_not_null(pg_table, column_name)
            if sqlite_not_null != pg_not_null:
                problems.append(
                    f"{table_name}.{column_name}: nullability mismatch "
                    f"(D1 not-null={sqlite_not_null}, Postgres not-null={pg_not_null})"
                )
            if sqlite_column.default != pg_column.default:
                problems.append(
                    f"{table_name}.{column_name}: default mismatch "
                    f"(D1={sqlite_column.default!r}, Postgres={pg_column.default!r})"
                )
            if sqlite_column.checks != pg_column.checks:
                problems.append(
                    f"{table_name}.{column_name}: check constraint mismatch "
                    f"(D1={sqlite_column.checks!r}, Postgres={pg_column.checks!r})"
                )

            identity_key = (table_name, column_name)
            expected_identity = identity_key in POSTGRES_IDENTITY_COLUMNS
            if sqlite_column.auto_increment != expected_identity:
                problems.append(
                    f"{table_name}.{column_name}: D1 AUTOINCREMENT contract mismatch "
                    f"(reviewed={expected_identity}, actual={sqlite_column.auto_increment})"
                )
            if pg_column.identity != expected_identity:
                problems.append(
                    f"{table_name}.{column_name}: generated identity mismatch "
                    f"(expected={expected_identity}, actual={pg_column.identity})"
                )

        if sqlite_table.primary_key != pg_table.primary_key:
            problems.append(
                f"{table_name}: primary key mismatch "
                f"(D1={sqlite_table.primary_key!r}, Postgres={pg_table.primary_key!r})"
            )
        if sqlite_table.uniques != pg_table.uniques:
            problems.append(
                f"{table_name}: unique constraint mismatch "
                f"(D1={_format_contract(sqlite_table.uniques)}, "
                f"Postgres={_format_contract(pg_table.uniques)})"
            )
        if sqlite_table.foreign_keys != pg_table.foreign_keys:
            problems.append(
                f"{table_name}: foreign key mismatch "
                f"(D1={_format_contract(sqlite_table.foreign_keys)}, "
                f"Postgres={_format_contract(pg_table.foreign_keys)})"
            )
        if sqlite_table.table_checks != pg_table.table_checks:
            problems.append(
                f"{table_name}: check constraint mismatch "
                f"(D1={sqlite_table.table_checks!r}, "
                f"Postgres={pg_table.table_checks!r})"
            )

    sqlite_indexes = set(sqlite.indexes)
    pg_indexes = set(postgres.indexes)
    for index in sorted(sqlite_indexes - pg_indexes):
        problems.append(f"{index}: index missing from schema.pg.sql")
    for index in sorted(pg_indexes - sqlite_indexes):
        problems.append(f"{index}: index only in schema.pg.sql")
    for index_name in sorted(sqlite_indexes & pg_indexes):
        if sqlite.indexes[index_name] != postgres.indexes[index_name]:
            problems.append(
                f"{index_name}: index mismatch "
                f"(D1={sqlite.indexes[index_name]!r}, "
                f"Postgres={postgres.indexes[index_name]!r})"
            )

    return problems


def _sqlite_generation_triggers(sqlite_sql: str) -> tuple[dict[str, str], list[str]]:
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(sqlite_sql)
        rows = connection.execute(
            "SELECT name, sql FROM sqlite_schema "
            "WHERE type = 'trigger' AND name LIKE ? ORDER BY name",
            (f"{GENERATION_FUNCTION}%",),
        ).fetchall()
    finally:
        connection.close()

    triggers = {name.lower(): sql for name, sql in rows}
    problems: list[str] = []
    expected_names = {
        f"{GENERATION_FUNCTION}_{suffix}_{event.lower()}"
        for suffix in GENERATION_TRIGGER_TABLES.values()
        for event in GENERATION_EVENTS
    }
    for name in sorted(expected_names - set(triggers)):
        problems.append(f"{name}: D1 generation trigger missing")
    for name in sorted(set(triggers) - expected_names):
        problems.append(f"{name}: unreviewed D1 generation trigger")

    expected_body_fragments = (
        "update license_plan_projection_generations",
        "set generation = generation + 1",
        "updated_at = cast(strftime('%s', 'now') as integer)",
        "where scope = 'catalog'",
    )
    for table, suffix in GENERATION_TRIGGER_TABLES.items():
        for event in GENERATION_EVENTS:
            name = f"{GENERATION_FUNCTION}_{suffix}_{event.lower()}"
            trigger_sql = triggers.get(name)
            if trigger_sql is None:
                continue
            canonical = " ".join(trigger_sql.lower().split())
            declaration = f"after {event.lower()} on {table}"
            if declaration not in canonical:
                problems.append(f"{table}: D1 generation trigger event mismatch ({name})")
            for fragment in expected_body_fragments:
                if fragment not in canonical:
                    problems.append(f"{name}: D1 generation trigger body mismatch")
                    break
    return triggers, problems


def _postgres_generation_triggers(pg_sql: str) -> tuple[dict[str, PgTriggerContract], list[str]]:
    trigger_pattern = re.compile(
        r"CREATE\s+TRIGGER\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+"
        r"(?P<timing>BEFORE|AFTER|INSTEAD\s+OF)\s+"
        r"(?P<events>INSERT|UPDATE|DELETE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE))*\s+"
        r"ON\s+(?P<table>[A-Za-z_][A-Za-z0-9_]*)\s+"
        r"FOR\s+EACH\s+(?P<for_each>ROW|STATEMENT)\s+"
        r"EXECUTE\s+FUNCTION\s+(?P<function>[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*;",
        re.IGNORECASE,
    )
    triggers: dict[str, PgTriggerContract] = {}
    for match in trigger_pattern.finditer(pg_sql):
        name = match.group("name").lower()
        if not name.startswith(GENERATION_FUNCTION):
            continue
        event_text = match.group(0).split(" ON ", 1)[0]
        events = frozenset(
            event.upper()
            for event in re.findall(r"\b(?:INSERT|UPDATE|DELETE)\b", event_text, re.IGNORECASE)
        )
        triggers[name] = PgTriggerContract(
            table=match.group("table").lower(),
            events=events,
            timing=" ".join(match.group("timing").upper().split()),
            for_each=match.group("for_each").upper(),
            function=match.group("function").lower(),
        )

    problems: list[str] = []
    expected_names = {
        f"{GENERATION_FUNCTION}_{suffix}"
        for suffix in GENERATION_TRIGGER_TABLES.values()
    }
    for name in sorted(expected_names - set(triggers)):
        problems.append(f"{name}: Postgres generation trigger missing")
    for name in sorted(set(triggers) - expected_names):
        problems.append(f"{name}: unreviewed Postgres generation trigger")

    for table, suffix in GENERATION_TRIGGER_TABLES.items():
        name = f"{GENERATION_FUNCTION}_{suffix}"
        trigger = triggers.get(name)
        if trigger is None:
            continue
        if trigger.table != table:
            problems.append(
                f"{table}: generation trigger table mismatch (actual={trigger.table})"
            )
        if trigger.events != GENERATION_EVENT_SET:
            problems.append(
                f"{table}: generation trigger event mismatch "
                f"(expected={sorted(GENERATION_EVENTS)!r}, actual={sorted(trigger.events)!r})"
            )
        if trigger.timing != "AFTER" or trigger.for_each != "STATEMENT":
            problems.append(
                f"{table}: generation trigger execution mismatch "
                f"(expected=AFTER/STATEMENT, "
                f"actual={trigger.timing}/{trigger.for_each})"
            )
        if trigger.function != GENERATION_FUNCTION:
            problems.append(
                f"{table}: generation trigger function mismatch "
                f"(actual={trigger.function})"
            )

    function_pattern = re.compile(
        rf"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+{GENERATION_FUNCTION}\s*\(\s*\)\s*"
        r"RETURNS\s+TRIGGER\s+AS\s+\$\$(?P<body>.*?)\$\$\s+LANGUAGE\s+plpgsql\s*;",
        re.IGNORECASE | re.DOTALL,
    )
    functions = list(function_pattern.finditer(pg_sql))
    if len(functions) != 1:
        problems.append(
            f"{GENERATION_FUNCTION}: expected one Postgres function, found {len(functions)}"
        )
    else:
        body = " ".join(functions[0].group("body").lower().split())
        expected_body = " ".join(
            """
            BEGIN
              UPDATE license_plan_projection_generations
              SET generation = generation + 1,
                  updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
              WHERE scope = 'catalog';
              RETURN NULL;
            END;
            """.lower().split()
        )
        if body != expected_body:
            problems.append(f"{GENERATION_FUNCTION}: function body mismatch")

    return triggers, problems


def compare_generation_contract(sqlite_sql: str, pg_sql: str) -> list[str]:
    _, sqlite_problems = _sqlite_generation_triggers(sqlite_sql)
    _, pg_problems = _postgres_generation_triggers(pg_sql)
    return sqlite_problems + pg_problems


def check_parity(sqlite_path: Path, pg_path: Path) -> tuple[list[str], int, int]:
    sqlite_sql = sqlite_path.read_text(encoding="utf-8")
    pg_sql = pg_path.read_text(encoding="utf-8")

    # Execute the D1 snapshot as well as parsing it. This preserves the previous
    # authoritative-engine check and gives trigger introspection real SQLite
    # semantics rather than accepting merely parseable text.
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(sqlite_sql)
    finally:
        connection.close()

    sqlite_schema = parse_schema(sqlite_sql, "sqlite")
    pg_schema = parse_schema(pg_sql, "postgres")
    problems = compare_relational_contract(sqlite_schema, pg_schema)
    problems.extend(compare_generation_contract(sqlite_sql, pg_sql))
    return problems, len(sqlite_schema.tables), len(sqlite_schema.indexes)


def main() -> int:
    try:
        problems, table_count, index_count = check_parity(SQLITE_SNAPSHOT, PG_SNAPSHOT)
    except (OSError, sqlite3.Error, sqlglot.errors.SqlglotError, ValueError) as error:
        print(f"Postgres schema parity FAILED: could not inspect schema: {error}")
        return 1

    if problems:
        print("Postgres schema parity FAILED:")
        for problem in problems:
            print(f"  - {problem}")
        print(
            "\nThe D1 migration history/schema.sql remains authoritative. "
            "Review the explicit dialect contract in check-pg-parity.py, then update "
            "the fenced fresh-bootstrap schema.pg.sql as needed.\n"
            "Re-run: npm run schema:parity:pg"
        )
        return 1

    print(
        "pg schema semantic parity ok "
        f"({table_count} tables, {index_count} explicit indexes, "
        f"{len(GENERATION_TRIGGER_TABLES)} generation trigger groups)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
