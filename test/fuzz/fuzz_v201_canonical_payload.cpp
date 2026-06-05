#include <cstddef>
#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

#include "../../src/library/base/v201_canonical_payload.hpp"

namespace {

std::vector<license::v201::CanonicalField> parse_fields(const std::string &input) {
	std::vector<license::v201::CanonicalField> fields;
	std::istringstream stream(input);
	std::string line;
	while (fields.size() < 64 && std::getline(stream, line)) {
		const size_t separator = line.find('=');
		if (separator == std::string::npos) {
			fields.push_back({line, ""});
		} else {
			fields.push_back({line.substr(0, separator), line.substr(separator + 1)});
		}
	}
	return fields;
}

std::vector<license::v201::CanonicalField> valid_required_fields() {
	return {
		{"lic_ver", "201"},
		{"canonical-v", "1"},
		{"sig-v", "1"},
		{"sig-alg", "rsa-pkcs1-sha256"},
		{"key-id", "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
		{"project", LCC_FUZZ_PROJECT_NAME},
		{"feature", "FUZZ_FEATURE"},
	};
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
	if (size > 16384) {
		return 0;
	}
	const std::string input(reinterpret_cast<const char *>(data), size);

	(void)license::v201::build_canonical_payload(parse_fields(input));

	std::vector<license::v201::CanonicalField> fields = valid_required_fields();
	const std::vector<license::v201::CanonicalField> parsed = parse_fields(input);
	fields.insert(fields.end(), parsed.begin(), parsed.end());
	const license::v201::CanonicalPayloadResult result = license::v201::build_canonical_payload(fields);
	if (result.ok) {
		(void)license::v201::canonical_payload_hex(result.bytes);
	}

	return 0;
}
