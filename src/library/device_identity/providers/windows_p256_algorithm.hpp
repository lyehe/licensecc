#ifndef LICENSECC_WINDOWS_P256_ALGORITHM_HPP_
#define LICENSECC_WINDOWS_P256_ALGORITHM_HPP_

#include <windows.h>
#include <ncrypt.h>

#include <array>
#include <cstring>

namespace license {
namespace device_identity {

// Platform KSP may report ECDSA for a P-256 key. This checks only the exact
// terminated property label; the provider must still validate the public blob,
// curve point and creation signing self-test before accepting the key.
inline bool is_windows_p256_algorithm(const std::array<wchar_t, 64>& value, DWORD written) noexcept {
	const bool named_p256 =
		written == sizeof(NCRYPT_ECDSA_P256_ALGORITHM) &&
		std::memcmp(value.data(), NCRYPT_ECDSA_P256_ALGORITHM, sizeof(NCRYPT_ECDSA_P256_ALGORITHM)) == 0;
	const bool generic_ecdsa = written == sizeof(NCRYPT_ECDSA_ALGORITHM) &&
							   std::memcmp(value.data(), NCRYPT_ECDSA_ALGORITHM, sizeof(NCRYPT_ECDSA_ALGORITHM)) == 0;
	return named_p256 || generic_ecdsa;
}

}  // namespace device_identity
}  // namespace license

#endif
