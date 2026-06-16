#ifndef LICENSECC_SIGNED_TOKEN_HPP_
#define LICENSECC_SIGNED_TOKEN_HPP_

#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "../base/base64.h"
#include "../os/os.h"
#include "../os/signature_verifier.hpp"

namespace license {
namespace signed_token {

// Wall-clock epoch seconds. Shared by the online-assertion and config-attestation
// protocols, which both default `now_epoch_seconds == 0` to "use the real clock".
uint64_t now_epoch_seconds();

// A canonical payload field value may not contain a line break or '=' because those
// would break the `key=value\n` line framing.
bool value_has_line_breaks_or_equals(const std::string& value);

// Append a `key=value\n` line. Returns false (and writes nothing) if the value would
// break the canonical line framing.
bool append_claim_line(std::ostringstream& out, const char* key, const std::string& value);

// Append a `key=<decimal>\n` line. Always succeeds (decimal digits are framing-safe).
bool append_uint_claim_line(std::ostringstream& out, const char* key, uint64_t value);

// Parse a base-10 unsigned 64-bit integer with an overflow guard. Uses the locale-safe
// `ch < '0' || ch > '9'` range form (the reconciled digit test: the online protocol's
// historical `std::isdigit` form is replaced by this range form here, which the
// config-attestation protocol already used). Returns false on empty input, a non-digit
// character, or overflow.
bool parse_uint64(const std::string& value, uint64_t& out);

// Extract the first `key=...` line value from a canonical payload, before the payload has
// been fully validated (used to read `alg`/`key-id` ahead of signature verification).
// Returns false if the key is absent or its value is empty.
bool extract_preverify_field(const std::string& payload, const char* key, std::string& out);

// Split an `<prefix>.<payload-b64>.<sig-b64>` envelope. `error_noun` is the protocol noun
// ("online assertion" / "config token") woven into the diagnostic strings, preserving the
// exact pre-extraction error text. Returns false (and sets `error`) on malformed input.
bool split_envelope(const std::string& token, const char* expected_prefix, const char* error_noun,
					std::string& payload_b64, std::string& signature_b64, std::string& error);

// Build an `<prefix>.<base64(payload)>.<sig-b64>` envelope.
std::string build_envelope(const char* prefix, const std::string& payload, const std::string& signature_base64);

// One canonical-payload field: the line key and where to store its raw string value.
// `validate_value` mirrors the online protocol's per-field rejection of values that
// contain line breaks or '='; the config protocol passes false (no per-field validation).
struct FieldSpec {
	const char* key;
	std::string* value;
};

// Parse the in-order `key=value\n` lines of a canonical payload into the supplied fields.
// Enforces order, prefix match, presence, and "no unknown trailing fields". When
// `validate_values` is true each parsed value is additionally rejected if it contains a
// line break or '='. `error_noun` weaves the protocol noun into the diagnostics, exactly
// matching the pre-extraction error strings.
bool parse_fields_in_order(const std::string& payload, const FieldSpec* fields, size_t field_count,
						   const char* error_noun, bool validate_values, std::string& error);

// Read the declared `alg`/`key-id` from the payload, then run signature verification under
// the supplied policy. `error_noun` weaves the protocol noun into the diagnostics. Returns
// false (and sets `error`) when metadata is missing or the signature does not verify.
bool verify_payload_signature(const std::vector<uint8_t>& payload, const std::vector<uint8_t>& signature,
							  const std::string& payload_text, unsigned int license_version,
							  const license::os::SignatureVerificationPolicy& policy, const char* error_noun,
							  std::string& error);

// Per-public-key-type test override of the trusted public-key ring. Each `PublicKey`
// instantiation owns a distinct static store + mutex, so the online and config protocols
// never share override state. Replaces the previous per-module free-function singletons.
template <typename PublicKey>
struct TrustedKeyOverride {
	static std::vector<PublicKey>& store() {
		static std::vector<PublicKey> public_keys;
		return public_keys;
	}
	static std::mutex& mutex() {
		static std::mutex mutex;
		return mutex;
	}
	static void set(const std::vector<PublicKey>& public_keys) {
		std::lock_guard<std::mutex> lock(mutex());
		store() = public_keys;
	}
	static std::vector<PublicKey> get() {
		std::lock_guard<std::mutex> lock(mutex());
		return store();
	}
};

}  // namespace signed_token
}  // namespace license

#endif
