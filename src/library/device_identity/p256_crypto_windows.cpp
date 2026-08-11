#include "p256_crypto.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <climits>
#include <cstring>
#include <vector>

namespace license {
namespace device_identity {
namespace {

#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

class AlgorithmHandle {
public:
    ~AlgorithmHandle() {
        if (value != nullptr) {
            BCryptCloseAlgorithmProvider(value, 0);
        }
    }
    BCRYPT_ALG_HANDLE value = nullptr;
};

class HashHandle {
public:
    ~HashHandle() {
        if (value != nullptr) {
            BCryptDestroyHash(value);
        }
    }
    BCRYPT_HASH_HANDLE value = nullptr;
};

class KeyHandle {
public:
    ~KeyHandle() {
        if (value != nullptr) {
            BCryptDestroyKey(value);
        }
    }
    BCRYPT_KEY_HANDLE value = nullptr;
};

bool import_public_key(BCRYPT_ALG_HANDLE algorithm, const P256Spki& spki, KeyHandle& key) {
    SensitiveVector blob(sizeof(BCRYPT_ECCKEY_BLOB) + 64U);
    BCRYPT_ECCKEY_BLOB header{};
    header.dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
    header.cbKey = 32U;
    std::memcpy(blob.value.data(), &header, sizeof(header));
    std::copy(spki.begin() + 27U, spki.end(), blob.value.begin() + sizeof(header));
    return NT_SUCCESS(BCryptImportKeyPair(algorithm, nullptr, BCRYPT_ECCPUBLIC_BLOB, &key.value,
                                          blob.value.data(), static_cast<ULONG>(blob.value.size()), 0));
}

}  // namespace

bool sha256(const std::uint8_t* data, std::size_t size, P256Digest& out) noexcept {
    try {
        if ((data == nullptr && size != 0U) || size > ULONG_MAX) {
            return false;
        }
        AlgorithmHandle algorithm;
        if (!NT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
            return false;
        }
        DWORD object_size = 0U;
        DWORD hash_size = 0U;
        DWORD written = 0U;
        if (!NT_SUCCESS(BCryptGetProperty(algorithm.value, BCRYPT_OBJECT_LENGTH,
                                          reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &written, 0)) ||
            !NT_SUCCESS(BCryptGetProperty(algorithm.value, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_size),
                                          sizeof(hash_size), &written, 0)) ||
            hash_size != out.size()) {
            return false;
        }
        SensitiveVector object(object_size);
        HashHandle hash;
        if (!NT_SUCCESS(BCryptCreateHash(
                algorithm.value, &hash.value, object.value.data(), object_size, nullptr, 0U, 0))) {
            return false;
        }
        if (size != 0U && !NT_SUCCESS(BCryptHashData(hash.value, const_cast<PUCHAR>(data), static_cast<ULONG>(size), 0))) {
            return false;
        }
        SensitiveArray<32> candidate;
        if (!NT_SUCCESS(BCryptFinishHash(
                hash.value, candidate.value.data(), static_cast<ULONG>(candidate.value.size()), 0))) {
            return false;
        }
        out = candidate.value;
        return true;
    } catch (...) {
        return false;
    }
}

namespace detail {

bool platform_validate_p256_spki(const P256Spki& spki) noexcept {
    try {
        AlgorithmHandle algorithm;
        if (!NT_SUCCESS(
                BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0))) {
            return false;
        }
        KeyHandle key;
        return import_public_key(algorithm.value, spki, key);
    } catch (...) {
        return false;
    }
}

bool platform_verify_p256_p1363(const P256Spki& spki,
                                const P256Digest& digest,
                                const P256Signature& signature) noexcept {
    try {
        AlgorithmHandle algorithm;
        if (!NT_SUCCESS(
                BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0))) {
            return false;
        }
        KeyHandle key;
        if (!import_public_key(algorithm.value, spki, key)) {
            return false;
        }
        return NT_SUCCESS(BCryptVerifySignature(key.value, nullptr, const_cast<PUCHAR>(digest.data()),
                                                static_cast<ULONG>(digest.size()),
                                                const_cast<PUCHAR>(signature.data()),
                                                static_cast<ULONG>(signature.size()), 0));
    } catch (...) {
        return false;
    }
}

}  // namespace detail
}  // namespace device_identity
}  // namespace license
