# Documentation checks

The documentation site combines Doxygen XML with Sphinx and Breathe. Build it
strictly from the repository root with:

```console
npm run check:docs
```

The command writes only ignored `doc/_doxygen/` and `doc/_build/` output. It
requires Doxygen and `uv`; the Ubuntu CI job installs Doxygen before running the
same command. The build installs `sdks/python` into an isolated `uv`
environment so Sphinx autodoc validates the public Python surface instead of
reading a copied signature list.

## API reference sources

Keep each API reference attached to its authoritative source:

- C and C++ reference pages use Doxygen comments in `include/licensecc/` and
  are rendered through Breathe.
- Python reference pages use Sphinx autodoc against `sdks/python`.
- Worker operation inventories use `doc/_ext/licensecc_openapi.py` to render
  the reviewed snapshots in `test/contracts/`; do not maintain a second list
  of routes in prose.
- SDK comparison and usage guidance belongs in `doc/api/`, with links to the
  SDK-native READMEs for language-specific installation examples.

Add new reference pages to `doc/api/index.rst`. The top-level `doc/index.rst`
should continue to link only that landing page so the API hierarchy has one
owner.

The editable dependency policy is `doc/requirements.in`. Regenerate the pinned
lock file after an intentional dependency-policy change:

```console
uv pip compile --generate-hashes doc/requirements.in --output-file doc/requirements.txt
```

Do not edit `doc/requirements.txt` by hand. The network-sensitive link checker
is deliberately separate and is run only by its scheduled/manual CI workflow:

```console
npm run check:docs:links
```
