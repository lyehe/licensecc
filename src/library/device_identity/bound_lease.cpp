#include "bound_lease.hpp"
#include "bound_encoding.hpp"
#include "p256_crypto.hpp"
#include "../os/signature_verifier.hpp"
#include <algorithm>
#include <array>
#include <utility>

namespace license {
namespace device_identity {
namespace {
using namespace bound_encoding;
constexpr std::uint64_t safe_max = 9007199254740991ULL;
constexpr std::array<const char*, 17> fields = {{"version", "purpose", "key-id", "issuer", "audience", "project",
												 "feature", "license-fingerprint", "binding-id", "device-key-id",
												 "generation", "revocation-seq", "lease-id", "operation-id",
												 "issued-at", "renew-after", "expires-at"}};
bool payload_claims(const std::vector<std::uint8_t>& bytes, BoundLeaseClaims& out) {
	if (bytes.empty() || bytes.size() > 4096) return false;
	const std::string payload(bytes.begin(), bytes.end());
	std::array<std::string, 17> values;
	std::size_t offset = 0;
	for (std::size_t i = 0; i < fields.size(); ++i) {
		const auto end = payload.find('\n', offset);
		const std::string prefix = std::string(fields[i]) + '=';
		if (end == std::string::npos || end - offset < prefix.size() ||
			payload.compare(offset, prefix.size(), prefix) != 0)
			return false;
		values[i] = payload.substr(offset + prefix.size(), end - offset - prefix.size());
		offset = end + 1;
	}
	if (offset != payload.size()) return false;
	BoundLeaseClaims candidate;
	std::uint64_t version = 0;
	if (!safe_integer(values[0], version) || version != 1 || !safe_integer(values[10], candidate.generation) ||
		!safe_integer(values[11], candidate.revocation_seq) || !safe_integer(values[14], candidate.issued_at) ||
		!safe_integer(values[15], candidate.renew_after) || !safe_integer(values[16], candidate.expires_at))
		return false;
	for (const std::size_t index : {1U, 2U, 3U, 4U, 5U, 6U, 7U, 8U, 9U, 12U, 13U}) {
		std::vector<std::uint8_t> decoded;
		if (!decode_base64url(values[index], 1024, decoded)) return false;
		values[index].assign(decoded.begin(), decoded.end());
		if (!utf8_text(values[index])) return false;
	}
	if (values[1] != "device-lease" || !key_id_valid(values[2]) || !key_id_valid(values[9]) || !name(values[5]) ||
		!name(values[6], 15) || !hex_digest(values[7]) || !token(values[8], 16) || !token(values[12], 16) ||
		!token(values[13], 32) || candidate.generation < 1 || candidate.issued_at >= candidate.renew_after ||
		candidate.renew_after >= candidate.expires_at || candidate.expires_at - candidate.issued_at > 86400 ||
		candidate.expires_at > safe_max - 120)
		return false;
	candidate.signer_key_id = values[2];
	candidate.issuer = values[3];
	candidate.audience = values[4];
	candidate.project = values[5];
	candidate.feature = values[6];
	candidate.license_fingerprint = values[7];
	candidate.binding_id = values[8];
	candidate.device_key_id = values[9];
	candidate.lease_id = values[12];
	candidate.operation_id = values[13];
	out = std::move(candidate);
	return true;
}
// DER SPKI for rsaEncryption with explicit NULL parameters. Reuse the existing
// strict DER length/integer checks and RSA exponent validation, without changing
// the legacy verifier's PKCS#1-based key identity contract.
bool rsa3072_spki(const std::vector<std::uint8_t>& spki, std::vector<std::uint8_t>& pkcs1, std::string& spki_id) {
	if (spki.size() > 1024 || spki.empty() || spki[0] != 0x30) return false;
	std::size_t offset = 1, length = 0;
	if (!os::signature_read_der_length(spki, offset, length) || length != spki.size() - offset) return false;
	constexpr std::array<std::uint8_t, 15> algorithm = {
		{0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00}};
	if (spki.size() - offset < algorithm.size() ||
		!std::equal(algorithm.begin(), algorithm.end(), spki.begin() + offset))
		return false;
	offset += algorithm.size();
	if (offset >= spki.size() || spki[offset++] != 0x03 || !os::signature_read_der_length(spki, offset, length) ||
		length != spki.size() - offset || length < 2 || spki[offset++] != 0)
		return false;
	std::vector<std::uint8_t> candidate(spki.begin() + offset, spki.end());
	if (os::rsa_public_key_bits_from_pkcs1_der(candidate) != 3072) return false;
	P256Digest hash;
	if (!sha256(spki.data(), spki.size(), hash)) return false;
	const auto id = std::string("sha256:") + lowercase_hex(hash.data(), hash.size());
	if (!key_id_valid(id)) return false;
	pkcs1.swap(candidate);
	spki_id = id;
	return true;
}
bool expected_claims(const BoundLeaseClaims& c, const BoundLeaseExpected& e) {
	return e.min_revocation_seq <= safe_max && e.generation >= 1 && e.generation <= safe_max && c.issuer == e.issuer &&
		   c.audience == e.audience && c.project == e.project && c.feature == e.feature &&
		   c.license_fingerprint == e.license_fingerprint && c.binding_id == e.binding_id &&
		   c.device_key_id == e.device_key_id && c.operation_id == e.operation_id && c.generation == e.generation &&
		   c.revocation_seq >= e.min_revocation_seq;
}
struct PreparedTrustKey {
	std::string id;
	std::vector<std::uint8_t> pkcs1;
	bool retired;
};
bool prepare_trust(const std::vector<BoundLeaseTrustKey>& keys, std::vector<PreparedTrustKey>& prepared) {
	if (keys.empty() || keys.size() > 8) return false;
	for (const auto& record : keys) {
		PreparedTrustKey key;
		key.retired = record.retired;
		if (!rsa3072_spki(record.spki, key.pkcs1, key.id) ||
			std::any_of(prepared.begin(), prepared.end(),
						[&](const PreparedTrustKey& item) { return item.id == key.id; }))
			return false;
		prepared.push_back(std::move(key));
	}
	return true;
}
bool authenticated(ParsedBoundLease& decoded, const std::vector<BoundLeaseTrustKey>& trusted_keys) {
	std::vector<PreparedTrustKey> prepared;
	if (!prepare_trust(trusted_keys, prepared)) return false;
	std::vector<std::uint8_t> selected;
	for (auto& record : prepared) {
		if (record.id == decoded.claims.signer_key_id) {
			if (record.retired) return false;
			selected = std::move(record.pkcs1);
		}
	}
	if (selected.empty()) return false;
	os::SignatureVerificationRequest request;
	request.payload = {'l', 'c', 'c', 'd', 'l', '1', '.'};
	request.payload.insert(request.payload.end(), decoded.payload.begin(), decoded.payload.end());
	request.signature = std::move(decoded.signature);
	// This singleton internal policy has no connection to any embedded ring.
	request.key_id = os::public_key_id_from_der(selected);
	request.declared_algorithm = os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	request.license_version = 1;
	request.policy.license_version = 1;
	request.policy.allowed_algorithms = {request.declared_algorithm};
	request.policy.allowed_key_ids = {request.key_id};
	request.policy.public_keys.emplace_back(request.key_id, selected, 3072);
	request.policy.min_public_key_bits = 3072;
	return os::verify_signature(request) == FUNC_RET_OK;
}
}  // namespace
bool validate_bound_lease_trust(const std::vector<BoundLeaseTrustKey>& keys) noexcept {
	try {
		std::vector<PreparedTrustKey> prepared;
		return prepare_trust(keys, prepared);
	} catch (...) {
		return false;
	}
}
bool decode_bound_lease(const std::string& token_value, ParsedBoundLease& out) noexcept {
	try {
		if (token_value.size() > 8192 || token_value.compare(0, 7, "lccdl1.") != 0) return false;
		const auto separator = token_value.find('.', 7);
		if (separator == std::string::npos || token_value.find('.', separator + 1) != std::string::npos) return false;
		ParsedBoundLease candidate;
		if (!decode_base64url(token_value.substr(7, separator - 7), 4096, candidate.payload) ||
			!decode_base64url(token_value.substr(separator + 1), 384, candidate.signature) ||
			candidate.signature.size() != 384 || !payload_claims(candidate.payload, candidate.claims))
			return false;
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
bool verify_bound_lease(const std::string& token_value, const std::vector<BoundLeaseTrustKey>& trusted_keys,
						const BoundLeaseExpected& expected, std::uint64_t effective_now,
						BoundLeaseClaims& out) noexcept {
	try {
		ParsedBoundLease decoded;
		if (!decode_bound_lease(token_value, decoded) || trusted_keys.empty() || trusted_keys.size() > 8 ||
			effective_now > safe_max || !expected_claims(decoded.claims, expected) ||
			effective_now < decoded.claims.issued_at || effective_now >= decoded.claims.expires_at)
			return false;
		if (!authenticated(decoded, trusted_keys)) return false;
		out = std::move(decoded.claims);
		return true;
	} catch (...) {
		return false;
	}
}
bool verify_bound_resume_statement(const std::string& token, const std::vector<BoundLeaseTrustKey>& trust,
								   const BoundResumeExpected& expected, BoundResumeStatement& out) noexcept {
	try {
		ParsedBoundLease parsed;
		if (!decode_bound_lease(token, parsed)) return false;
		const auto& c = parsed.claims;
		if (c.issuer != expected.issuer || c.audience != expected.audience || c.project != expected.project ||
			c.feature != expected.feature || c.device_key_id != expected.device_key_id || !authenticated(parsed, trust))
			return false;
		BoundResumeStatement statement{c.binding_id, c.license_fingerprint, c.generation, c.revocation_seq};
		out = std::move(statement);
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace device_identity
}  // namespace license
