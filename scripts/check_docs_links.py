#!/usr/bin/env python3
"""Fail on malformed URL schemes in documentation source files."""

from __future__ import annotations

import pathlib
import re
import sys


SUPPORTED_SCHEMES = {"http", "https", "mailto"}
TEXT_EXTENSIONS = {".css", ".html", ".md", ".rst", ".txt", ".xml"}
SKIP_DIRS = {"_build", "_doxygen", ".doctrees"}
URL_SCHEME = re.compile(r"(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*)://")


def iter_text_files(root: pathlib.Path):
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file() and path.suffix.lower() in TEXT_EXTENSIONS:
            yield path


def main(argv: list[str]) -> int:
    root = pathlib.Path(argv[1] if len(argv) > 1 else "doc")
    failures: list[str] = []

    for path in iter_text_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = path.read_text(encoding="utf-8", errors="replace")

        for line_number, line in enumerate(text.splitlines(), start=1):
            for match in URL_SCHEME.finditer(line):
                scheme = match.group(1).lower()
                if scheme not in SUPPORTED_SCHEMES:
                    column = match.start(1) + 1
                    failures.append(
                        f"{path}:{line_number}:{column}: unsupported URL scheme '{match.group(1)}://'"
                    )

    if failures:
        print("Malformed documentation links found:", file=sys.stderr)
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
