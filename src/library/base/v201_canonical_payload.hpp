#ifndef LCC_V201_CANONICAL_PAYLOAD_HPP
#define LCC_V201_CANONICAL_PAYLOAD_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace license {
namespace v201 {

struct CanonicalField {
	std::string key;
	std::string value;
};

struct CanonicalPayloadResult {
	bool ok = false;
	std::string error;
	std::vector<uint8_t> bytes;
};

CanonicalPayloadResult build_canonical_payload(const std::vector<CanonicalField>& fields);
std::string canonical_payload_hex(const std::vector<uint8_t>& bytes);

}  // namespace v201
}  // namespace license

#endif
