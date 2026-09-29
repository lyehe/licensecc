#ifndef LCCGEN_V201_CANONICAL_PAYLOAD_HPP
#define LCCGEN_V201_CANONICAL_PAYLOAD_HPP

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

// The exact rule the signed "project" canonical-payload field requires: an
// ASCII alpha/underscore start, then only ASCII alnum/underscore, within the
// generic canonical field value length limit. A project name that fails this
// can never appear in a v201 licence, so any project-creation path (the
// generator's `Project` class, its CLI) must reuse this rule rather than a
// second, divergent copy of it.
bool valid_project_name(const std::string& value);

}  // namespace v201
}  // namespace license

#endif
