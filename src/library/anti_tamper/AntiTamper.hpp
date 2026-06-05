#ifndef LICENSECC_ANTI_TAMPER_HPP_
#define LICENSECC_ANTI_TAMPER_HPP_

#include <licensecc/datatypes.h>

#include <stdint.h>
#include <string>
#include <vector>

namespace license {
class EventRegistry;

namespace anti_tamper {

enum class AntiTamperPolicy {
	Disabled,
	Enforce
};

struct AntiTamperRequest {
	AntiTamperPolicy policy;
	uint32_t flags;
	LCC_HOST_INTEGRITY_CHECK host_integrity_check;
	void* host_integrity_user_data;
	const AuditEvent* source_shadowing_event;
};

struct AntiTamperSignal {
	std::string license_reference;
	std::string detail;
};

struct AntiTamperResult {
	AntiTamperPolicy policy;
	std::vector<AntiTamperSignal> signals;

	bool detected() const;
	LCC_SEVERITY severity() const;
};

bool normalize_options(const LicenseCheckOptions* options, LicenseCheckOptions& normalized, std::string& error);
AntiTamperPolicy to_internal_policy(LCC_TAMPER_POLICY policy);
const AuditEvent* find_source_shadowing_signal(const EventRegistry& event_registry);
AntiTamperResult evaluate(const AntiTamperRequest& request);
void append_audit_events(const AntiTamperResult& result, EventRegistry& event_registry);

}  // namespace anti_tamper
}  // namespace license

#endif
