# Documentation checks

The documentation site combines Doxygen XML with Sphinx and Breathe. Build it
strictly from the repository root with:

```console
npm run check:docs
```

The command writes only ignored `doc/_doxygen/` and `doc/_build/` output. It
requires Doxygen and `uv`; the Ubuntu CI job installs Doxygen before running the
same command.

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
