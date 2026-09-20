#include "bound_wire.hpp"
#include "bound_encoding.hpp"
#include "bound_json.hpp"
#include "bound_lease.hpp"
#include <algorithm>
#include <stdexcept>

namespace license {
namespace device_identity {
namespace {
using Value = bound_json::Value;
void require(bool condition) {
	if (!condition) throw std::invalid_argument("invalid_bound_response");
}
void exact(const Value& value, std::initializer_list<const char*> fields) {
	require(value.type == Value::Type::object && value.fields.size() == fields.size());
	for (const auto* field : fields) require(value.fields.count(field) == 1);
}
const std::string& text(const Value& value, const char* field) {
	const auto& member = value.fields.at(field);
	require(member.type == Value::Type::text);
	return member.text;
}
std::uint64_t number(const Value& value, const char* field) {
	const auto& member = value.fields.at(field);
	require(member.type == Value::Type::number);
	return member.number;
}
bool request_id(const std::string& id) {
	return bound_encoding::utf8_text(id) &&
		   std::none_of(id.begin(), id.end(), [](unsigned char c) { return c < 32 || c == 127; });
}
bool classify_error(BoundWireOperation operation, unsigned status, const std::string& code, BoundWireKind& kind) {
	const bool enrollment =
		operation == BoundWireOperation::enrollment_challenge || operation == BoundWireOperation::exchange;
	if ((status == 503 && code == "temporarily_unavailable") || (status == 429 && code == "rate_limited")) {
		kind = BoundWireKind::retry;
		return true;
	}
	if ((operation == BoundWireOperation::renew_challenge || operation == BoundWireOperation::renew ||
		 operation == BoundWireOperation::exchange) &&
		status == 404 && code == "binding_unavailable") {
		kind = BoundWireKind::authority_denied;
		return true;
	}
	if (enrollment && status == 404 && code == "authorization_unavailable") {
		kind = BoundWireKind::authorization_unavailable;
		return true;
	}
	if (status == 403 && (code == "access_denied" || code == "device_retired" || code == "legacy_protocol_disabled")) {
		kind = BoundWireKind::authority_denied;
		return true;
	}
	if (status == 400 && (code == "invalid_request" || code == "unsupported_protocol")) {
		kind = BoundWireKind::request_rejected;
		return true;
	}
	if (operation != BoundWireOperation::renew && operation != BoundWireOperation::exchange) return false;
	if (operation == BoundWireOperation::exchange && status == 410 && code == "authorization_expired") {
		kind = BoundWireKind::authorization_unavailable;
		return true;
	}
	if (operation == BoundWireOperation::exchange && status == 409 && code == "device_limit_reached") {
		kind = BoundWireKind::conflict;
		return true;
	}
	if ((status == 410 && code == "challenge_expired") ||
		(status == 401 && (code == "invalid_proof" || code == "proof_required"))) {
		kind = BoundWireKind::retry;
		return true;
	}
	if (operation == BoundWireOperation::renew && status == 409 && code == "revision_conflict") {
		kind = BoundWireKind::authority_denied;
		return true;
	}
	if (status == 409 && code == "idempotency_conflict") {
		kind = BoundWireKind::conflict;
		return true;
	}
	return false;
}
template <class Input>
bool valid_proof(const Input& input, const BoundSignedProof& proof) {
	const auto& p = proof.prepared.proof;
	BoundPreparedProof expected;
	if (prepare_bound_proof_v2(input, {p.challenge_id, p.nonce, p.expires_at}, p.audience, proof.key_id, expected) !=
			LCC_DEVICE_OK ||
		expected.operation_digest != proof.prepared.operation_digest || expected.proof.path != p.path ||
		expected.proof.body_sha256 != p.body_sha256 || expected.proof.operation_id != p.operation_id)
		return false;
	std::vector<std::uint8_t> decoded;
	if (!bound_encoding::decode_base64url(proof.signature, 64, decoded) || decoded.size() != 64) return false;
	P256Signature signature;
	std::copy(decoded.begin(), decoded.end(), signature.begin());
	return p1363_signature_is_low_s(signature);
}
std::string proof_json(const BoundSignedProof& proof) {
	const auto& p = proof.prepared.proof;
	return "{\"key_id\":\"" + proof.key_id + "\",\"challenge_id\":\"" + p.challenge_id + "\",\"nonce\":\"" + p.nonce +
		   "\",\"expires_at\":" + std::to_string(p.expires_at) + ",\"signature\":\"" + proof.signature + "\"}";
}
void append(SensitiveVector& out, const std::string& text) {
	out.value.insert(out.value.end(), text.begin(), text.end());
}
void quoted(SensitiveVector& out, const std::string& text) {
	constexpr char hex[] = "0123456789abcdef";
	out.value.push_back('"');
	for (unsigned char c : text) {
		if (c == '"' || c == '\\') {
			out.value.push_back('\\');
			out.value.push_back(c);
		} else if (c < 32) {
			append(out, "\\u00");
			out.value.push_back(hex[c >> 4]);
			out.value.push_back(hex[c & 15]);
		} else
			out.value.push_back(c);
	}
	out.value.push_back('"');
}
bool device_label(const std::string& input, std::string& out) {
	if (!bound_encoding::utf8_text(input, 16384)) return false;
	// ECMAScript TrimString: WhiteSpace plus LineTerminator, matching the
	// backend's String.trim(). UTF-8 sequences are compared only at boundaries.
	static constexpr std::string_view spaces[]{
		"\x09",			"\x0a",			"\x0b",			"\x0c",			"\x0d",			" ",
		"\xc2\xa0",		"\xe1\x9a\x80", "\xe2\x80\x80", "\xe2\x80\x81", "\xe2\x80\x82", "\xe2\x80\x83",
		"\xe2\x80\x84", "\xe2\x80\x85", "\xe2\x80\x86", "\xe2\x80\x87", "\xe2\x80\x88", "\xe2\x80\x89",
		"\xe2\x80\x8a", "\xe2\x80\xa8", "\xe2\x80\xa9", "\xe2\x80\xaf", "\xe2\x81\x9f", "\xe3\x80\x80",
		"\xef\xbb\xbf"};
	std::string_view label(input);
	for (;;) {
		bool trimmed = false;
		for (const auto space : spaces)
			if (label.size() >= space.size() && label.substr(0, space.size()) == space) {
				label.remove_prefix(space.size());
				trimmed = true;
				break;
			}
		if (!trimmed) break;
	}
	for (;;) {
		bool trimmed = false;
		for (const auto space : spaces)
			if (label.size() >= space.size() && label.substr(label.size() - space.size()) == space) {
				label.remove_suffix(space.size());
				trimmed = true;
				break;
			}
		if (!trimmed) break;
	}
	if (label.empty() || label.size() > 320) return false;
	unsigned points = 0;
	for (unsigned char c : label)
		if ((c & 0xc0) != 0x80) ++points;
	if (points > 80) return false;
	out.assign(label);
	return true;
}
void lease_data(const Value& data, BoundWireResponse& out) {
	exact(data, {"device_id", "binding_id", "generation", "entitlement", "lease", "renew_after", "expires_at",
				 "accept_until"});
	require(bound_encoding::token(text(data, "device_id"), 16));  // not an authority claim
	out.lease = text(data, "lease");
	ParsedBoundLease parsed;
	require(decode_bound_lease(out.lease, parsed));
	const auto& claims = parsed.claims;
	require(text(data, "binding_id") == claims.binding_id && number(data, "generation") == claims.generation &&
			number(data, "renew_after") == claims.renew_after && number(data, "expires_at") == claims.expires_at &&
			number(data, "accept_until") == claims.expires_at + 120);
	const auto& entitlement = data.fields.at("entitlement");
	exact(entitlement, {"project", "feature", "license_fingerprint"});
	require(text(entitlement, "project") == claims.project && text(entitlement, "feature") == claims.feature &&
			text(entitlement, "license_fingerprint") == claims.license_fingerprint);
}
}  // namespace
bool normalize_bound_device_label(const std::string& input, std::string& out) noexcept {
	try {
		return device_label(input, out);
	} catch (...) {
		return false;
	}
}
bool encode_bound_authorization(const BoundAuthorizationInput& input, SensitiveVector& out) noexcept {
	try {
		std::string label;
		if (!bound_encoding::name(input.client_id) || !bound_encoding::name(input.project) ||
			!device_label(input.device_label, label) || !bound_encoding::loopback_uri(input.redirect_uri) ||
			!bound_encoding::token(input.state, 32) || !bound_encoding::token(input.code_challenge, 32))
			return false;
		std::vector<std::uint8_t> bytes;
		P256Spki canonical;
		if (!bound_encoding::decode_base64url(input.public_key_spki, 91, bytes) || bytes.size() != 91 ||
			!canonicalize_p256_spki(bytes.data(), bytes.size(), canonical) ||
			!std::equal(bytes.begin(), bytes.end(), canonical.begin()))
			return false;
		SensitiveVector candidate;
		candidate.value.reserve(16384);
		append(candidate, "{\"client_id\":");
		quoted(candidate, input.client_id);
		append(candidate, ",\"project\":");
		quoted(candidate, input.project);
		append(candidate, ",\"public_key_spki\":");
		quoted(candidate, input.public_key_spki);
		append(candidate, ",\"device_label\":");
		quoted(candidate, label);
		append(candidate, ",\"redirect_uri\":");
		quoted(candidate, input.redirect_uri);
		append(candidate, ",\"state\":");
		quoted(candidate, input.state);
		append(candidate, ",\"code_challenge\":");
		quoted(candidate, input.code_challenge);
		append(candidate, ",\"code_challenge_method\":\"S256\"}");
		out.value.swap(candidate.value);
		return true;
	} catch (...) {
		return false;
	}
}
bool encode_bound_renew_challenge(const BoundRenewInput& input, std::string& out) noexcept {
	try {
		SensitiveVector validated;
		if (!bound_operation_body_v1(input, validated)) return false;
		auto candidate = std::string("{\"purpose\":\"renew\",\"binding_id\":\"") + input.binding_id +
						 "\",\"operation_id\":\"" + input.operation_id + "\"}";
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
bool encode_bound_renew_request(const BoundRenewInput& input, const BoundSignedProof& proof,
								std::string& out) noexcept {
	try {
		if (!valid_proof(input, proof)) return false;
		// All serialized text has a validated delimiter-free ASCII alphabet.
		auto candidate = std::string("{\"binding_id\":\"") + input.binding_id +
						 "\",\"generation\":" + std::to_string(input.generation) + ",\"operation_id\":\"" +
						 input.operation_id + "\",\"proof\":" + proof_json(proof) + "}";
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
bool encode_bound_exchange_challenge(const BoundExchangeInput& input, SensitiveVector& out) noexcept {
	try {
		SensitiveVector validated;
		if (!bound_operation_body_v1(input, validated) || !bound_encoding::loopback_uri(input.redirect_uri))
			return false;
		SensitiveVector candidate;
		candidate.value.reserve(16384);
		append(candidate, "{\"purpose\":\"exchange\",\"attempt_handle\":\"");
		append(candidate, input.attempt_handle);
		append(candidate, "\",\"operation_id\":\"");
		append(candidate, input.operation_id);
		append(candidate, "\"}");
		out.value.swap(candidate.value);
		return true;
	} catch (...) {
		return false;
	}
}
bool encode_bound_exchange_request(const BoundExchangeInput& input, const BoundSignedProof& proof,
								   SensitiveVector& out) noexcept {
	try {
		if (!valid_proof(input, proof) || !bound_encoding::loopback_uri(input.redirect_uri)) return false;
		SensitiveVector candidate;
		candidate.value.reserve(16384);
		// Bounded validated ASCII fields cannot introduce JSON delimiters.
		append(candidate, "{\"attempt_handle\":\"");
		append(candidate, input.attempt_handle);
		append(candidate, "\",\"code\":\"");
		append(candidate, input.code);
		append(candidate, "\",\"code_verifier\":\"");
		append(candidate, input.code_verifier);
		append(candidate, "\",\"redirect_uri\":\"");
		append(candidate, input.redirect_uri);
		append(candidate, "\",\"operation_id\":\"");
		append(candidate, input.operation_id);
		append(candidate, "\",\"proof\":");
		append(candidate, proof_json(proof));
		append(candidate, "}");
		out.value.swap(candidate.value);
		return true;
	} catch (...) {
		return false;
	}
}
bool decode_bound_device_response(BoundWireOperation operation, unsigned status, const std::string& body,
								  BoundWireResponse& out) noexcept {
	try {
		if (operation != BoundWireOperation::renew_challenge && operation != BoundWireOperation::renew &&
			operation != BoundWireOperation::enrollment_challenge && operation != BoundWireOperation::exchange &&
			operation != BoundWireOperation::authorize)
			return false;
		Value root;
		if (!bound_json::parse(body, root)) return false;
		const auto& ok = root.fields.at("ok");
		require(ok.type == Value::Type::boolean);
		BoundWireResponse candidate;
		candidate.code = text(root, "code");
		candidate.request_id = text(root, "request_id");
		require(request_id(candidate.request_id));
		if (!ok.boolean) {
			exact(root, {"ok", "code", "request_id"});
			require(classify_error(operation, status, candidate.code, candidate.kind));
		} else {
			require(status == 200);
			exact(root, {"ok", "code", "request_id", "data"});
			const auto& data = root.fields.at("data");
			if (operation == BoundWireOperation::authorize) {
				require(candidate.code == "authorization_created");
				exact(data, {"attempt_handle", "authorization_url", "expires_at", "comparison_code"});
				candidate.attempt_handle = text(data, "attempt_handle");
				candidate.authorization_url = text(data, "authorization_url");
				candidate.comparison_code = text(data, "comparison_code");
				candidate.authorization_expires_at = number(data, "expires_at");
				require(bound_encoding::token(candidate.attempt_handle, 32) &&
						bound_encoding::utf8_text(candidate.authorization_url, 1083) &&
						candidate.authorization_expires_at > 0 && candidate.comparison_code.size() == 14);
				for (std::size_t i = 0; i < candidate.comparison_code.size(); ++i) {
					const char c = candidate.comparison_code[i];
					require(i == 4 || i == 9 ? c == '-' : ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')));
				}
				candidate.kind = BoundWireKind::registration;
			} else if (operation == BoundWireOperation::renew_challenge ||
					   operation == BoundWireOperation::enrollment_challenge) {
				require(candidate.code == "challenge_created");
				exact(data, {"challenge_id", "nonce", "expires_at"});
				candidate.challenge = {text(data, "challenge_id"), text(data, "nonce"), number(data, "expires_at")};
				require(bound_encoding::token(candidate.challenge.challenge_id, 16) &&
						bound_encoding::token(candidate.challenge.nonce, 32));
				candidate.kind = BoundWireKind::challenge;
			} else {
				require(candidate.code ==
						(operation == BoundWireOperation::exchange ? "device_activated" : "device_renewed"));
				lease_data(data, candidate);
				candidate.kind = BoundWireKind::lease;
			}
		}
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace device_identity
}  // namespace license
