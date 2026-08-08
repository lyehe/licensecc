#include "ActivationRequest.hpp"

#include <sstream>
#include <vector>

#include "../base/base64.h"
#include "../signed_token/SignedToken.hpp"

namespace license {
namespace activation {

const char kActivationRequestPrefix[] = "lccareq1";

namespace {

const char kProjectKey[] = "project";
const char kFeatureKey[] = "feature";
const char kHwidKey[] = "hwid";
const char kNonceKey[] = "nonce";
const char kIssuedAtKey[] = "issued-at";

// Append a `key=value\n` line. Rejects only line breaks: '=' is intentionally permitted inside
// a value (the canonical hwid ends in base64 padding), because parsing splits on the FIRST '='.
bool append_line(std::ostringstream& out, const char* key, const std::string& value) {
	for (const char c : value) {
		if (c == '\n' || c == '\r') {
			return false;
		}
	}
	out << key << '=' << value << '\n';
	return true;
}

// Locale-safe range checks (matching parse_uint64's style). A project/feature name is a bounded
// identifier; the hwid is canonical base64 groups joined by '-' (the HwIdentifier::print() charset).
bool is_name_char(char c) {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
		   c == '-';
}
bool is_hwid_char(char c) {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' ||
		   c == '=' || c == '-';
}

// A field value must be non-empty, bounded, and drawn ONLY from the given charset. This is a
// security boundary, not cosmetics: the decoded fields are interpolated by the operator side
// (lcc-inspector --decode-activation-request) into a suggested `lccgen license issue ...` command
// run on the private-key-holding host. Restricting to identifier/base64 charsets (no spaces, no
// shell metacharacters, no '--flags'-enabling whitespace) closes an argument/command-injection
// channel from an untrusted, unsigned request. Legitimate project/feature names and the canonical
// hwid all fit these sets.
bool valid_field(const std::string& value, bool (*char_ok)(char), std::size_t max_len) {
	if (value.empty() || value.size() > max_len) {
		return false;
	}
	for (const char c : value) {
		if (!char_ok(c)) {
			return false;
		}
	}
	return true;
}

bool fields_have_safe_charsets(const std::string& project, const std::string& feature, const std::string& hwid) {
	return valid_field(project, is_name_char, 127) && valid_field(feature, is_name_char, 127) &&
		   valid_field(hwid, is_hwid_char, 64);
}

}  // namespace

std::string build_activation_request(const ActivationRequestFields& fields) {
	// Refuse to emit a request whose fields fall outside the safe charsets the parser enforces, so a
	// request this library produces always round-trips (and we never mint an injection-shaped value).
	if (!fields_have_safe_charsets(fields.project, fields.feature, fields.hwid)) {
		return std::string();
	}
	std::ostringstream payload;
	if (!append_line(payload, kProjectKey, fields.project) || !append_line(payload, kFeatureKey, fields.feature) ||
		!append_line(payload, kHwidKey, fields.hwid)) {
		return std::string();
	}
	// nonce/issued-at are decimals -> framing-safe; reuse the shared uint appender's format.
	std::ostringstream nonce_line;
	nonce_line << fields.nonce;
	std::ostringstream issued_line;
	issued_line << fields.issued_at;
	if (!append_line(payload, kNonceKey, nonce_line.str()) || !append_line(payload, kIssuedAtKey, issued_line.str())) {
		return std::string();
	}
	const std::string payload_text = payload.str();
	std::string result(kActivationRequestPrefix);
	result += '.';
	result += license::base64(payload_text.data(), payload_text.size(), 0);
	return result;
}

bool parse_activation_request(const std::string& token, ActivationRequestFields& out, std::string& error) {
	const std::string prefix = std::string(kActivationRequestPrefix) + ".";
	if (token.size() <= prefix.size() || token.compare(0, prefix.size(), prefix) != 0) {
		error = "activation request: unexpected prefix (expected lccareq1.)";
		return false;
	}
	const std::string payload_b64 = token.substr(prefix.size());
	if (payload_b64.find('.') != std::string::npos || !license::is_canonical_base64(payload_b64, false)) {
		error = "activation request: payload is not canonical base64";
		return false;
	}
	const std::vector<uint8_t> payload_bytes = license::unbase64(payload_b64);
	const std::string payload(payload_bytes.begin(), payload_bytes.end());

	std::string nonce_str;
	std::string issued_at_str;
	const char* const keys[] = {kProjectKey, kFeatureKey, kHwidKey, kNonceKey, kIssuedAtKey};
	std::string* const values[] = {&out.project, &out.feature, &out.hwid, &nonce_str, &issued_at_str};
	const size_t field_count = sizeof(keys) / sizeof(keys[0]);

	size_t pos = 0;
	for (size_t i = 0; i < field_count; ++i) {
		const size_t nl = payload.find('\n', pos);
		if (nl == std::string::npos) {
			error = "activation request: payload is truncated";
			return false;
		}
		const std::string line = payload.substr(pos, nl - pos);
		const std::string key_prefix = std::string(keys[i]) + "=";
		if (line.compare(0, key_prefix.size(), key_prefix) != 0) {
			error = std::string("activation request: field '") + keys[i] + "' missing or out of order";
			return false;
		}
		// Value = everything after the first '=' (preserves a trailing base64 '=' in the hwid).
		*values[i] = line.substr(key_prefix.size());
		pos = nl + 1;
	}
	if (pos != payload.size()) {
		error = "activation request: unexpected trailing data";
		return false;
	}
	// SECURITY: the decoded project/feature/hwid are consumed by the operator side, which interpolates
	// them into a suggested `lccgen license issue ...` command on the private-key-holding host. The
	// request is UNSIGNED and attacker-controllable, so enforce strict charsets (no spaces, no shell
	// metacharacters, no '--flag'-enabling bytes) to close an argument/command-injection channel. Also
	// rejects empty required fields (a silently-malformed operator command otherwise).
	if (!fields_have_safe_charsets(out.project, out.feature, out.hwid)) {
		error = "activation request: a field is empty or contains characters outside its allowed charset";
		return false;
	}
	if (!signed_token::parse_uint64(nonce_str, out.nonce)) {
		error = "activation request: nonce is not a valid unsigned integer";
		return false;
	}
	if (!signed_token::parse_uint64(issued_at_str, out.issued_at)) {
		error = "activation request: issued-at is not a valid unsigned integer";
		return false;
	}
	return true;
}

}  // namespace activation
}  // namespace license
