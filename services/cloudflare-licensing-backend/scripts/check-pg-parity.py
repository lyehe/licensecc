#!/usr/bin/env python3
"""Structural parity between the SQLite snapshot and the Postgres port.

`check-schema-parity.py` proves migrations == schema.sql (both SQLite). This
proves schema.sql (SQLite) and supabase-postgres/schema.pg.sql (Postgres) carry
the SAME set of tables and columns, so a column added to one backend and
forgotten in the other fails CI. Types, defaults, and constraints differ by
design (see the schema.pg.sql header), so only table + column *presence* is
compared, case-insensitively.

The SQLite side is authoritative via PRAGMA (no parsing). The Postgres side is
parsed with sqlglot (robust to nested parens, CHECK/DEFAULT commas, FKs) rather
than regex. Run via: uv run --no-project --with sqlglot python check-pg-parity.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import sqlglot
from sqlglot import exp

ROOT = Path(__file__).resolve().parents[1]
SQLITE_SNAPSHOT = ROOT / "schema.sql"
PG_SNAPSHOT = ROOT / "supabase-postgres" / "schema.pg.sql"


def sqlite_tables() -> dict[str, set[str]]:
    conn = sqlite3.connect(":memory:")
    conn.executescript(SQLITE_SNAPSHOT.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for (name,) in conn.execute(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        cols = {row[1].lower() for row in conn.execute(f'PRAGMA table_info("{name}")').fetchall()}
        out[name.lower()] = cols
    return out


def pg_tables() -> dict[str, set[str]]:
    sql = PG_SNAPSHOT.read_text(encoding="utf-8")
    out: dict[str, set[str]] = {}
    # Uniform pass: for every statement that has a table and column definitions
    # (CREATE TABLE, ALTER TABLE ADD COLUMN), fold its columns into that table.
    # CREATE INDEX/TRIGGER/etc. carry no ColumnDef, so they add nothing.
    for stmt in sqlglot.parse(sql, read="postgres"):
        if stmt is None:
            continue
        table_node = stmt.find(exp.Table)
        col_defs = list(stmt.find_all(exp.ColumnDef))
        if table_node is None or not col_defs:
            continue
        table = table_node.name.lower()
        out.setdefault(table, set()).update(c.name.lower() for c in col_defs)
    return out


def main() -> int:
    sqlite_schema = sqlite_tables()
    pg_schema = pg_tables()

    problems: list[str] = []

    only_sqlite = sorted(set(sqlite_schema) - set(pg_schema))
    only_pg = sorted(set(pg_schema) - set(sqlite_schema))
    for t in only_sqlite:
        problems.append(f"table only in schema.sql (missing from Postgres port): {t}")
    for t in only_pg:
        problems.append(f"table only in schema.pg.sql (not in SQLite): {t}")

    for table in sorted(set(sqlite_schema) & set(pg_schema)):
        s_cols = sqlite_schema[table]
        p_cols = pg_schema[table]
        for c in sorted(s_cols - p_cols):
            problems.append(f"{table}.{c}: in schema.sql, missing from schema.pg.sql")
        for c in sorted(p_cols - s_cols):
            problems.append(f"{table}.{c}: in schema.pg.sql, missing from schema.sql")

    if problems:
        print("Postgres schema parity FAILED:")
        for p in problems:
            print(f"  - {p}")
        print(
            "\nEvery migration must edit migrations/ + schema.sql + supabase-postgres/schema.pg.sql.\n"
            "Fix the drift above, then re-run: npm run schema:parity:pg"
        )
        return 1

    print(f"pg schema parity ok ({len(sqlite_schema)} tables)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
