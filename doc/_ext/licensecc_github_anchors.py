"""Let ``sphinx -b linkcheck`` verify heading anchors on GitHub-rendered Markdown.

GitHub gives each Markdown heading the element id ``user-content-<slug>``, and a
script resolves ``#<slug>`` to it in the browser. Sphinx used to rewrite GitHub
anchors to that form, but it disabled the rewrite (sphinx-doc/sphinx#9435)
because other GitHub pages, such as line links (``#L10``) or a directory's
``#readme``, do not use the prefix. Without it, every link to a README heading
fails with "Anchor not found", even when the heading exists.

This extension restores the rewrite only for heading anchors into Markdown files
(``https://github.com/<owner>/<repo>/blob/<ref>/<path>.md#<slug>``). The anchor
check still runs, so a link to a heading that no longer exists still fails.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse, urlunparse

_LINE_ANCHOR = re.compile(r"L\d+(C\d+)?(-L\d+(C\d+)?)?")
_PREFIX = "user-content-"


def github_markdown_anchor(uri: str) -> str | None:
    """Return ``uri`` with a GitHub Markdown heading anchor prefixed, or None."""
    parsed = urlparse(uri)
    fragment = parsed.fragment
    if parsed.hostname != "github.com" or not fragment or fragment.startswith(_PREFIX):
        return None
    segments = parsed.path.split("/")
    # ["", owner, repo, "blob", ref, ..., file.md]
    if len(segments) < 6 or segments[3] != "blob" or not parsed.path.lower().endswith(".md"):
        return None
    if _LINE_ANCHOR.fullmatch(fragment):
        return None
    return urlunparse(parsed._replace(fragment=_PREFIX + fragment))


def _process_uri(_app: Any, uri: str) -> str | None:
    return github_markdown_anchor(uri)


def setup(app: Any) -> dict[str, Any]:
    app.connect("linkcheck-process-uri", _process_uri)
    return {"version": "1", "parallel_read_safe": True, "parallel_write_safe": True}
