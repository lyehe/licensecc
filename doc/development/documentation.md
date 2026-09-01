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

## Content authority

Keep each fact in one authoritative place and link to it elsewhere:

- `README.md` explains the product, routes each audience, and provides one
  first success.
- `doc/` owns maintained tutorials, how-to guides, reference, operations,
  security, architecture, and contributor documentation.
- A service or SDK README owns commands and configuration local to that
  component. Central guides link to those runbooks instead of copying
  credential-bearing deployment sequences.
- `doc/capabilities/registry.json` owns shipped-versus-planned status.
- `doc/architecture/` owns repository boundaries and required change routes.
- `AGENTS.md` and `.agents/skills/using-licensecc/SKILL.md` are concise agent
  entry points; they link to architecture rather than restating it.

Historical analysis is retained for auditability but is not part of the
task-oriented reader path. Protected plans under `docs/superpowers/plans/`
are never documentation-edit targets.

## Page contract

Task-oriented pages should make the execution contract explicit:

1. **Audience and goal** — who should use the page and the observable outcome.
2. **Prerequisites** — only the tools and access required for this task.
3. **Starting directory and shell** — before every operational command block.
4. **Commands and expected result** — copyable commands plus the success
   signal a reader should observe.
5. **Safety boundary** — remote side effects, required authority, and secret or
   private-key handling where applicable.
6. **Troubleshooting and next step** — the shortest recovery path and the next
   authoritative guide.
7. **Verification** — the focused repository command that proves the page
   remains correct.

Use tutorials for guided first success, how-to guides for a specific goal,
reference pages for exact interfaces, and explanation pages for design and
tradeoffs. Prefer Sphinx `:doc:`/`:ref:` roles or MyST `{doc}`/`{ref}` roles to
raw source paths so strict builds validate navigation.

## Published documentation contract

`.readthedocs.yaml` is the source-controlled Read the Docs build contract.
`doc/conf.py` obtains the canonical URL from the
`READTHEDOCS_CANONICAL_URL` build variable; never hard-code the retired
upstream GitHub Pages domain or an unconfirmed Read the Docs project slug.

The project is currently prerelease across the combined platform surface. In
the Read the Docs dashboard:

- import `https://github.com/lyehe/licensecc` with `main` as the default branch;
- keep `latest` active and make it the default public version while no reviewed
  combined stable documentation release exists;
- do not activate inherited bare `v*` tags as current documentation;
- enable pull-request builds without exposing deployment credentials; and
- configure redirects for any previously published fork-owned URLs before
  renaming or moving pages.

Read the Docs dashboard state and repository source are separate evidence. A
local build proves the source contract; it does not claim that project import,
version activation, redirects, or pull-request previews are enabled remotely.

`doc/_extra/llms.txt` is copied to the HTML root through `html_extra_path` and
acts only as a curated link index. It must not duplicate safety policy or
operational procedures. Read the Docs serves the file from the default active
version after that version has built successfully.

## Review checklist

For documentation changes, verify all of the following before handoff:

- commands exist in the named manifest and run from the documented directory;
- local evaluation is distinct from staging or production mutation;
- local Markdown and reStructuredText links resolve;
- examples state their shell, starting directory, and expected output;
- changed public URLs retain labels and have a redirect plan;
- generated routes and API signatures still come from their authoritative
  OpenAPI, Doxygen, or autodoc sources; and
- the handoff names the commit or worktree state, exact gates run, and any
  untested surface instead of saying only "all green".
