# Security policy

## Supported versions

Licensecc has not published a stable platform release. Security fixes are
developed on the `main` branch. Release candidates are prerelease software and
receive fixes on a best-effort basis until a stable support policy is
announced.

The independently versioned C++ runtime and the platform services/SDKs have
separate release streams. A tag or package is supported only when its release
notes explicitly say so; inherited legacy tags do not describe the current
platform.

This repository provides software that operators may deploy themselves. The
project does not operate or claim a hosted production service, so incidents in
a third-party deployment must also be reported to that deployment's operator.

## Report a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion,
pull request, or test fixture.

Use GitHub's private vulnerability-reporting form when it is available:

<https://github.com/lyehe/licensecc/security/advisories/new>

If the private form is unavailable, open a public issue containing only a
request for a private maintainer contact. Do not include exploit details,
credentials, customer data, license material, or affected deployment
identifiers in that issue.

Include the following in the private report when possible:

- the affected commit, tag, package version, component, and configuration;
- a minimal reproduction or proof of concept with synthetic data;
- the expected and observed security boundary;
- impact, prerequisites, and whether exploitation has been observed; and
- a safe way to contact the reporter for follow-up.

Never submit real signing keys, Cloudflare credentials, access tokens, OTPs, or
customer data. Replace them with synthetic values and state what was redacted.

## Response and disclosure

Maintainers target an acknowledgment within three business days and an initial
triage decision within seven business days. These are coordination targets,
not service-level guarantees. Remediation timing depends on severity,
reproducibility, affected release status, and the need to coordinate with
deployment operators.

Please allow maintainers a reasonable opportunity to investigate and prepare
fixes before public disclosure. The reporter and maintainers should coordinate
the disclosure date, affected-version statement, credit, and any advisory or
CVE request. Reports made in good faith to improve the project's security are
welcome.

## In scope

Security reports may cover the C/C++ runtime, Worker services, shared packages,
SDKs, release artifacts, repository-owned build/release automation, or a
cross-component trust boundary. Dependency vulnerabilities are most useful
when the report explains how Licensecc reaches the vulnerable behavior.

Availability issues that require untrusted traffic, authorization or tenant
isolation failures, token/signature validation errors, secret exposure,
replay/idempotency failures, and release-supply-chain weaknesses are all in
scope. General support requests, findings against infrastructure not operated
by this project, and scanner output without a reproducible impact should use
the normal issue tracker without including sensitive details.
