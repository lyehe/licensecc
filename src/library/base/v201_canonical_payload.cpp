#include "v201_canonical_payload.hpp"

#include <algorithm>
#include <cctype>
#include <iomanip>
#include <map>
#include <set>
#include <sstream>

namespace license {
namespace v201 {
namespace {

const char* const kDomain = "licensecc:v201\n";
const size_t kMaxKeyLength = 64;
const size_t kMaxValueLength = 4096;
const size_t kMaxPayloadLength = 16384;

const std::vector<std::string>& canonical_order() {
	static const std::vector<std::string> order = {
		"lic_ver",		  "canonical-v",	 "sig-v",		 "sig-alg",		"key-id",
		"project",		  "feature",		 "valid-from",	 "valid-to",	"start-version",
		"end-version",	  "client-signature", "client-signature-source-strength", "extra-data",
	};
	return order;
}

const std::set<std::string>& required_fields() {
	static const std::set<std::string> fields = {
		"lic_ver", "canonical-v", "sig-v", "sig-alg", "key-id", "project", "feature",
	};
	return fields;
}

bool is_allowed_key(const std::string& key) {
	return std::find(canonical_order().begin(), canonical_order().end(), key) != canonical_order().end();
}

bool is_lower_hex(const char ch) {
	return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
}

bool is_ascii_lower(const unsigned char ch) {
	return ch >= 'a' && ch <= 'z';
}

bool is_ascii_upper(const unsigned char ch) {
	return ch >= 'A' && ch <= 'Z';
}

bool is_ascii_digit(const unsigned char ch) {
	return ch >= '0' && ch <= '9';
}

bool is_ascii_alpha(const unsigned char ch) {
	return is_ascii_lower(ch) || is_ascii_upper(ch);
}

bool is_ascii_alnum(const unsigned char ch) {
	return is_ascii_alpha(ch) || is_ascii_digit(ch);
}

bool has_disallowed_value_byte(const std::string& value) {
	for (const unsigned char ch : value) {
		if (ch < 0x20 || ch > 0x7e) {
			return true;
		}
	}
	return false;
}

bool valid_key_name(const std::string& key) {
	if (key.empty() || key.size() > kMaxKeyLength) {
		return false;
	}
	for (const unsigned char ch : key) {
		if (!(is_ascii_lower(ch) || is_ascii_digit(ch) || ch == '-' || ch == '_')) {
			return false;
		}
	}
	return true;
}

bool valid_project_name(const std::string& value) {
	if (value.empty()) {
		return false;
	}
	const unsigned char first = static_cast<unsigned char>(value[0]);
	if (!(is_ascii_alpha(first) || value[0] == '_')) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!(is_ascii_alnum(ch) || ch == '_')) {
			return false;
		}
	}
	return true;
}

bool valid_feature_name(const std::string& value) {
	if (value.empty()) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!(is_ascii_upper(ch) || is_ascii_digit(ch) || ch == '_' || ch == '-' || ch == '.')) {
			return false;
		}
	}
	return true;
}

bool parse_date(const std::string& value, unsigned int& year, unsigned int& month, unsigned int& day) {
	if (value.size() != 10 || value[4] != '-' || value[7] != '-') {
		return false;
	}
	const int positions[] = {0, 1, 2, 3, 5, 6, 8, 9};
	for (const int pos : positions) {
		if (!std::isdigit(static_cast<unsigned char>(value[pos]))) {
			return false;
		}
	}
	year = static_cast<unsigned int>(std::stoul(value.substr(0, 4)));
	month = static_cast<unsigned int>(std::stoul(value.substr(5, 2)));
	day = static_cast<unsigned int>(std::stoul(value.substr(8, 2)));
	const bool leap_year = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
	const unsigned int days_in_month[] = {0,  31, leap_year ? 29U : 28U, 31, 30, 31, 30,
										  31, 31, 30,                 31, 30, 31};
	return year != 0 && month >= 1 && month <= 12 && day >= 1 && day <= days_in_month[month];
}

bool valid_date(const std::string& value) {
	unsigned int year = 0;
	unsigned int month = 0;
	unsigned int day = 0;
	return parse_date(value, year, month, day);
}

bool valid_version(const std::string& value) {
	if (value.empty() || value.front() == '.' || value.back() == '.') {
		return false;
	}
	size_t components = 0;
	size_t component_size = 0;
	for (const char ch : value) {
		if (ch == '.') {
			if (component_size == 0 || component_size > 4 || components >= 2) {
				return false;
			}
			++components;
			component_size = 0;
			continue;
		}
		if (!std::isdigit(static_cast<unsigned char>(ch))) {
			return false;
		}
		++component_size;
	}
	return component_size > 0 && component_size <= 4;
}

std::vector<unsigned int> version_components(const std::string& value) {
	std::vector<unsigned int> parts;
	std::stringstream stream(value);
	std::string part;
	while (std::getline(stream, part, '.')) {
		parts.push_back(static_cast<unsigned int>(std::stoul(part)));
	}
	return parts;
}

int compare_versions(const std::string& lhs, const std::string& rhs) {
	const std::vector<unsigned int> lhs_parts = version_components(lhs);
	const std::vector<unsigned int> rhs_parts = version_components(rhs);
	const size_t max_parts = std::max(lhs_parts.size(), rhs_parts.size());
	for (size_t i = 0; i < max_parts; ++i) {
		const unsigned int lhs_part = i < lhs_parts.size() ? lhs_parts[i] : 0U;
		const unsigned int rhs_part = i < rhs_parts.size() ? rhs_parts[i] : 0U;
		if (lhs_part < rhs_part) {
			return -1;
		}
		if (lhs_part > rhs_part) {
			return 1;
		}
	}
	return 0;
}

