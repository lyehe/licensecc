#include <licensecc/feature_session.h>
#include <stddef.h>
_Static_assert(offsetof(LccFeatureSessionOutcome, state) == 8, "state layout");
_Static_assert(offsetof(LccFeatureSessionOutcome, effective_time) == 32, "time layout");
_Static_assert(offsetof(LccFeatureSessionOutcome, renew_after) == 40, "renewal layout");
_Static_assert(offsetof(LccFeatureSessionOutcome, expires_at) == 48, "expiry layout");
_Static_assert(sizeof(LccFeatureSessionOutcome) == 56, "outcome layout");
_Static_assert(LCC_FEATURE_SESSION_STOPPED == 7, "state values");
_Static_assert(LCC_DEVICE_BOUND_VERSION == 1 && LCC_BOUND_INTERNAL_ERROR == 255, "existing ABI");
int feature_session_c_header_check(void) {
	LccFeatureSessionOutcome out;
	LccFeatureSession* session = NULL;
	lcc_init_feature_session_outcome(&out);
	if (out.size != sizeof(out) || out.version != 1 || out.state != LCC_FEATURE_SESSION_UNKNOWN) return 1;
	if (lcc_feature_session_open(NULL, &session, &out) != LCC_BOUND_INVALID_ARGUMENT) return 2;
	if (lcc_feature_session_start(NULL, &out) != LCC_BOUND_INVALID_ARGUMENT) return 3;
	if (lcc_feature_session_authorize(NULL, "BATCH_RUN", &out) != LCC_BOUND_INVALID_ARGUMENT) return 4;
	if (lcc_feature_session_renew(NULL, &out) != LCC_BOUND_INVALID_ARGUMENT) return 5;
	if (lcc_feature_session_stop(NULL, &out) != LCC_BOUND_INVALID_ARGUMENT) return 6;
	if (lcc_feature_session_save_checkpoint(NULL, &out) != LCC_BOUND_INVALID_ARGUMENT) return 7;
	lcc_feature_session_close(NULL);
	return 0;
}
