#include "AntiTamper.hpp"

#include <licensecc/licensecc.h>

#include <cstddef>
#include <exception>

#include "../base/EventRegistry.h"
#include "../base/string_utils.h"

namespace license {
namespace anti_tamper {
namespace {

const uint32_t kSupportedFlags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;
const char kHostIntegrityReference[] = "HostIntegrityCheck";
const char kSourceShadowingPrefix[] = "source-shadowing";

void init_default_options(LicenseCheckOptions& options) {
	// Single source of truth for the secure defaults: delegate to the public
	// initializer so this internal default cannot drift from
	// lcc_init_license_check_options().
	lcc_init_license_check_options(&options);
}

std::string bounded_detail_or_default(const char* detail, const char* fallback) {
	if (detail == nullptr || detail[0] == '\0') {
		return fallback;
	}
	return std::string(detail);
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

	if (options->size != sizeof(LicenseCheckOptions)) {
		error = "invalid LicenseCheckOptions size";
		return false;
	}
	if (options->version != LCC_LICENSE_CHECK_OPTIONS_VERSION) {
		error = "invalid LicenseCheckOptions version";
		return false;
	}
	normalized = *options;

	if (normalized.tamper_policy != LCC_TAMPER_DISABLED && normalized.tamper_policy != LCC_TAMPER_ENFORCE) {
		error = "invalid tamper policy";
		return false;
	}
	if ((normalized.tamper_flags & ~kSupportedFlags) != 0) {
		error = "unsupported tamper flags";
		return false;
	}
	return true;
}

const AuditEvent* find_source_shadowing_signal(const EventRegistry& event_registry) {
	const LCC_EVENT_TYPE source_shadowing_events[] = {LICENSE_MALFORMED,	FILE_FORMAT_NOT_RECOGNIZED,
													  LICENSE_CORRUPTED, IDENTIFIERS_MISMATCH,
													  PRODUCT_EXPIRED,	PRODUCT_NOT_LICENSED};
	for (const LCC_EVENT_TYPE event_type : source_shadowing_events) {
		const AuditEvent* event = event_registry.getLastEventOfType(event_type);
		if (event != nullptr) {
			return event;
		}
	}
	return nullptr;
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
