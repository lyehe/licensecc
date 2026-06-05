#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../../src/library/base/base64.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
	if (size > 65536) {
		return 0;
	}
	const std::string input(reinterpret_cast<const char *>(data), size);

	const std::vector<uint8_t> decoded = license::unbase64(input);
	(void)license::is_canonical_base64(input, true);
	(void)license::is_canonical_base64(input, false);

	if (!decoded.empty()) {
		const std::string encoded = license::base64(decoded.data(), decoded.size(), 0);
		(void)license::unbase64(encoded);
	}

	return 0;
}
