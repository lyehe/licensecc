# License Generator

[![Standard](https://img.shields.io/badge/c%2B%2B-11-blue.svg)](https://en.wikipedia.org/wiki/C%2B%2B#Standardization)
[![experimental](http://badges.github.io/stability-badges/dist/experimental.svg)](http://github.com/badges/stability-badges)[![License](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Build Status](https://travis-ci.org/open-license-manager/lcc-license-generator.svg?branch=develop)](https://travis-ci.org/open-license-manager/lcc-license-generator)
[![Codacy Badge](https://api.codacy.com/project/badge/Grade/b1474db812744cac837aadc191e710c7)](https://www.codacy.com/manual/gcontini/lcc-license-generator?utm_source=github.com&amp;utm_medium=referral&amp;utm_content=open-license-manager/lcc-license-generator&amp;utm_campaign=Badge_Grade)
[![codecov](https://codecov.io/gh/open-license-manager/lcc-license-generator/branch/develop/graph/badge.svg)](https://codecov.io/gh/open-license-manager/lcc-license-generator)

License generator for open-license-manager allow to create new projects (and their public and private keys) and issue licenses. 
This code is intended to be used as a submodule of open-license-manager project. 
All the documentation is in the main project.

## Weak RSA-key migration

`lccgen` never overwrites or silently rotates an existing private key. v201
issuance refuses project keys below 3072 bits; legacy v200 issuance remains
available only for compatibility with existing deployments.

To inspect a legacy project and receive the exact fail-closed migration
procedure, run:

```text
lccgen project migrate-weak-key --project-folder <existing-project-folder>
```

For a weak key this command makes no changes. First make a restorable copy of
the entire existing project before changing deployment. For example:

```text
# PowerShell
Copy-Item -LiteralPath 'C:\\projects\\legacy-product' -Destination 'C:\\projects\\legacy-product.pre-v201-backup' -Recurse

# POSIX shell
cp -a /srv/projects/legacy-product /srv/projects/legacy-product.pre-v201-backup
```

Then create a **new** 3072-bit project in a separate folder, deploy its
`public_key.h`, and reissue v201 licenses. Keep the old project backup for any
legacy verification/transition needs; do not replace its private key in place.

## Private-key file ownership

`lccgen project init` creates a signing key for the identity that runs the
command. On Windows, the generator creates and verifies a protected DACL that
grants only that current process user access; on POSIX the key is owner
read/write only. Run initialization as the final signing service account.

If an administrator must hand a generated key to a different service account,
first make and verify a restorable project backup, then perform an explicit,
audited operating-system ACL ownership handoff after generation. The generator
does not broaden a key ACL automatically and refuses publication when it cannot
verify that the filesystem enforces the private-key ACL. Do not use a shared
project directory as a substitute for that explicit handoff.
