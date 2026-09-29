# License Generator

[![Standard](https://img.shields.io/badge/c%2B%2B-11-blue.svg)](https://en.wikipedia.org/wiki/C%2B%2B#Standardization)
[![experimental](http://badges.github.io/stability-badges/dist/experimental.svg)](http://github.com/badges/stability-badges)[![License](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Build Status](https://travis-ci.org/open-license-manager/lcc-license-generator.svg?branch=develop)](https://travis-ci.org/open-license-manager/lcc-license-generator)
[![Codacy Badge](https://api.codacy.com/project/badge/Grade/b1474db812744cac837aadc191e710c7)](https://www.codacy.com/manual/gcontini/lcc-license-generator?utm_source=github.com&amp;utm_medium=referral&amp;utm_content=open-license-manager/lcc-license-generator&amp;utm_campaign=Badge_Grade)
[![codecov](https://codecov.io/gh/open-license-manager/lcc-license-generator/branch/develop/graph/badge.svg)](https://codecov.io/gh/open-license-manager/lcc-license-generator)

License generator for open-license-manager allow to create new projects (and their public and private keys) and issue licenses. 
This code is intended to be used as a submodule of open-license-manager project. 
All the documentation is in the main project.

`lccgen` never overwrites or silently rotates an existing private key. License
issuance always emits the v201 format and refuses to sign with a project key
below 3072 bits: `lccgen project init` only ever generates a 3072-bit or
4096-bit key, and `license issue` fails closed if the project's private key is
weaker than that. There is no automated key-rotation command; create a new
project with `lccgen project init` and reissue licenses from it.

## Project names

A project name must start with an ASCII letter or `_`, and contain only ASCII
letters, digits, and `_` after that. This is the same rule the v201 license
format's signed `project` field requires (`license::v201::valid_project_name`);
`lccgen project init` refuses any other name, including one with a `-` or a
`.`, so that it never creates a project that can never issue a license.

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
