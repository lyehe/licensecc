#include "p256_crypto.hpp"

#include <algorithm>
#include <array>
#include <cstring>

#ifdef _WIN32
#include <windows.h>
#endif

namespace license {
namespace device_identity {
namespace {

constexpr std::array<std::uint8_t, 27> kP256SpkiPrefix = {{
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
    0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04}};
constexpr std::array<std::uint8_t, 32> kP256Order = {{
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51}};
constexpr char kBase64Alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

bool scalar_in_range(const std::uint8_t* scalar) {
    bool nonzero = false;
    for (std::size_t index = 0; index < 32U; ++index) {
        nonzero = nonzero || scalar[index] != 0U;
    }
    if (!nonzero) {
        return false;
    }
    return std::lexicographical_compare(scalar, scalar + 32U, kP256Order.begin(), kP256Order.end());
}

int decode_base64_character(unsigned char ch) {
    if (ch >= 'A' && ch <= 'Z') {
        return ch - 'A';
    }
    if (ch >= 'a' && ch <= 'z') {
        return ch - 'a' + 26;
    }
    if (ch >= '0' && ch <= '9') {
        return ch - '0' + 52;
    }
    if (ch == '+') {
        return 62;
    }
    if (ch == '/') {
        return 63;
    }
    return -1;
}

bool read_der_integer(const std::uint8_t* der,
                      std::size_t size,
                      std::size_t& offset,
                      const std::uint8_t*& magnitude,
                      std::size_t& magnitude_size) {
    if (offset + 2U > size || der[offset++] != 0x02U) {
        return false;
    }
    const std::size_t encoded_size = der[offset++];
    if (encoded_size == 0U || encoded_size >= 0x80U || offset + encoded_size > size) {
        return false;
    }
    const std::uint8_t* value = der + offset;
    offset += encoded_size;
    if ((value[0] & 0x80U) != 0U) {
        return false;
    }
    if (value[0] == 0U) {
        if (encoded_size == 1U || (value[1] & 0x80U) == 0U) {
            return false;
        }
        ++value;
        magnitude_size = encoded_size - 1U;
    } else {
        magnitude_size = encoded_size;
    }
    if (magnitude_size == 0U || magnitude_size > 32U) {
        return false;
    }
    magnitude = value;
    return true;
}

void append_der_integer(std::vector<std::uint8_t>& output, const std::uint8_t* scalar) {
    std::size_t first = 0U;
    while (first < 31U && scalar[first] == 0U) {
        ++first;
    }
    const std::size_t magnitude_size = 32U - first;
    const bool protect_sign = (scalar[first] & 0x80U) != 0U;
    output.push_back(0x02U);
    output.push_back(static_cast<std::uint8_t>(magnitude_size + (protect_sign ? 1U : 0U)));
    if (protect_sign) {
        output.push_back(0U);
    }
    output.insert(output.end(), scalar + first, scalar + 32U);
}

}  // namespace

bool canonicalize_p256_spki(const std::uint8_t* encoded, std::size_t size, P256Spki& out) noexcept {
    if (encoded == nullptr || size != out.size() ||
        !std::equal(kP256SpkiPrefix.begin(), kP256SpkiPrefix.end(), encoded)) {
        return false;
    }
    P256Spki candidate{};
    std::copy(encoded, encoded + size, candidate.begin());
    if (!detail::platform_validate_p256_spki(candidate)) {
        return false;
    }
    out = candidate;
    return true;
}

bool p1363_signature_in_range(const P256Signature& signature) noexcept {
    return scalar_in_range(signature.data()) && scalar_in_range(signature.data() + 32U);
}

bool verify_p256_p1363(const P256Spki& spki,
                       const P256Digest& digest,
                       const P256Signature& signature) noexcept {
    return verify_p256_p1363(spki, digest, signature.data(), signature.size());
}

bool verify_p256_p1363(const P256Spki& spki,
                       const P256Digest& digest,
                       const std::uint8_t* signature,
                       std::size_t signature_size) noexcept {
    if (signature == nullptr || signature_size != P256Signature{}.size()) {
        return false;
    }
    SensitiveArray<64> candidate;
    std::copy(signature, signature + signature_size, candidate.value.begin());
    return p1363_signature_in_range(candidate.value) && detail::platform_validate_p256_spki(spki) &&
           detail::platform_verify_p256_p1363(spki, digest, candidate.value);
}

std::string device_key_id(const P256Spki& spki) noexcept {
    try {
        if (!detail::platform_validate_p256_spki(spki)) {
            return {};
        }
        SensitiveArray<32> digest;
        if (!sha256(spki.data(), spki.size(), digest.value)) {
            return {};
        }
        std::string result = "sha256:" + lowercase_hex(digest.value.data(), digest.value.size());
        return result.size() == 71U ? result : std::string();
    } catch (...) {
        return {};
    }
}

bool der_signature_to_p1363(const std::uint8_t* der,
                            std::size_t size,
                            P256Signature& out) noexcept {
    if (der == nullptr || size < 8U || size > 72U || der[0] != 0x30U || der[1] >= 0x80U ||
        static_cast<std::size_t>(der[1]) + 2U != size) {
        return false;
    }
    std::size_t offset = 2U;
    const std::uint8_t* r = nullptr;
    const std::uint8_t* s = nullptr;
    std::size_t r_size = 0U;
    std::size_t s_size = 0U;
    if (!read_der_integer(der, size, offset, r, r_size) || !read_der_integer(der, size, offset, s, s_size) ||
        offset != size) {
        return false;
    }
    SensitiveArray<64> candidate;
    std::copy(r, r + r_size, candidate.value.begin() + (32U - r_size));
    std::copy(s, s + s_size, candidate.value.begin() + 32U + (32U - s_size));
    if (!p1363_signature_in_range(candidate.value)) {
        return false;
    }
    out = candidate.value;
    return true;
}

bool p1363_signature_to_der(const P256Signature& signature, std::vector<std::uint8_t>& out) noexcept {
    try {
        if (!p1363_signature_in_range(signature)) {
            return false;
        }
        SensitiveVector body;
        body.value.reserve(70U);
        append_der_integer(body.value, signature.data());
        append_der_integer(body.value, signature.data() + 32U);
        SensitiveVector candidate;
        candidate.value.reserve(body.value.size() + 2U);
        candidate.value.push_back(0x30U);
        candidate.value.push_back(static_cast<std::uint8_t>(body.value.size()));
        candidate.value.insert(candidate.value.end(), body.value.begin(), body.value.end());
        out.swap(candidate.value);
        return true;
    } catch (...) {
        return false;
    }
}

std::string encode_canonical_base64(const std::uint8_t* data, std::size_t size) noexcept {
    try {
        if (data == nullptr && size != 0U) {
            return {};
        }
        std::string output;
        output.reserve(((size + 2U) / 3U) * 4U);
        for (std::size_t offset = 0U; offset < size; offset += 3U) {
            const std::uint32_t a = data[offset];
            const std::uint32_t b = offset + 1U < size ? data[offset + 1U] : 0U;
            const std::uint32_t c = offset + 2U < size ? data[offset + 2U] : 0U;
            const std::uint32_t word = (a << 16U) | (b << 8U) | c;
            output.push_back(kBase64Alphabet[(word >> 18U) & 0x3fU]);
            output.push_back(kBase64Alphabet[(word >> 12U) & 0x3fU]);
            output.push_back(offset + 1U < size ? kBase64Alphabet[(word >> 6U) & 0x3fU] : '=');
            output.push_back(offset + 2U < size ? kBase64Alphabet[word & 0x3fU] : '=');
        }
        return output;
    } catch (...) {
        return {};
    }
}

bool decode_canonical_base64(const std::string& encoded, std::vector<std::uint8_t>& out) noexcept {
    try {
        if (encoded.empty() || encoded.size() % 4U != 0U) {
            return false;
        }
        std::vector<std::uint8_t> candidate;
        candidate.reserve(encoded.size() / 4U * 3U);
        for (std::size_t offset = 0U; offset < encoded.size(); offset += 4U) {
            const bool last = offset + 4U == encoded.size();
            const int a = decode_base64_character(static_cast<unsigned char>(encoded[offset]));
            const int b = decode_base64_character(static_cast<unsigned char>(encoded[offset + 1U]));
            const int c = encoded[offset + 2U] == '=' ? -2 :
                                                               decode_base64_character(static_cast<unsigned char>(encoded[offset + 2U]));
            const int d = encoded[offset + 3U] == '=' ? -2 :
                                                               decode_base64_character(static_cast<unsigned char>(encoded[offset + 3U]));
            if (a < 0 || b < 0 || c == -1 || d == -1 || (!last && (c == -2 || d == -2)) ||
                (c == -2 && d != -2)) {
                return false;
            }
            const std::uint32_t word = (static_cast<std::uint32_t>(a) << 18U) |
                                       (static_cast<std::uint32_t>(b) << 12U) |
                                       (static_cast<std::uint32_t>(c < 0 ? 0 : c) << 6U) |
                                       static_cast<std::uint32_t>(d < 0 ? 0 : d);
            candidate.push_back(static_cast<std::uint8_t>(word >> 16U));
            if (c >= 0) {
                candidate.push_back(static_cast<std::uint8_t>(word >> 8U));
            }
            if (d >= 0) {
                candidate.push_back(static_cast<std::uint8_t>(word));
            }
        }
        if (encode_canonical_base64(candidate.data(), candidate.size()) != encoded) {
            return false;
        }
        out.swap(candidate);
        return true;
    } catch (...) {
        return false;
    }
}

std::string lowercase_hex(const std::uint8_t* data, std::size_t size) noexcept {
    constexpr char alphabet[] = "0123456789abcdef";
    try {
        if (data == nullptr && size != 0U) {
            return {};
        }
        std::string output(size * 2U, '0');
        for (std::size_t index = 0U; index < size; ++index) {
            output[index * 2U] = alphabet[data[index] >> 4U];
            output[index * 2U + 1U] = alphabet[data[index] & 0x0fU];
        }
        return output;
    } catch (...) {
        return {};
    }
}

bool parse_lowercase_hex(const std::string& encoded, std::vector<std::uint8_t>& out) noexcept {
    try {
        if (encoded.empty() || encoded.size() % 2U != 0U) {
            return false;
        }
        std::vector<std::uint8_t> candidate(encoded.size() / 2U);
        for (std::size_t index = 0U; index < candidate.size(); ++index) {
            const auto decode = [](unsigned char ch) -> int {
                if (ch >= '0' && ch <= '9') {
                    return ch - '0';
                }
                if (ch >= 'a' && ch <= 'f') {
                    return ch - 'a' + 10;
                }
                return -1;
            };
            const int high = decode(static_cast<unsigned char>(encoded[index * 2U]));
            const int low = decode(static_cast<unsigned char>(encoded[index * 2U + 1U]));
            if (high < 0 || low < 0) {
                return false;
            }
            candidate[index] = static_cast<std::uint8_t>((high << 4U) | low);
        }
        out.swap(candidate);
        return true;
    } catch (...) {
        return false;
    }
}

void secure_zero(void* data, std::size_t size) noexcept {
    if (data == nullptr) {
        return;
    }
#ifdef _WIN32
    SecureZeroMemory(data, size);
#else
    volatile std::uint8_t* cursor = static_cast<volatile std::uint8_t*>(data);
    while (size-- > 0U) {
        *cursor++ = 0U;
    }
#endif
}

}  // namespace device_identity
}  // namespace license
