#include <licensecc/device_bound.h>
#include <stddef.h>
typedef char bound_outcome_layout[(offsetof(LccDeviceBoundOutcome, effective_time) == 24) ? 1 : -1];
typedef char bound_trust_layout[(sizeof(LccDeviceBoundTrustKey) == 520) ? 1 : -1];
int bound_public_c_header_check(void) {
	LccDeviceBoundOptions options;
	LccDeviceBoundOutcome outcome;
	LccDeviceBoundView view;
	lcc_init_device_bound_options(&options);
	lcc_init_device_bound_outcome(&outcome);
	lcc_init_device_bound_view(&view);
	return options.version != 1 || outcome.size != sizeof(outcome) || view.size != sizeof(view);
}
