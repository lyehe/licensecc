#!/usr/bin/env python3
"""Build the Read the Docs/Sphinx documentation through uvx."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOC_DIR = ROOT / "doc"
DOXYFILE = DOC_DIR / "Doxyfile"
DOXYGEN_INDEX = DOC_DIR / "_doxygen" / "xml" / "index.xml"
REQUIREMENTS = ROOT / "requirements.txt"
DEFAULT_OUTPUT = ROOT / "build" / "docs" / "sphinx"
LOCAL_TOOLS = ROOT / "build" / "tools"


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def require_command(name: str, install_hint: str) -> int:
    if shutil.which(name) is not None:
        return 0
    return fail(f"{name!r} was not found on PATH. {install_hint}")


def find_doxygen() -> str | None:
    env_value = os.environ.get("DOXYGEN")
    if env_value:
        if Path(env_value).exists() or shutil.which(env_value) is not None:
            return env_value
        return None
    path_value = shutil.which("doxygen")
    if path_value:
        return path_value
    for candidate in sorted(LOCAL_TOOLS.glob("doxygen*/doxygen.exe")):
        return str(candidate)
    for candidate in sorted(LOCAL_TOOLS.glob("doxygen*/bin/doxygen.exe")):
        return str(candidate)
    return None


def docs_requirements() -> tuple[str, list[str]]:
    sphinx_from = ""
    extra = []
    for raw_line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("wheel"):
            continue
        if line.startswith("sphinx=="):
            sphinx_from = line
        else:
            extra.append(line)
    if not sphinx_from:
        raise RuntimeError("requirements.txt must pin sphinx for docs builds")
    return sphinx_from, extra


def run(command: list[str]) -> int:
    print("+ " + " ".join(command), flush=True)
    return subprocess.run(command, cwd=ROOT).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Licensecc documentation with Doxygen and uvx/Sphinx.")
    parser.add_argument("--skip-doxygen", action="store_true",
                        help="Reuse existing Doxygen XML instead of regenerating it.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT),
                        help="Sphinx HTML output directory.")
    parser.add_argument("--no-strict", action="store_true",
                        help="Do not turn Sphinx warnings into build failures.")
    args = parser.parse_args()

    rc = require_command("uvx", "Install uv from https://docs.astral.sh/uv/ or make uvx available.")
    if rc:
        return rc

    if args.skip_doxygen:
        if not DOXYGEN_INDEX.exists():
            return fail("--skip-doxygen was set, but doc/_doxygen/xml/index.xml does not exist")
    else:
        doxygen = find_doxygen()
        if doxygen is None:
            return fail(
                "'doxygen' was not found. Install Doxygen, set DOXYGEN to the executable, "
                "or place a portable Doxygen under build/tools/doxygen*/."
            )
        rc = run([doxygen, str(DOXYFILE)])
        if rc:
            return rc

    sphinx_from, extra_requirements = docs_requirements()
    command = ["uvx", "--from", sphinx_from]
    for requirement in extra_requirements:
        command.extend(["--with", requirement])
    command.append("sphinx-build")
    command.extend(["-b", "html", "--keep-going", "-n"])
    if not args.no_strict:
        command.append("-W")
    command.extend([str(DOC_DIR), str(Path(args.output))])
    return run(command)


if __name__ == "__main__":
    raise SystemExit(main())
