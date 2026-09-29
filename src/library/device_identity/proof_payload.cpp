#include "device_key_provider.hpp"

#include <string>
#include <utility>

namespace license {
namespace device_identity {
namespace {

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

}  // namespace device_identity
}  // namespace license
