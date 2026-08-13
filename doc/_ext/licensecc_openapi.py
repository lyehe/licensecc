"""Render reviewed Worker OpenAPI snapshots without duplicating route prose."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from docutils import nodes
from sphinx.errors import SphinxError
from sphinx.util.docutils import SphinxDirective


CONTRACTS: dict[str, tuple[str, str]] = {
    "backend": ("backend.json", "openApiSpec"),
    "admin": ("admin.json", "openApiDocument"),
    "portal": ("portal.json", "openApiDocument"),
}
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def _cell(*children: nodes.Node) -> nodes.entry:
    entry = nodes.entry()
    paragraph = nodes.paragraph()
    paragraph.extend(children)
    entry += paragraph
    return entry


def _text_cell(value: str) -> nodes.entry:
    return _cell(nodes.Text(value))


def _literal_cell(value: str, *classes: str) -> nodes.entry:
    literal = nodes.literal(text=value)
    literal["classes"].extend(classes)
    return _cell(literal)


class LicenseccOpenApiDirective(SphinxDirective):
    """Insert the operation inventory from a canonical contract snapshot."""

    required_arguments = 1
    final_argument_whitespace = False
    has_content = False

    def run(self) -> list[nodes.Node]:
        service = self.arguments[0].strip().lower()
        if service not in CONTRACTS:
            choices = ", ".join(sorted(CONTRACTS))
            raise self.error(f"unknown Licensecc OpenAPI service {service!r}; expected one of: {choices}")

        repository_root = Path(self.env.app.confdir).parent
        filename, document_key = CONTRACTS[service]
        snapshot_path = repository_root / "test" / "contracts" / filename
        self.env.note_dependency(str(snapshot_path))

        try:
            snapshot: dict[str, Any] = json.loads(snapshot_path.read_text(encoding="utf-8"))
            document: dict[str, Any] = snapshot[document_key]
            info: dict[str, Any] = document["info"]
            paths: dict[str, Any] = document["paths"]
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise SphinxError(f"cannot read {service} OpenAPI contract from {snapshot_path}: {error}") from error

        operations: list[tuple[str, str, str, str]] = []
        operation_ids: set[str] = set()
        for path, path_item in paths.items():
            if not isinstance(path_item, dict):
                raise SphinxError(f"{service} OpenAPI path {path!r} is not an object")
            for method in HTTP_METHODS:
                operation = path_item.get(method)
                if operation is None:
                    continue
                if not isinstance(operation, dict):
                    raise SphinxError(f"{service} OpenAPI operation {method.upper()} {path} is not an object")
                operation_id = operation.get("operationId")
                summary = operation.get("summary")
                if not isinstance(operation_id, str) or not operation_id:
                    raise SphinxError(f"{service} OpenAPI operation {method.upper()} {path} has no operationId")
                if operation_id in operation_ids:
                    raise SphinxError(f"{service} OpenAPI operationId {operation_id!r} is not unique")
                if not isinstance(summary, str) or not summary:
                    raise SphinxError(f"{service} OpenAPI operation {method.upper()} {path} has no summary")
                operation_ids.add(operation_id)
                operations.append(
                    (
                        method.upper(),
                        path,
                        operation_id,
                        summary,
                    )
                )

        expected_count = snapshot.get("openApiOperationCount")
        if expected_count != len(operations):
            raise SphinxError(
                f"{service} OpenAPI inventory contains {len(operations)} operations; "
                f"the reviewed snapshot declares {expected_count!r}"
            )

        container = nodes.container(classes=["licensecc-openapi"])
        description = nodes.paragraph()
        description += nodes.strong(text=str(info.get("title", service)))
        description += nodes.Text(
            f" — OpenAPI {document.get('openapi', 'unknown')}, contract {info.get('version', 'unknown')}, "
            f"{len(operations)} operations."
        )
        container += description

        table = nodes.table(classes=["licensecc-api-table"])
        table["ids"].append(f"{service}-openapi-operations")
        tgroup = nodes.tgroup(cols=4)
        table += tgroup
        for width in (8, 28, 25, 39):
            tgroup += nodes.colspec(colwidth=width)

        header = nodes.row()
        for label in ("Method", "Path", "Operation ID", "Summary"):
            header += _text_cell(label)
        thead = nodes.thead()
        thead += header
        tgroup += thead

        tbody = nodes.tbody()
        for method, path, operation_id, summary in operations:
            row = nodes.row()
            row += _literal_cell(method, "http-method", f"http-{method.lower()}")
            row += _literal_cell(path)
            row += _literal_cell(operation_id)
            row += _text_cell(summary)
            tbody += row
        tgroup += tbody
        container += table
        return [container]


def setup(app: Any) -> dict[str, bool]:
    app.add_directive("licensecc-openapi", LicenseccOpenApiDirective)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
