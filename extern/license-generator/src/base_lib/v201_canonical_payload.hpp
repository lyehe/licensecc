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
// can never appear in a v201 licence, so every project-creation path in this
// vendored generator (the `Project` class, its CLI) must reuse this exact
// function rather than keep its own, divergent copy of the rule. This is the
// generator's own copy of the check; the core runtime keeps a separate copy
// for verification at src/library/base/v201_canonical_payload.cpp, which is
// unaffected by and does not need to change for this.
bool valid_project_name(const std::string& value);

}  // namespace v201
}  // namespace license

#endif
