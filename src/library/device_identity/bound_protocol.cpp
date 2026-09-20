#include "bound_protocol.hpp"
#include "bound_encoding.hpp"
#include "p256_crypto.hpp"

#include <algorithm>
#include <charconv>
#include <initializer_list>
#include <utility>
#include <stdexcept>

namespace license {
namespace device_identity {
void wipe_bound_exchange(BoundExchangeInput& input) noexcept {
	for (auto* value :
		 {&input.attempt_handle, &input.code, &input.code_verifier, &input.redirect_uri, &input.operation_id}) {
		secure_zero(value->data(), value->size());
		value->clear();
	}
}
BoundExchangeSecret::BoundExchangeSecret(const BoundExchangeInput& input) {
	const std::pair<std::string*, const std::string*> fields[] = {{&value.attempt_handle, &input.attempt_handle},
																  {&value.code, &input.code},
																  {&value.code_verifier, &input.code_verifier},
																  {&value.redirect_uri, &input.redirect_uri},
																  {&value.operation_id, &input.operation_id}};
	// Complete allocations before copying any secret: a throwing constructor
	// otherwise would not run this object's wiping destructor.
	for (const auto& field : fields) {
		if (field.second->size() > 1024) throw std::invalid_argument("invalid_exchange_field");
		field.first->reserve(field.second->size());
	}
	try {
		for (const auto& field : fields) field.first->assign(*field.second);
	} catch (...) {
		wipe_bound_exchange(value);
		throw;
	}
}
namespace {
using namespace bound_encoding;
bool append_fields(std::string& payload, std::initializer_list<const std::string*> fields) {
	for (const auto* field : fields) {
		if (!utf8_text(*field)) return false;
		const auto encoded = base64url(*field);
		if (encoded.empty()) return false;
		payload.append(encoded).push_back('\n');
	}
	return true;
}
// Direct encoding into pre-reserved wipe-on-destruction storage avoids ordinary
// string temporaries containing authorization codes or PKCE verifiers.
void append_url64(std::vector<std::uint8_t>& out, const std::uint8_t* bytes, std::size_t size) {
	constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	unsigned accumulator = 0, bits = 0;
	for (std::size_t i = 0; i < size; ++i) {
		accumulator = (accumulator << 8) | bytes[i];
		bits += 8;
		while (bits >= 6) {
			bits -= 6;
			out.push_back(alphabet[(accumulator >> bits) & 63]);
		}
	}
	if (bits) out.push_back(alphabet[(accumulator << (6 - bits)) & 63]);
}
void append_url64(std::vector<std::uint8_t>& out, const std::string& text) {
	append_url64(out, reinterpret_cast<const std::uint8_t*>(text.data()), text.size());
}
void append_literal(std::vector<std::uint8_t>& out, const char* text) {
	while (*text) out.push_back(static_cast<std::uint8_t>(*text++));
}
bool semantic_body(std::initializer_list<const std::string*> fields, const std::uint64_t* generation,
				   SensitiveVector& out) {
	for (const auto* field : fields)
		if (!utf8_text(*field)) return false;
	SensitiveVector candidate;
	candidate.value.reserve(8192);	// bounded fields fit without secret-bearing reallocation
	candidate.value.push_back('[');
	std::size_t index = 0;
	for (const auto* field : fields) {
		if (index) candidate.value.push_back(',');
		candidate.value.push_back('"');
		append_url64(candidate.value, *field);
		candidate.value.push_back('"');
		if (++index == 1 && generation) {
			char decimal[32];
			const auto result = std::to_chars(decimal, decimal + sizeof(decimal), *generation);
			if (result.ec != std::errc()) return false;
			candidate.value.push_back(',');
			candidate.value.insert(candidate.value.end(), decimal, result.ptr);
		}
	}
	candidate.value.push_back(']');
	out.value.swap(candidate.value);
	return true;
}
template <class Input>
bool operation_digest_input(const Input& input, const std::string& key_id, const char* purpose, SensitiveVector& out) {
	if (!key_id_valid(key_id)) return false;
	SensitiveVector semantic, candidate;
	if (!bound_operation_body_v1(input, semantic)) return false;
	candidate.value.reserve(16384);
	append_literal(candidate.value, "lcc-device-operation-v1\n");
	append_url64(candidate.value, std::string(purpose));
	candidate.value.push_back('\n');
	append_url64(candidate.value, key_id);
	candidate.value.push_back('\n');
	append_url64(candidate.value, semantic.value.data(), semantic.value.size());
	candidate.value.push_back('\n');
	out.value.swap(candidate.value);
	return true;
}
template <class Input>
bool valid_operation(const Input& input);
template <>
bool valid_operation(const BoundExchangeInput& input) {
	return token(input.attempt_handle, 32) && token(input.code, 32) && token(input.code_verifier, 32) &&
		   token(input.operation_id, 32) && utf8_text(input.redirect_uri);
}
template <>
bool valid_operation(const BoundRenewInput& input) {
	return token(input.binding_id, 16) && token(input.operation_id, 32) && input.generation >= 1 &&
		   input.generation <= 9007199254740991ULL;
}
template <class Input>
LCC_DEVICE_RESULT prepare(const Input& input, const BoundChallenge& challenge, const std::string& audience,
						  const std::string& key_id, const char* path, BoundPreparedProof& out) {
	if (!valid_operation(input) || !key_id_valid(key_id) || !utf8_text(audience) ||
		!token(challenge.challenge_id, 16) || !token(challenge.nonce, 32) || challenge.expires_at > 9007199254740991ULL)
		return LCC_DEVICE_INVALID_ARGUMENT;
	SensitiveVector semantic, operation;
	SensitiveArray<32> body_hash, operation_hash;
	if (!bound_operation_body_v1(input, semantic) || !bound_operation_digest_input_v1(input, key_id, operation) ||
		!sha256(semantic.value.data(), semantic.value.size(), body_hash.value) ||
		!sha256(operation.value.data(), operation.value.size(), operation_hash.value))
		return LCC_DEVICE_INTERNAL_ERROR;
	BoundPreparedProof candidate;
	candidate.proof = {audience,
					   path,
					   input.operation_id,
					   lowercase_hex(body_hash.value.data(), 32),
					   challenge.challenge_id,
					   challenge.nonce,
					   challenge.expires_at};
	candidate.operation_digest = lowercase_hex(operation_hash.value.data(), 32);
	std::vector<std::uint8_t> proof_bytes;
	if (candidate.operation_digest.size() != 64 || !bound_proof_input_v2(candidate.proof, key_id, proof_bytes))
		return LCC_DEVICE_INTERNAL_ERROR;
	out = std::move(candidate);
	return LCC_DEVICE_OK;
}
}  // namespace

bool bound_operation_body_v1(const BoundExchangeInput& input, SensitiveVector& out) noexcept {
	try {
		if (!valid_operation(input)) return false;
		return semantic_body(
			{&input.attempt_handle, &input.code, &input.code_verifier, &input.redirect_uri, &input.operation_id},
			nullptr, out);
	} catch (...) {
		return false;
	}
}
bool bound_operation_body_v1(const BoundRenewInput& input, SensitiveVector& out) noexcept {
	try {
		if (!valid_operation(input)) return false;
		return semantic_body({&input.binding_id, &input.operation_id}, &input.generation, out);
	} catch (...) {
		return false;
	}
}
bool bound_operation_digest_input_v1(const BoundExchangeInput& input, const std::string& key_id,
									 SensitiveVector& out) noexcept {
	try {
		return operation_digest_input(input, key_id, "exchange", out);
	} catch (...) {
		return false;
	}
}
bool bound_operation_digest_input_v1(const BoundRenewInput& input, const std::string& key_id,
									 SensitiveVector& out) noexcept {
	try {
		return operation_digest_input(input, key_id, "renew", out);
	} catch (...) {
		return false;
	}
}
LCC_DEVICE_RESULT prepare_bound_proof_v2(const BoundExchangeInput& input, const BoundChallenge& challenge,
										 const std::string& audience, const std::string& key_id,
										 BoundPreparedProof& out) noexcept {
	try {
		return prepare(input, challenge, audience, key_id, "/v2/device-authorizations/exchange", out);
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}
LCC_DEVICE_RESULT prepare_bound_proof_v2(const BoundRenewInput& input, const BoundChallenge& challenge,
										 const std::string& audience, const std::string& key_id,
										 BoundPreparedProof& out) noexcept {
	try {
		return prepare(input, challenge, audience, key_id, "/v2/device-leases/renew", out);
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

bool bound_proof_input_v2(const BoundProofInput& input, const std::string& key_id,
						  std::vector<std::uint8_t>& out) noexcept {
	try {
		if (!key_id_valid(key_id) || !hex_digest(input.body_sha256) || !token(input.operation_id, 32) ||
			!token(input.challenge_id, 16) || !token(input.nonce, 32) || input.expires_at > 9007199254740991ULL ||
			(input.path != "/v2/device-authorizations/exchange" && input.path != "/v2/device-leases/renew"))
			return false;
		const std::string method = "POST";
		std::string payload = "lcc-device-proof-v2\n";
		if (!append_fields(payload, {&input.audience, &method, &input.path, &key_id, &input.operation_id,
									 &input.body_sha256, &input.challenge_id, &input.nonce}))
			return false;
		char decimal[32];
		const auto result = std::to_chars(decimal, decimal + sizeof(decimal), input.expires_at);
		if (result.ec != std::errc()) return false;
		payload.append(decimal, result.ptr).push_back('\n');
		std::vector<std::uint8_t> candidate(payload.begin(), payload.end());
		out.swap(candidate);
		return true;
	} catch (...) {
		return false;
	}
}

bool enrollment_comparison_input_v1(const EnrollmentComparisonInput& input, const std::string& key_id,
									std::vector<std::uint8_t>& out) noexcept {
	try {
		if (!key_id_valid(key_id) || !name(input.client_id) || !name(input.project) ||
			!token(input.attempt_handle, 32) || !token(input.state, 32) || !token(input.code_challenge, 32))
			return false;
		std::string payload = "lcc-device-enrollment-comparison-v1\n";
		if (!append_fields(payload, {&input.attempt_handle, &input.client_id, &input.project, &key_id,
									 &input.redirect_uri, &input.state, &input.code_challenge}))
			return false;
		std::vector<std::uint8_t> candidate(payload.begin(), payload.end());
		out.swap(candidate);
		return true;
	} catch (...) {
		return false;
	}
}

bool enrollment_comparison_code_v1(const EnrollmentComparisonInput& input, const std::string& key_id,
								   std::string& out) noexcept {
	try {
		std::vector<std::uint8_t> payload;
		SensitiveArray<32> digest;
		if (!enrollment_comparison_input_v1(input, key_id, payload) ||
			!sha256(payload.data(), payload.size(), digest.value))
			return false;
		std::string candidate;
		constexpr char hex[] = "0123456789ABCDEF";
		for (std::size_t i = 0; i < 6; ++i) {
			if (i && i % 2 == 0) candidate.push_back('-');
			candidate.push_back(hex[digest.value[i] >> 4]);
			candidate.push_back(hex[digest.value[i] & 15]);
		}
		out.swap(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace device_identity
}  // namespace license
