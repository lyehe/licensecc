#include "device_key_provider.hpp"

#include <charconv>
#include <cstring>
#include <limits>
#include <string>
#include <utility>

namespace license {
namespace device_identity {
namespace {

template <std::size_t N>
bool fixed_string(const char (&value)[N], std::string& out) {
	const void* terminator = std::memchr(value, '\0', N);
	if (terminator == nullptr) {
		return false;
	}
	const char* end = static_cast<const char*>(terminator);
	out.assign(value, end);
	return true;
}

bool is_application_id(const std::string& value) {
	if (value.empty() || value.size() > LCC_DEVICE_APPLICATION_ID_MAX ||
		!((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= '0' && value[0] <= '9'))) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-')) {
			return false;
		}
	}
	return true;
}

bool is_proof_name(const std::string& value, std::size_t maximum) {
	if (value.empty() || value.size() > maximum) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' ||
			  ch == '.' || ch == ':' || ch == '-')) {
			return false;
		}
	}
	return true;
}

bool is_lower_hex(const std::string& value, bool allow_empty) {
	if (value.empty()) {
		return allow_empty;
	}
	if (value.size() != 64U) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) {
			return false;
		}
	}
	return true;
}

bool is_device_key_id(const std::string& value) {
	return value.size() == LCC_DEVICE_KEY_ID_MAX && value.compare(0U, 7U, "sha256:") == 0 &&
		   is_lower_hex(value.substr(7U), false);
}

template <typename Integer>
bool append_decimal(std::string& target, Integer value) {
	char buffer[32];
	const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), value);
	if (converted.ec != std::errc()) {
		return false;
	}
	target.append(buffer, converted.ptr);
	return true;
}

}  // namespace

bool derive_namespace_v1(const std::string& application_id, const std::string& project, std::uint32_t scope,
						 DeviceNamespace& out) noexcept {
	try {
		if (!is_application_id(application_id) || !is_proof_name(project, LCC_API_ONLINE_PROJECT_SIZE) ||
			(scope != LCC_DEVICE_SCOPE_USER && scope != LCC_DEVICE_SCOPE_MACHINE)) {
			return false;
		}
		DeviceNamespace candidate;
		candidate.payload.reserve(64U + application_id.size() + project.size());
		candidate.payload.append("licensecc-device-key-namespace-v1\napplication-id=");
		candidate.payload.append(application_id);
		candidate.payload.append("\nproject=");
		candidate.payload.append(project);
		candidate.payload.append("\nscope=");
		candidate.payload.append(scope == LCC_DEVICE_SCOPE_USER ? "user\n" : "machine\n");
		SensitiveArray<32> digest;
		if (!sha256(reinterpret_cast<const std::uint8_t*>(candidate.payload.data()), candidate.payload.size(),
					digest.value)) {
			return false;
		}
		candidate.hash = lowercase_hex(digest.value.data(), digest.value.size());
		if (candidate.hash.size() != 64U) {
			return false;
		}
		candidate.windows_name = "licensecc-v1-" + candidate.hash;
		candidate.linux_filename = candidate.windows_name + ".tss2.pem";
		candidate.lock_name = candidate.linux_filename + ".lock";
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}

LCC_DEVICE_RESULT build_request_proof_payload_v1(const LccDeviceProofInput& input, const std::string& key_id,
												 std::vector<std::uint8_t>& out) noexcept {
	try {
		if (input.size < sizeof(LccDeviceProofInput)) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}
		if (input.version != LCC_DEVICE_PROOF_VERSION) {
			return LCC_DEVICE_UNSUPPORTED_VERSION;
		}
		const char* purpose = nullptr;
		switch (input.audience) {
			case LCC_DEVICE_PROOF_AUDIENCE_VERIFY:
				purpose = "licensecc-online-request";
				break;
			case LCC_DEVICE_PROOF_AUDIENCE_LEASE:
				purpose = "licensecc-lease-request";
				break;
			case LCC_DEVICE_PROOF_AUDIENCE_SEAT:
				purpose = "licensecc-seat-request";
				break;
			default:
				return LCC_DEVICE_INVALID_ARGUMENT;
		}
		if (input.client_hardening > 0xffffU || input.request_timestamp > 9007199254740991ULL ||
			!is_device_key_id(key_id)) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}

		std::string project;
		std::string feature;
		std::string license_fingerprint;
		std::string device_hash;
		std::string nonce;
		if (!fixed_string(input.project, project) || !fixed_string(input.feature, feature) ||
			!fixed_string(input.license_fingerprint, license_fingerprint) ||
			!fixed_string(input.device_hash, device_hash) || !fixed_string(input.nonce, nonce) ||
			!is_proof_name(project, LCC_API_ONLINE_PROJECT_SIZE) ||
			!is_proof_name(feature, LCC_API_FEATURE_NAME_SIZE) || !is_lower_hex(license_fingerprint, false) ||
			!is_lower_hex(device_hash, true) || !is_lower_hex(nonce, false)) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}

		std::string payload;
		payload.reserve(384U + project.size() + feature.size());
		payload.append("purpose=").append(purpose);
		payload.append("\nversion=1\nalg=ecdsa-p256-sha256\nproject=").append(project);
		payload.append("\nfeature=").append(feature);
		payload.append("\nlicense-fingerprint=").append(license_fingerprint);
		payload.append("\ndevice-hash=").append(device_hash);
		payload.append("\nnonce=").append(nonce);
		payload.append("\nrequest-timestamp=");
		if (!append_decimal(payload, input.request_timestamp)) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		payload.append("\nclient-hardening=");
		if (!append_decimal(payload, input.client_hardening)) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		payload.append("\ndevice-key-id=").append(key_id).push_back('\n');
		std::vector<std::uint8_t> candidate(payload.begin(), payload.end());
		out.swap(candidate);
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

}  // namespace device_identity
}  // namespace license
