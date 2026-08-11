#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "usage: $0 <capability-build-directory>" >&2
    exit 2
fi

build_directory="$(realpath -e -- "$1")"
capability_binary="$build_directory/test/library/device_identity/device_identity_tpm2_openssl_test"
if [[ ! -x "$capability_binary" ]]; then
    echo "capability executable not found or not executable: $capability_binary" >&2
    exit 1
fi

key_reference_directory=""
key_reference_created=0
swtpm_pid=""
state_directory=""
cleanup() {
    local status=$?
    if [[ -n "${swtpm_pid:-}" ]] && kill -0 "$swtpm_pid" >/dev/null 2>&1; then
        kill "$swtpm_pid" >/dev/null 2>&1 || true
        wait "$swtpm_pid" >/dev/null 2>&1 || true
    fi
    if [[ "${key_reference_created:-0}" -eq 1 ]]; then
        rmdir -- "$key_reference_directory" >/dev/null 2>&1 || true
    fi
    if [[ -n "${state_directory:-}" ]]; then
        rm -rf -- "$state_directory"
    fi
    if [[ -n "${key_reference_directory:-}" && -e "$key_reference_directory" ]]; then
        echo "key-reference cleanup failed: $key_reference_directory" >&2
        status=1
    fi
    if [[ -n "${state_directory:-}" && -e "$state_directory" ]]; then
        echo "swtpm state cleanup failed: $state_directory" >&2
        status=1
    fi
    exit "$status"
}
trap cleanup EXIT

for command_name in swtpm tpm2_getcap tpm2_startup openssl python3 dpkg-query; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "required TPM2 simulator command is missing: $command_name" >&2
        exit 1
    fi
done

if ! dpkg-query -W -f='${Status}\n' tpm2-openssl 2>/dev/null | grep -q '^install ok installed$'; then
    echo "the distro tpm2-openssl package is not installed" >&2
    exit 1
fi

echo "tpm2-openssl: $(dpkg-query -W -f='${Version}' tpm2-openssl)"
echo "tpm2-tss: $(dpkg-query -W -f='${Version}' libtss2-esys-3.0.2 2>/dev/null || true)"
openssl version -a

key_reference_directory="$build_directory/tpm2-capability-keyrefs"
if [[ -e "$key_reference_directory" || -L "$key_reference_directory" ]]; then
    echo "refusing to reuse an existing capability key-reference directory: $key_reference_directory" >&2
    exit 1
fi
mkdir -- "$key_reference_directory"
chmod 700 -- "$key_reference_directory"
key_reference_created=1
effective_uid="$(id -u)"
ancestor="$key_reference_directory"
while [[ "$ancestor" != "/" ]]; do
    if [[ -L "$ancestor" ]]; then
        echo "key-reference ancestor is a symlink: $ancestor" >&2
        exit 1
    fi
    mode="$(stat -c '%a' -- "$ancestor")"
    mode="${mode: -3}"
    mode_value=$((8#$mode))
    if (( (mode_value & 18) != 0 )); then
        echo "key-reference ancestor is group/world writable: $ancestor" >&2
        exit 1
    fi
    ancestor="$(dirname -- "$ancestor")"
done
if [[ "$(stat -c '%u' -- "$key_reference_directory")" != "$effective_uid" ||
      "$(stat -c '%a' -- "$key_reference_directory")" != "700" ]]; then
    echo "key-reference directory ownership/mode validation failed" >&2
    exit 1
fi

state_directory="$(mktemp -d "${TMPDIR:-/tmp}/licensecc-swtpm.XXXXXX")"

log_file="$state_directory/swtpm.log"
port="$(python3 - <<'PY'
import socket

for _ in range(100):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as command_probe:
        command_probe.bind(("127.0.0.1", 0))
        candidate = command_probe.getsockname()[1]
        if candidate >= 65535:
            continue
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as control_probe:
                control_probe.bind(("127.0.0.1", candidate + 1))
        except OSError:
            continue
        print(candidate)
        break
else:
    raise SystemExit("no adjacent loopback ports available for swtpm")
PY
)"
control_port="$((port + 1))"
tcti="swtpm:host=127.0.0.1,port=$port"

swtpm socket \
    --tpm2 \
    --tpmstate "dir=$state_directory" \
    --ctrl "type=tcp,port=$control_port" \
    --server "type=tcp,port=$port" \
    --flags not-need-init \
    >"$log_file" 2>&1 &
swtpm_pid=$!

ready=0
for _ in $(seq 1 100); do
    if tpm2_startup -T "$tcti" -c >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "$swtpm_pid" >/dev/null 2>&1; then
        cat "$log_file" >&2
        echo "swtpm exited before becoming ready" >&2
        exit 1
    fi
    sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
    cat "$log_file" >&2
    echo "swtpm did not become ready" >&2
    exit 1
fi
if ! tpm2_getcap -T "$tcti" properties-fixed >/dev/null; then
    echo "initialized swtpm did not expose fixed properties" >&2
    exit 1
fi

echo "swtpm_tcti=$tcti"
echo "key_reference_directory=$key_reference_directory"
(
    cd -- "$key_reference_directory"
    LCC_TPM2_CAPABILITY_PREREQUISITE=1 TPM2OPENSSL_TCTI="$tcti" "$capability_binary"
)
