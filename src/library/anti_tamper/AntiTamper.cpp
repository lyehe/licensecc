#include "AntiTamper.hpp"

#include <cctype>
#include <cstddef>
#include <exception>

#include "../base/EventRegistry.h"
#include "../base/string_utils.h"

namespace license {
namespace anti_tamper {
namespace {

const uint32_t kSupportedFlags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;
const uint32_t kSupportedOnlineFlags = LCC_ONLINE_FLAG_NONE;
const uint32_t kOptionsVersionV1 = 1;
const char kHostIntegrityReference[] = "HostIntegrityCheck";
const char kSourceShadowingPrefix[] = "source-shadowing";

#define LCC_OPTIONS_FIELD_PRESENT(options, field) \
	((options).size >= offsetof(LicenseCheckOptions, field) + sizeof((options).field))

void init_default_options(LicenseCheckOptions& options) {
	options = LicenseCheckOptions{};
	options.size = sizeof(LicenseCheckOptions);
	options.version = LCC_LICENSE_CHECK_OPTIONS_VERSION;
	options.tamper_policy = LCC_TAMPER_ENFORCE;
	options.tamper_flags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;
	options.host_integrity_check = nullptr;
	options.host_integrity_user_data = nullptr;
	options.online_policy = LCC_ONLINE_DISABLED;
	options.online_flags = LCC_ONLINE_FLAG_NONE;
	options.online_timeout_ms = LCC_ONLINE_DEFAULT_TIMEOUT_MS;
	options.online_check = nullptr;
	options.online_user_data = nullptr;
	options.online_device_hash[0] = '\0';
}

std::string bounded_detail_or_default(const char* detail, const char* fallback) {
	if (detail == nullptr || detail[0] == '\0') {
		return fallback;
	}
	return std::string(detail);
}

bool is_hex_string(const char* value, const size_t size) {
	for (size_t i = 0; i < size; ++i) {
		if (!std::isxdigit(static_cast<unsigned char>(value[i]))) {
			return false;
		}
	}
	return true;
}

void add_host_integrity_signal(const AntiTamperRequest& request, AntiTamperResult& result) {
	if (request.host_integrity_check == nullptr) {
		return;
	}

	char detail[LCC_API_AUDIT_EVENT_PARAM2 + 1] = {};
	bool ok = false;
	try {
		ok = request.host_integrity_check(request.host_integrity_user_data, detail, sizeof(detail));
		detail[sizeof(detail) - 1] = '\0';
	} catch (const std::exception& ex) {
		license::mstrlcpy(detail, ex.what(), sizeof(detail));
		detail[sizeof(detail) - 1] = '\0';
		ok = false;
	} catch (...) {
		license::mstrlcpy(detail, "host integrity callback threw", sizeof(detail));
		detail[sizeof(detail) - 1] = '\0';
		ok = false;
	}

	if (!ok) {
		result.signals.push_back({kHostIntegrityReference,
								  bounded_detail_or_default(detail, "host integrity check failed")});
	}
}

void add_source_shadowing_signal(const AntiTamperRequest& request, AntiTamperResult& result) {
	if ((request.flags & LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING) == 0 ||
		request.source_shadowing_event == nullptr) {
		return;
	}

	const AuditEvent& event = *request.source_shadowing_event;
	std::string detail(kSourceShadowingPrefix);
	if (event.param2[0] != '\0') {
		detail += ": ";
		detail += event.param2;
	}
	result.signals.push_back({event.license_reference, detail});
}

}  // namespace

bool AntiTamperResult::detected() const {
	return !signals.empty();
}

LCC_SEVERITY AntiTamperResult::severity() const {
	return SVRT_ERROR;
}

AntiTamperPolicy to_internal_policy(LCC_TAMPER_POLICY policy) {
	switch (policy) {
		case LCC_TAMPER_DISABLED:
			return AntiTamperPolicy::Disabled;
		case LCC_TAMPER_ENFORCE:
			return AntiTamperPolicy::Enforce;
		default:
			return AntiTamperPolicy::Enforce;
	}
}

bool normalize_options(const LicenseCheckOptions* options, LicenseCheckOptions& normalized, std::string& error) {
	init_default_options(normalized);
	if (options == nullptr) {
		return true;
	}

	const size_t v1_size = offsetof(LicenseCheckOptions, online_policy);
	if (options->size < v1_size || options->size > sizeof(LicenseCheckOptions)) {
		error = "invalid LicenseCheckOptions size";
		return false;
	}
	if (options->version != kOptionsVersionV1 && options->version != LCC_LICENSE_CHECK_OPTIONS_VERSION) {
		error = "invalid LicenseCheckOptions version";
		return false;
	}
	if (LCC_OPTIONS_FIELD_PRESENT(*options, tamper_policy)) {
		normalized.tamper_policy = options->tamper_policy;
	}
	if (LCC_OPTIONS_FIELD_PRESENT(*options, tamper_flags)) {
		normalized.tamper_flags = options->tamper_flags;
	}
	if (LCC_OPTIONS_FIELD_PRESENT(*options, host_integrity_check)) {
		normalized.host_integrity_check = options->host_integrity_check;
	}
	if (LCC_OPTIONS_FIELD_PRESENT(*options, host_integrity_user_data)) {
		normalized.host_integrity_user_data = options->host_integrity_user_data;
	}
	const bool include_online_fields = options->version >= LCC_LICENSE_CHECK_OPTIONS_VERSION;
	if (include_online_fields && LCC_OPTIONS_FIELD_PRESENT(*options, online_policy)) {
		normalized.online_policy = options->online_policy;
	}
	if (include_online_fields && LCC_OPTIONS_FIELD_PRESENT(*options, online_flags)) {
		normalized.online_flags = options->online_flags;
	}
	if (include_online_fields && LCC_OPTIONS_FIELD_PRESENT(*options, online_timeout_ms)) {
		normalized.online_timeout_ms = options->online_timeout_ms;
	}
	if (include_online_fields && LCC_OPTIONS_FIELD_PRESENT(*options, online_check)) {
		normalized.online_check = options->online_check;
	}
	if (include_online_fields && LCC_OPTIONS_FIELD_PRESENT(*options, online_user_data)) {
		normalized.online_user_data = options->online_user_data;
	}
	if (include_online_fields && LCC_OPTIONS_FIELD_PRESENT(*options, online_device_hash)) {
		license::mstrlcpy(normalized.online_device_hash, options->online_device_hash,
						   sizeof(normalized.online_device_hash));
	}
	normalized.size = sizeof(LicenseCheckOptions);
	normalized.version = LCC_LICENSE_CHECK_OPTIONS_VERSION;

	if (normalized.tamper_policy != LCC_TAMPER_DISABLED && normalized.tamper_policy != LCC_TAMPER_ENFORCE) {
		error = "invalid tamper policy";
		return false;
	}
	if ((normalized.tamper_flags & ~kSupportedFlags) != 0) {
		error = "unsupported tamper flags";
		return false;
	}
	if (normalized.online_policy != LCC_ONLINE_DISABLED && normalized.online_policy != LCC_ONLINE_REQUIRE) {
		error = "invalid online policy";
		return false;
	}
	if (normalized.online_policy == LCC_ONLINE_DISABLED && normalized.online_check != nullptr) {
		normalized.online_policy = LCC_ONLINE_REQUIRE;
	}
	if ((normalized.online_flags & ~kSupportedOnlineFlags) != 0) {
		error = "unsupported online flags";
		return false;
	}
	if (normalized.online_timeout_ms == 0 || normalized.online_timeout_ms > LCC_ONLINE_MAX_TIMEOUT_MS) {
		error = "invalid online timeout";
		return false;
	}
	if (normalized.online_policy != LCC_ONLINE_DISABLED && normalized.online_check == nullptr) {
		error = "online policy requires callback";
		return false;
	}
	if (license::mstrnlen_s(normalized.online_device_hash, sizeof(normalized.online_device_hash)) ==
		sizeof(normalized.online_device_hash)) {
		error = "online device hash is not NUL-terminated";
		return false;
	}
	const size_t online_device_hash_size =
		license::mstrnlen_s(normalized.online_device_hash, sizeof(normalized.online_device_hash));
	if (online_device_hash_size != 0 &&
		(online_device_hash_size != LCC_API_ONLINE_DEVICE_HASH_SIZE ||
		 !is_hex_string(normalized.online_device_hash, online_device_hash_size))) {
		error = "invalid online device hash";
		return false;
	}
	return true;
}

const AuditEvent* find_source_shadowing_signal(const EventRegistry& event_registry) {
	const AuditEvent* malformed = event_registry.getLastEventOfType(LICENSE_MALFORMED);
	if (malformed != nullptr) {
		return malformed;
	}
	return event_registry.getLastEventOfType(FILE_FORMAT_NOT_RECOGNIZED);
}

AntiTamperResult evaluate(const AntiTamperRequest& request) {
	AntiTamperResult result;
	result.policy = request.policy;
	if (request.policy == AntiTamperPolicy::Disabled) {
		return result;
	}

	add_host_integrity_signal(request, result);
	add_source_shadowing_signal(request, result);
	return result;
}

void append_audit_events(const AntiTamperResult& result, EventRegistry& event_registry) {
	for (const AntiTamperSignal& signal : result.signals) {
		event_registry.addEventWithSeverity(result.severity(), LICENSE_TAMPER_DETECTED,
											signal.license_reference.c_str(), signal.detail.c_str());
	}
}

}  // namespace anti_tamper
}  // namespace license
