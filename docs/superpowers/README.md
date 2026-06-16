# Internal development planning (not user docs)

This directory (`docs/`) holds **internal** development planning only — design
specs, implementation plans, and per-feature status indexes. It is **not** part
of the published documentation.

Mind the singular/plural collision:

- **`doc/`** (singular) — the **user-facing** reference site (Sphinx + Breathe +
  Doxygen). Built with `make docs` / `make documentation`. Edit this for
  anything end users read.
- **`docs/superpowers/`** (this dir) — internal plans:
  - `specs/` — design specs (the source of truth for a feature's intent).
  - `plans/` — dated implementation plans and checklists.
  - `features/` — one status index per feature; start here for a feature's
    current shipped-vs-pending state.

> Whole-repo orientation — the top-level layout, the C++ module dependency
> graph, and the multi-role Cloudflare backend — lives in the root `CLAUDE.md`
> under "Repository layout" / "Cloudflare services".

## Feature status indexes

- [Signed config token](features/signed-config-token-status.md)