bool valid_key_id(const std::string& value) {
	const std::string prefix = "sha256:";
	if (value.size() != prefix.size() + 64 || value.compare(0, prefix.size(), prefix) != 0) {
		return false;
	}
	for (size_t i = prefix.size(); i < value.size(); ++i) {
		if (!is_lower_hex(value[i])) {
			return false;
		}
	}
	return true;
}

bool valid_client_signature_source_strength(const std::string& value) {
	static const std::set<std::string> values = {
		"strong-ethernet-mac",
		"strong-disk-serial-or-uuid",
		"weak-ip-address",
		"weak-env-selected-ethernet-mac",
		"weak-env-selected-ip-address",
		"weak-env-selected-disk-serial-or-uuid",
		"weak-disk-label",
		"weak-env-selected-disk-label",
		"weak-disk-mutable",
		"weak-env-selected-disk-mutable",
	};
	return values.find(value) != values.end();
}

std::string frame_length(const size_t length) {
	std::ostringstream out;
	out << std::hex << std::nouppercase << std::setfill('0') << std::setw(8) << length;
	return out.str();
}

void append_ascii(std::vector<uint8_t>& out, const std::string& value) {
	out.insert(out.end(), value.begin(), value.end());
}

void append_field(std::vector<uint8_t>& out, const std::string& key, const std::string& value) {
	append_ascii(out, "k" + frame_length(key.size()) + ":");
	append_ascii(out, key);
	append_ascii(out, "v" + frame_length(value.size()) + ":");
	append_ascii(out, value);
	out.push_back('\n');
}

CanonicalPayloadResult error_result(const std::string& error) {
	CanonicalPayloadResult result;
	result.error = error;
	return result;
}

bool validate_field_semantics(const std::string& key, const std::string& value, std::string& error) {
	if (key == "lic_ver" && value != "201") {
		error = "lic_ver must be 201";
		return false;
	}
	if ((key == "canonical-v" || key == "sig-v") && value != "1") {
		error = key + " must be 1";
		return false;
	}
	if (key == "sig-alg" && value != "rsa-pkcs1-sha256") {
		error = "sig-alg is unsupported";
		return false;
	}
	if (key == "key-id" && !valid_key_id(value)) {
		error = "key-id must be sha256 plus 64 lowercase hex characters";
		return false;
	}
	if (key == "project" && !valid_project_name(value)) {
		error = "project is not a valid licensecc project name";
		return false;
	}
	if (key == "feature" && !valid_feature_name(value)) {
		error = "feature is not canonical";
		return false;
	}
	if ((key == "valid-from" || key == "valid-to") && !valid_date(value)) {
		error = key + " is not a canonical calendar date";
		return false;
	}
	if ((key == "start-version" || key == "end-version") && !valid_version(value)) {
		error = key + " is not a canonical version";
		return false;
	}
	if (key == "client-signature-source-strength" && !valid_client_signature_source_strength(value)) {
		error = "client-signature-source-strength is unsupported";
		return false;
	}
	return true;
}

}  // namespace

CanonicalPayloadResult build_canonical_payload(const std::vector<CanonicalField>& fields) {
	std::map<std::string, std::string> by_key;
	for (const CanonicalField& field : fields) {
		if (!valid_key_name(field.key)) {
			return error_result("invalid canonical field key: " + field.key);
		}
		if (field.key == "sig") {
			return error_result("sig must not be included in the canonical payload");
		}
		if (!is_allowed_key(field.key)) {
			return error_result("unknown canonical field key: " + field.key);
		}
		if (field.value.empty()) {
			return error_result("canonical field value must not be empty: " + field.key);
		}
		if (field.value.size() > kMaxValueLength) {
			return error_result("canonical field value is too long: " + field.key);
		}
		if (has_disallowed_value_byte(field.value)) {
			return error_result("canonical field value contains a non-printable or non-ASCII byte: " + field.key);
		}
		if (!by_key.insert(std::make_pair(field.key, field.value)).second) {
			return error_result("duplicate canonical field key: " + field.key);
		}
		std::string semantic_error;
		if (!validate_field_semantics(field.key, field.value, semantic_error)) {
			return error_result(semantic_error);
		}
	}
	for (const std::string& required : required_fields()) {
		if (by_key.find(required) == by_key.end()) {
			return error_result("missing required canonical field: " + required);
		}
	}
	if (by_key.count("valid-from") != 0 && by_key.count("valid-to") != 0 &&
		by_key["valid-from"] > by_key["valid-to"]) {
		return error_result("valid-from must not be after valid-to");
	}
	if (by_key.count("start-version") != 0 && by_key.count("end-version") != 0 &&
		compare_versions(by_key["start-version"], by_key["end-version"]) > 0) {
		return error_result("start-version must not be after end-version");
	}
	if (by_key.count("client-signature") != by_key.count("client-signature-source-strength")) {
		return error_result("client-signature and client-signature-source-strength must be present together");
	}

	CanonicalPayloadResult result;
	result.ok = true;
	append_ascii(result.bytes, kDomain);
	for (const std::string& key : canonical_order()) {
		const std::map<std::string, std::string>::const_iterator found = by_key.find(key);
		if (found != by_key.end()) {
			append_field(result.bytes, found->first, found->second);
		}
	}
	if (result.bytes.size() > kMaxPayloadLength) {
		return error_result("canonical payload is too long");
	}
	return result;
}

std::string canonical_payload_hex(const std::vector<uint8_t>& bytes) {
	std::ostringstream out;
	out << std::hex << std::nouppercase << std::setfill('0');
	for (const uint8_t byte : bytes) {
		out << std::setw(2) << static_cast<unsigned int>(byte);
	}
	return out.str();
}

}  // namespace v201
}  // namespace license
