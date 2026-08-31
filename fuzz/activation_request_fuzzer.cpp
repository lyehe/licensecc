#include "activation/ActivationRequest.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace {

constexpr std::size_t kMaxInputSize = 16U * 1024U;

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, const std::size_t size) {
	if (data == nullptr || size == 0 || size > kMaxInputSize) {
		return 0;
	}

	const std::string input(reinterpret_cast<const char*>(data), size);
	license::activation::ActivationRequestFields fields;
	std::string error;
	(void)license::activation::parse_activation_request(input, fields, error);
	// Text corpus files conventionally end in a newline, while the envelope does
	// not. Exercise the exact checked-in canonical seed as a second derived input
	// without weakening the parser's direct handling of the original bytes.
	if (input.back() == '\n') {
		(void)license::activation::parse_activation_request(input.substr(0, input.size() - 1), fields, error);
	}
	return 0;
}
