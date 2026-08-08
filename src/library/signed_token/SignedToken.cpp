#include "SignedToken.hpp"

#include <cstdint>
#include <ctime>

#include "../base/base64.h"
#include "../os/os.h"
#include "../os/signature_verifier.hpp"

namespace license {
namespace signed_token {

uint64_t now_epoch_seconds() {
	return static_cast<uint64_t>(time(nullptr));
}

bool value_has_line_breaks_or_equals(const std::string& value) {
	return value.find('\n') != std::string::npos || value.find('\r') != std::string::npos ||
		   value.find('=') != std::string::npos;
}

bool append_claim_line(std::ostringstream& out, const char* key, const std::string& value) {
	if (value_has_line_breaks_or_equals(value)) {
		return false;
	}
	out << key << '=' << value << '\n';
	return true;
}

bool append_uint_claim_line(std::ostringstream& out, const char* key, const uint64_t value) {
	out << key << '=' << value << '\n';
	return true;
}

bool parse_uint64(const std::string& value, uint64_t& out) {
	if (value.empty()) {
		return false;
	}
	uint64_t result = 0;
	for (const unsigned char ch : value) {
		if (ch < '0' || ch > '9') {
			return false;
		}
		const uint64_t digit = static_cast<uint64_t>(ch - '0');
		if (result > (UINT64_MAX - digit) / 10U) {
			return false;
		}
		result = result * 10U + digit;
	}
	out = result;
	return true;
}

bool extract_preverify_field(const std::string& payload, const char* key, std::string& out) {
	const std::string prefix = std::string(key) + "=";
	size_t pos = 0;
	while (pos < payload.size()) {
		const size_t next = payload.find('\n', pos);
		if (next == std::string::npos) {
			return false;
		}
		const std::string line = payload.substr(pos, next - pos);
		if (line.find(prefix) == 0) {
			out = line.substr(prefix.size());
			return !out.empty();
		}
		pos = next + 1;
	}
	return false;
}

bool split_envelope(const std::string& token, const char* expected_prefix, const char* error_noun,
					std::string& payload_b64, std::string& signature_b64, std::string& error) {
	const std::string noun(error_noun);
	const size_t first_dot = token.find('.');
	if (first_dot == std::string::npos) {
		error = noun + " missing payload";
		return false;
	}
	const size_t second_dot = token.find('.', first_dot + 1);
	if (second_dot == std::string::npos || token.find('.', second_dot + 1) != std::string::npos) {
		error = noun + " envelope malformed";
		return false;
	}
	if (token.substr(0, first_dot) != expected_prefix) {
		error = noun + " prefix mismatch";
		return false;
	}
	payload_b64 = token.substr(first_dot + 1, second_dot - first_dot - 1);
	signature_b64 = token.substr(second_dot + 1);
	if (!license::is_canonical_base64(payload_b64, false) || !license::is_canonical_base64(signature_b64, false)) {
		error = noun + " base64 is not canonical";
		return false;
	}
	return true;
}

std::string build_envelope(const char* prefix, const std::string& payload, const std::string& signature_base64) {
	const std::string payload_b64 = license::base64(payload.data(), payload.size(), 0);
	return std::string(prefix) + "." + payload_b64 + "." + signature_base64;
}

bool parse_fields_in_order(const std::string& payload, const FieldSpec* fields, const size_t field_count,
						   const char* error_noun, const bool validate_values, std::string& error) {
	const std::string noun(error_noun);
	size_t pos = 0;
	for (size_t i = 0; i < field_count; ++i) {
		const FieldSpec& field = fields[i];
		const size_t next = payload.find('\n', pos);
		if (next == std::string::npos) {
			error = noun + " missing field " + field.key;
			return false;
		}
		const std::string line = payload.substr(pos, next - pos);
		const std::string prefix = std::string(field.key) + "=";
		if (line.find(prefix) != 0) {
			error = noun + " expected field " + field.key;
			return false;
		}
		*field.value = line.substr(prefix.size());
		if (validate_values && value_has_line_breaks_or_equals(*field.value)) {
			error = noun + " invalid value for " + field.key;
			return false;
		}
		pos = next + 1;
	}
	if (pos != payload.size()) {
		error = noun + " has unknown trailing fields";
		return false;
	}
	return true;
}

bool verify_payload_signature(const std::vector<uint8_t>& payload, const std::vector<uint8_t>& signature,
							  const std::string& payload_text, const unsigned int license_version,
							  const license::os::SignatureVerificationPolicy& policy, const char* error_noun,
							  std::string& error) {
	const std::string noun(error_noun);
	std::string algorithm;
	std::string key_id;
	if (!extract_preverify_field(payload_text, "alg", algorithm) ||
		!extract_preverify_field(payload_text, "key-id", key_id)) {
		error = noun + " missing signature metadata";
		return false;
	}
	license::os::SignatureVerificationRequest request;
	request.payload = payload;
	request.signature = signature;
	request.declared_algorithm = algorithm;
	request.key_id = key_id;
	request.license_version = license_version;
	request.policy = policy;
	if (license::os::verify_signature(request) != FUNC_RET_OK) {
		error = noun + " signature verification failed";
		return false;
	}
	return true;
}

}  // namespace signed_token
}  // namespace license
