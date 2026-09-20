#ifndef LICENSECC_FEATURE_SESSION_H_
#define LICENSECC_FEATURE_SESSION_H_
#include "device_bound.h"

/** @defgroup featuresession Feature work-session authorization
 * One immutable feature and one logical job per handle. Open resumes an existing
 * enrollment without creating a key or restoring work authority. Start always
 * renews online and checks local authority before admitting the session. Call
 * authorize with the protected function's required-feature constant before each
 * protected unit, including its first unit and publication of protected results.
 * Calls are serialized by the application; overlap returns BUSY without changes.
 * Network operations belong on an application worker thread. No call opens a
 * browser, deletes a key, retires a binding or releases server capacity.
 * @{ */
#ifdef __cplusplus
extern "C" {
#endif

#define LCC_FEATURE_SESSION_VERSION 1u
typedef struct LccFeatureSession LccFeatureSession;

/** Advisory lifecycle snapshot; ACTIVE alone is never permission to do work. */
typedef enum LCC_FEATURE_SESSION_STATE {
	LCC_FEATURE_SESSION_UNKNOWN = 0,
	LCC_FEATURE_SESSION_READY = 1,
	LCC_FEATURE_SESSION_STARTING = 2,
	LCC_FEATURE_SESSION_ACTIVE = 3,
	LCC_FEATURE_SESSION_NEEDS_ONLINE = 4,
	LCC_FEATURE_SESSION_DENIED = 5,
	LCC_FEATURE_SESSION_FAILED = 6,
	LCC_FEATURE_SESSION_STOPPED = 7
} LCC_FEATURE_SESSION_STATE;

/** Initialize before use. Primary and checkpoint results are independent.
 * Precondition, size/version and admission-BUSY errors leave this unchanged.
 * Admitted calls initialize a fresh snapshot. Only successful start/authorize
 * report time fields, from the final verified native decision. Extended output
 * tails are preserved. Scheduling metadata never grants or extends permission.
 */
typedef struct LccFeatureSessionOutcome {
	uint32_t size;
	uint32_t version;
	uint32_t state;
	uint32_t provider_result;
	uint32_t checkpoint_result;
	uint32_t renewal_due;
	uint32_t reserved[2]; /**< Zero. */
	uint64_t effective_time;
	uint64_t renew_after;
	uint64_t expires_at;
} LccFeatureSessionOutcome;

void lcc_init_feature_session_outcome(LccFeatureSessionOutcome*);
/** Validate the existing device-bound options and resume the feature checkpoint.
 * Pass NULL in *out. Success returns READY, with no network or work authority.
 * Missing checkpoint requires explicit enrollment; missing keys and invalid
 * storage retain their provider/storage classifications and are never recreated.
 */
LCC_BOUND_RESULT lcc_feature_session_open(const LccDeviceBoundOptions*, LccFeatureSession** out,
										  LccFeatureSessionOutcome*);
/** Only READY/STARTING. Retry on this handle preserves any pending operation and
 * original clock anchor. OK admits this session after fresh renewal and a final
 * local check. ACTIVE and terminal handles cannot start again.
 */
LCC_BOUND_RESULT lcc_feature_session_start(LccFeatureSession*, LccFeatureSessionOutcome*);
/** No HTTP. required_feature is a bounded 1..15-character protocol name and must
 * equal the copied feature. A valid different feature denies this call without
 * poisoning the owner. Only OK permits the specified feature's next work unit.
 */
LCC_BOUND_RESULT lcc_feature_session_authorize(LccFeatureSession*, const char* required_feature,
											   LccFeatureSessionOutcome*);
/** Only an already-started ACTIVE/NEEDS_ONLINE session can renew. OK refreshes
 * state; authorize must still precede more work. Transient failures can retain
 * prior ACTIVE permission only until a subsequent local check rejects it.
 */
LCC_BOUND_RESULT lcc_feature_session_renew(LccFeatureSession*, LccFeatureSessionOutcome*);
/** Terminal, idempotent local shutdown. OK means authority is disabled; inspect
 * checkpoint_result separately. A capture failure returns INTERNAL_ERROR while
 * retaining disabled resources for explicit stop/save recovery before close.
 */
LCC_BOUND_RESULT lcc_feature_session_stop(LccFeatureSession*, LccFeatureSessionOutcome*);
/** Retry the exact native-owned authenticated statement, also after stop.
 * This performs no HTTP and cannot restore authority or change a terminal state.
 */
LCC_BOUND_RESULT lcc_feature_session_save_checkpoint(LccFeatureSession*, LccFeatureSessionOutcome*);
/** Exclusive ownership after concurrent calls have returned. NULL is accepted.
 * Releases resources without network or an implicit persistence retry.
 */
void lcc_feature_session_close(LccFeatureSession*);

#ifdef __cplusplus
}
#endif
/** @} */
#endif
