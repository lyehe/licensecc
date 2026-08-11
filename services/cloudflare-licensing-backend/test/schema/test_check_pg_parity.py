from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[2]
CHECKER = SERVICE_ROOT / "scripts" / "check-pg-parity.py"
SQLITE_SCHEMA = SERVICE_ROOT / "schema.sql"
POSTGRES_SCHEMA = SERVICE_ROOT / "supabase-postgres" / "schema.pg.sql"
FIXTURES = (
    SERVICE_ROOT
    / "test"
    / "fixtures"
    / "pg-parity"
    / "adversarial-mutations.json"
)


class PgParityContractTest(unittest.TestCase):
    maxDiff = None

    def run_checker(
        self, mutation: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="licensecc-pg-parity-") as tmp:
            service = Path(tmp)
            (service / "scripts").mkdir()
            (service / "supabase-postgres").mkdir()
            shutil.copy2(CHECKER, service / "scripts" / CHECKER.name)

            sqlite_sql = SQLITE_SCHEMA.read_text(encoding="utf-8")
            postgres_sql = POSTGRES_SCHEMA.read_text(encoding="utf-8")
            if mutation:
                target = mutation["source"]
                self.assertIn(target, {"sqlite", "postgres"})
                original = sqlite_sql if target == "sqlite" else postgres_sql
                occurrences = original.count(mutation["old"])
                self.assertEqual(
                    occurrences,
                    1,
                    f"fixture {mutation['name']} must match exactly once, got {occurrences}",
                )
                mutated = original.replace(mutation["old"], mutation["new"], 1)
                if target == "sqlite":
                    sqlite_sql = mutated
                else:
                    postgres_sql = mutated

            (service / "schema.sql").write_text(sqlite_sql, encoding="utf-8")
            (service / "supabase-postgres" / "schema.pg.sql").write_text(
                postgres_sql, encoding="utf-8"
            )
            return subprocess.run(
                [sys.executable, str(service / "scripts" / CHECKER.name)],
                cwd=service,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )

    def test_reviewed_schema_contract_passes(self) -> None:
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_each_semantic_mutation_fails_independently(self) -> None:
        mutations = json.loads(FIXTURES.read_text(encoding="utf-8"))
        self.assertEqual(len({mutation["name"] for mutation in mutations}), len(mutations))
        for mutation in mutations:
            with self.subTest(mutation=mutation["name"]):
                result = self.run_checker(mutation)
                output = result.stdout + result.stderr
                self.assertNotEqual(
                    result.returncode,
                    0,
                    f"mutation {mutation['name']} unexpectedly passed\n{output}",
                )
                self.assertIn(mutation["expected"], output)


if __name__ == "__main__":
    unittest.main()
