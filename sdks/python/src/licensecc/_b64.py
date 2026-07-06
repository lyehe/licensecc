"""Strict, canonical standard base64 — a faithful port of the C++ verifier.

The C++ verifier (``src/library/base/base64.cpp``) accepts a base64 string only
when it is *canonical*: decoding it and re-encoding the bytes reproduces the
exact same string. This rejects, among other things:

  * url-safe base64 (``-``/``_`` instead of ``+``/``/``),
  * non-canonical padding (extra ``=`` or ``=`` in the wrong place),
  * non-zero "tail" bits in the final quantum (e.g. ``QUJD?`` variants that
    decode to the same bytes but are not the canonical spelling),
  * embedded whitespace/newlines (the token path uses ``allow_line_breaks=False``).

We mirror that behaviour so that a token the C++ verifier would reject for a
malformed envelope is rejected here too — fail-closed parity.
"""

from __future__ import annotations

import base64 as _stdlib_base64

_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_ALPHABET_SET = frozenset(_STD_ALPHABET)


def encode_std(data: bytes) -> str:
    """Standard base64 (with ``=`` padding, no line breaks) — matches C++ ``base64(.., 0)``."""
    return _stdlib_base64.b64encode(data).decode("ascii")


def _is_canonical_standard_b64(text: str) -> bool:
    """True iff ``text`` is the canonical standard-base64 spelling of some bytes.

    Equivalent to the C++ ``is_canonical_base64(text, allow_line_breaks=False)``:
    no line breaks, length a multiple of 4, only the standard alphabet, padding
    only at the end, and re-encoding the decoded bytes reproduces ``text``.
    """
    if not text:
        return False
    if "\n" in text or "\r" in text:
        return False
    if len(text) % 4 != 0:
        return False
    # Padding may only appear (at most twice) at the very end.
    pad = 0
    body_len = len(text)
    if text.endswith("=="):
        pad = 2
        body_len -= 2
    elif text.endswith("="):
        pad = 1
        body_len -= 1
    body = text[:body_len]
    if "=" in body:
        return False
    for ch in body:
        if ch not in _ALPHABET_SET:
            return False
    try:
        decoded = _stdlib_base64.b64decode(text, validate=True)
    except (ValueError, Exception):  # noqa: BLE001 - any decode failure is non-canonical
        return False
    if not decoded:
        return False
    # Canonical iff round-trip is stable (catches non-zero tail bits).
    return encode_std(decoded) == text


def decode_std_canonical(text: str) -> bytes | None:
    """Decode standard base64, returning ``None`` if ``text`` is not canonical.

    Returns ``None`` (never raises) on any malformed / non-canonical input, so
    callers stay fail-closed. An empty result also yields ``None`` because the
    C++ verifier treats an empty decode as a malformed envelope.
    """
    if not _is_canonical_standard_b64(text):
        return None
    decoded = _stdlib_base64.b64decode(text, validate=True)
    return decoded if decoded else None
