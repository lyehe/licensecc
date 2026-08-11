#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
    echo "usage: $0 <build-directory> [install-prefix] [Debug|Release]" >&2
    exit 2
fi

build_directory="$(realpath -e -- "$1")"
script_directory="$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")")"
installed_consumer_script="$script_directory/run-installed-device-identity-consumer.ps1"
if [[ ! -f "$installed_consumer_script" ]]; then
    echo "installed consumer runner is missing: $installed_consumer_script" >&2
    exit 1
fi
install_prefix="${2:-}"
configuration="${3:-Debug}"
if [[ -n "$install_prefix" ]]; then
    install_prefix="$(realpath -e -- "$install_prefix")"
fi
if [[ "$configuration" != "Debug" && "$configuration" != "Release" ]]; then
    echo "configuration must be Debug or Release: $configuration" >&2
    exit 2
fi
capability_binary="$build_directory/test/library/device_identity/device_identity_tpm2_openssl_test"
production_binary="$build_directory/test/library/device_identity/device_identity_tpm2_openssl_shim_test"
if [[ ! -x "$capability_binary" && ! -x "$production_binary" ]]; then
    echo "neither TPM2 capability nor production executable was found under: $build_directory" >&2
    exit 1
fi

key_reference_directory=""
key_reference_created=0
swtpm_pid=""
state_directory=""
cleanup() {
    local status=$?
    local validation_status=0
    local lock_name lock_path lock_mode lock_owner
    local -a key_reference_entries=()
    if [[ -n "${swtpm_pid:-}" ]] && kill -0 "$swtpm_pid" >/dev/null 2>&1; then
        kill "$swtpm_pid" >/dev/null 2>&1 || true
        wait "$swtpm_pid" >/dev/null 2>&1 || true
    fi
    if [[ "${key_reference_created:-0}" -eq 1 ]]; then
        mapfile -t key_reference_entries < <(find "$key_reference_directory" -mindepth 1 -maxdepth 1 -printf '%f\n')
        for lock_name in "${key_reference_entries[@]}"; do
            lock_path="$key_reference_directory/$lock_name"
            lock_mode="$(stat -c '%a' -- "$lock_path" 2>/dev/null || true)"
            lock_owner="$(stat -c '%u' -- "$lock_path" 2>/dev/null || true)"
            if [[ ! "$lock_name" =~ ^licensecc-v1-[0-9a-f]{64}\.tss2\.pem\.lock$ ]] ||
               [[ ! -f "$lock_path" || -L "$lock_path" ]] ||
               [[ "$lock_mode" != "600" || "$lock_owner" != "$(id -u)" ]]; then
                echo "unexpected key-reference entry; refusing cleanup: $lock_path" >&2
                validation_status=1
            fi
        done
        if [[ "$validation_status" -eq 0 ]]; then
            for lock_name in "${key_reference_entries[@]}"; do
                rm -- "$key_reference_directory/$lock_name" || status=1
            done
            if ! rmdir -- "$key_reference_directory" >/dev/null 2>&1; then
                status=1
            fi
        else
            echo "refusing to remove key-reference entries after validation failure" >&2
        fi
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

echo "key_reference_directory=$key_reference_directory"
if [[ -x "$capability_binary" ]]; then
    (
        cd -- "$key_reference_directory"
        LCC_TPM2_CAPABILITY_PREREQUISITE=1 TPM2OPENSSL_TCTI="$tcti" "$capability_binary"
    )
fi
if [[ -x "$production_binary" ]]; then
    (
        cd -- "$key_reference_directory"
        LCC_TPM2_CAPABILITY_PREREQUISITE=1 TPM2OPENSSL_TCTI="$tcti" \
            "$production_binary" --real "$key_reference_directory"
    )
    if [[ -n "$install_prefix" ]]; then
        if ! command -v pwsh >/dev/null 2>&1; then
            echo "pwsh is required for the installed TPM2 consumer gate" >&2
            exit 1
        fi
        (
            cd -- "$key_reference_directory"
            TPM2OPENSSL_TCTI="$tcti" pwsh -NoProfile -ExecutionPolicy Bypass \
                -File "$installed_consumer_script" \
                -InstallPrefix "$install_prefix" \
                -Configuration "$configuration" \
                -RequireC99 \
                -ExpectTpm2OpenSsl \
                -Tpm2StorageDirectory "$key_reference_directory" \
                -BuildTpm2OpenSslExample
        )
    fi
fi
