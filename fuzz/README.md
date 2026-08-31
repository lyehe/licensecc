# Native parser fuzz smoke

This opt-in tree contains Clang libFuzzer harnesses for the untrusted
activation-request and online-assertion parsing boundaries. Each harness
rejects inputs larger than 16 KiB before constructing parser state. CI also
passes libFuzzer's `-max_len=16384`, a short `-max_total_time`, and an outer
process timeout.

The checked-in seeds are synthetic protocol-shaped data. They contain no
production keys, licenses, identifiers, credentials, or network endpoints.
Normal presets do not build this tree; use the `ci-linux-sanitizers` configure,
build, and test presets on Linux with Clang.
