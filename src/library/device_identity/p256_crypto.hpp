#ifndef LICENSECC_DEVICE_IDENTITY_P256_CRYPTO_HPP_
#define LICENSECC_DEVICE_IDENTITY_P256_CRYPTO_HPP_

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace license {
namespace device_identity {

using P256Digest = std::array<std::uint8_t, 32>;
using P256Signature = std::array<std::uint8_t, 64>;
using P256Spki = std::array<std::uint8_t, 91>;

void secure_zero(void* data, std::size_t size) noexcept;

template <std::size_t N>
class SensitiveArray {
public:
	SensitiveArray() = default;
	~SensitiveArray() { clear(); }

	SensitiveArray(const SensitiveArray&) = delete;
	SensitiveArray& operator=(const SensitiveArray&) = delete;
	SensitiveArray(SensitiveArray&&) = delete;
	SensitiveArray& operator=(SensitiveArray&&) = delete;

	void clear() noexcept { secure_zero(value.data(), value.size()); }

	std::array<std::uint8_t, N> value{};
};

class SensitiveVector {
public:
	SensitiveVector() = default;
	explicit SensitiveVector(std::size_t size) : value(size) {}
	~SensitiveVector() { clear(); }

	SensitiveVector(const SensitiveVector&) = delete;
	SensitiveVector& operator=(const SensitiveVector&) = delete;
	SensitiveVector(SensitiveVector&&) = delete;
	SensitiveVector& operator=(SensitiveVector&&) = delete;

	void clear() noexcept { secure_zero(value.data(), value.size()); }

	std::vector<std::uint8_t> value;
};

bool sha256(const std::uint8_t* data, std::size_t size, P256Digest& out) noexcept;
bool canonicalize_p256_spki(const std::uint8_t* encoded, std::size_t size, P256Spki& out) noexcept;
bool verify_p256_p1363(const P256Spki& spki, const P256Digest& digest, const P256Signature& signature) noexcept;
bool verify_p256_p1363(const P256Spki& spki, const P256Digest& digest, const std::uint8_t* signature,
					   std::size_t signature_size) noexcept;
std::string device_key_id(const P256Spki& spki) noexcept;

bool der_signature_to_p1363(const std::uint8_t* der, std::size_t size, P256Signature& out) noexcept;
bool p1363_signature_to_der(const P256Signature& signature, std::vector<std::uint8_t>& out) noexcept;
bool p1363_signature_in_range(const P256Signature& signature) noexcept;

std::string encode_canonical_base64(const std::uint8_t* data, std::size_t size) noexcept;
bool decode_canonical_base64(const std::string& encoded, std::vector<std::uint8_t>& out) noexcept;
std::string lowercase_hex(const std::uint8_t* data, std::size_t size) noexcept;
bool parse_lowercase_hex(const std::string& encoded, std::vector<std::uint8_t>& out) noexcept;

namespace detail {
bool platform_validate_p256_spki(const P256Spki& spki) noexcept;
bool platform_verify_p256_p1363(const P256Spki& spki, const P256Digest& digest,
								const P256Signature& signature) noexcept;
}  // namespace detail

}  // namespace device_identity
}  // namespace license

#endif
