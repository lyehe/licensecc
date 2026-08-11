# Q&A

## Development

### Why build the library from source?

Each project has its own signing material and generated configuration. Configure
the project into a build tree or an external project directory; do not generate
keys or project material in the source checkout. See
[Build the library](../development/Build-the-library.md).

### What environments are supported?

The accepted repository contains Windows and Linux C++ sources and automated
checks, but this documentation does not claim a released binary matrix, remote
CI attestation, or Ubuntu release evidence. The platform is at **0.1.0-rc.1** (a prerelease).
Run the documented local checks with your compiler, dependencies, and target
environment before relying on a deployment.

### Is the online platform production hosted?

The repository contains implemented and automatedly tested backend, admin,
portal, backup, and SDK surfaces. ``shipped`` in the
[capability registry](../capabilities/index.rst) means that accepted-repository
state only. Deployment, Cloudflare configuration, secrets, and package
publication are separate release work.

### What should I do after updating the repository?

Keep existing project keys safe, configure a fresh build tree, and run the
current root validation commands from `AGENTS.md`. Do not clean or regenerate a
shared source checkout as part of normal validation.
