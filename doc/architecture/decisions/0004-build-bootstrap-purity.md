# ADR 0004: Build and bootstrap purity

- Status: Accepted
- Date: 2026-08-08
- Decision owners: repository maintainers

## Context

The C++ project generates license projects, headers, and install artifacts;
the service workspace generates Worker/UI output; and the docs build generates
Doxygen/Sphinx trees. Earlier workflows could make source-tree changes or
implicitly initialize/patch the generator while checking a build. That makes
reviews, reproducibility, and concurrent work unsafe.

## Decision

Build and check commands are read-only with respect to tracked source and
vendored inputs:

* CMake presets write generated project material, templates, lease-ring output,
  and install artifacts under the active `build/<preset>` or explicitly
  selected install tree. They do not write `projects/` in the source checkout.
* `scripts/check-build-purity.ps1` snapshots tracked and untracked source
  fingerprints before configure/build/CTest and fails when the command changes
  them. It does not clean or reset a pre-existing user change.
* `scripts/bootstrap.ps1 -CheckOnly` validates the vendored
  `extern/license-generator` source tree. It never fetches or initializes
  source; no build command applies `patches/` or mutates vendored input.
* Node uses one root `npm ci`; generated `dist/`, `.wrangler/`, and type output
  remain ignored local/build artifacts. Documentation output remains under
  ignored `doc/_build/` and `doc/_doxygen/` trees.
* Real Wrangler configurations, secrets, local databases, SDK build output,
  and browser caches remain local. Only example configuration is tracked.

The vendored generator source, its BSD-3-Clause license, and its provenance
record are repository state. It is not an input that documentation or build
work may fetch, overwrite, or repair.

## Consequences

* A normal build can be run concurrently with source review without silently
  rewriting source, generated inputs, or vendored code.
* Purity failures identify a command or tool that crossed the source/build
  boundary and must be fixed at that boundary rather than hidden by cleanup.
* A clean clone already contains generator source; `-CheckOnly` verifies the
  expected files before a core build without any network or source mutation.
* CI can use the same local purity and bootstrap commands on Windows and Ubuntu;
  platform tool availability is evidence, not an implicit mutation step.
