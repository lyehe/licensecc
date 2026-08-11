# ADR 0005: Platform version contract and release tag namespaces

- Status: Accepted
- Date: 2026-08-11
- Decision owners: repository maintainers

## Context

The repository has two release streams. The C++ library continues the upstream
2.x lineage, while the Cloudflare services, shared Node packages, OpenAPI
documents, and Python and .NET SDKs form one platform contract. Before this
decision, platform version strings were repeated without an executable source
of truth. The reachable bare `v1.0.0` tag belongs to inherited upstream history
and is not an identifier for the current platform.

A platform release must be unambiguous about which API and SDK projections it
contains without implying that the independently versioned C++ ABI was released
at the same time.

## Decision

`version.json` is the single machine-readable source for the platform version.
It contains schema version 1 and one `platform_version`: either stable SemVer
`X.Y.Z` or a supported `X.Y.Z-(alpha|beta|rc).N` prerelease. The current platform
prerelease is `0.1.0-rc.1`. Python projects use the mechanically equivalent PEP
440 spelling `0.1.0rc1`; that spelling is a projection, not a second version
authority.

`scripts/check-version-contract.mjs` deterministically verifies the contract
and all tracked release projections:

1. the root and six workspace Node manifests and their entries in the root npm
   lockfile;
2. the backend, admin, and customer-portal OpenAPI `info.version` values and
   their reviewed canonical contract snapshots;
3. Python project metadata, uv lock entry, runtime `__version__`, and default
   HTTP User-Agent;
4. .NET package metadata and its SDK README; and
5. the root and maintained public version documentation plus every platform
   release projection in the capability registry.

The repository-quality workflow runs both the checker tests and the real
repository check exactly once. The root lock projection includes the exact
workspace inventory, each workspace package name/version, and each npm
workspace link target; a repointed or partial lockfile is invalid even when its
remaining version strings happen to match.

The C++ version remains independently owned by the CMake project. The checker
only verifies that its public header macros/string and Sphinx version agree
with CMake; a platform version change never changes the C++ version. The C++
version at this decision is `2.1.0`.

Release tags use disjoint namespaces:

* platform releases: `platform-v<platform-version>`, for example
  `platform-v0.1.0-rc.1`;
* future independent C++ releases: `cpp-v<cpp-version>`, for example
  `cpp-v2.1.0`; and
* no new bare `v*` tags. Existing bare tags remain immutable legacy history and
  do not identify either current release stream.

Tags are immutable pointers to reviewed commits, never version authorities. A
platform tag must exactly match `version.json`, have all checker projections in
sync, and pass the platform, contract, and SDK release gates. A C++ tag must
exactly match the CMake version and pass the C++ ABI, test, packaging, and
build-purity gates. A platform tag does not declare a new C++ release, and a C++
tag does not release services or SDKs.

Compatibility rules follow SemVer within each stream. Once the platform is
stable, patch releases are backward-compatible fixes, minor releases add
backward-compatible behavior, and major releases may intentionally break the
public platform contract. Before `1.0.0`, incompatible changes require an
explicit changelog/API compatibility note and a new prerelease identifier.
Every tagged release-candidate commit is immutable; additional changes require
the next `rc` number. C++ compatibility is assessed independently under its
public ABI and CMake `SameMajorVersion` package contract.

## Consequences

* Version drift fails locally and in the deterministic pull-request gate before
  a tag or package can be prepared.
* Consumers can distinguish platform and C++ releases without interpreting
  inherited bare tags.
* Python's required spelling difference is derived and tested rather than
  maintained as a separate decision.
* Preparing a release requires one contract change plus reviewed projections;
  it does not authorize publishing, deployment, or a change to the other
  release stream.
