#!/usr/bin/env python3
import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
SNAPSHOT = ROOT / "schema.sql"


def normalize_sql(sql: str) -> str:
    sql = sql.replace('"', "")
    sql = re.sub(r"\bIF\s+NOT\s+EXISTS\s+", "", sql, flags=re.IGNORECASE)
    sql = re.sub(r"\s+", " ", sql.strip())
    return sql.lower()


def apply_sql(conn: sqlite3.Connection, path: Path) -> None:
    conn.executescript(path.read_text(encoding="utf-8"))


def build_from_migrations() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for path in sorted(MIGRATIONS.glob("*.sql")):
        apply_sql(conn, path)
    return conn


def build_from_snapshot() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    apply_sql(conn, SNAPSHOT)
    return conn


def schema_objects(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute(
        """
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
          AND type IN ('table', 'index', 'trigger', 'view')
        ORDER BY type, name
        """,
    ).fetchall()
    return {f"{row[0]}:{row[1]}:{row[2]}": normalize_sql(row[3]) for row in rows}


def main() -> int:
    migration_schema = schema_objects(build_from_migrations())
    snapshot_schema = schema_objects(build_from_snapshot())
    if migration_schema == snapshot_schema:
        print("schema parity ok")
        return 0

    migration_keys = set(migration_schema)
    snapshot_keys = set(snapshot_schema)
    for key in sorted(migration_keys - snapshot_keys):
        print(f"only in migrations: {key}")
    for key in sorted(snapshot_keys - migration_keys):
        print(f"only in schema.sql: {key}")
    for key in sorted(migration_keys & snapshot_keys):
        if migration_schema[key] != snapshot_schema[key]:
            print(f"schema mismatch: {key}")
            print(f"  migrations: {migration_schema[key]}")
            print(f"  schema.sql: {snapshot_schema[key]}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
