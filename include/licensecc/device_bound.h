#ifndef LICENSECC_DEVICE_BOUND_H_
#define LICENSECC_DEVICE_BOUND_H_
#include "device_identity.h"

/** @defgroup devicebound Device-bound desktop licensing
 * Windows user-scoped, hardware-required enrollment and current-process access.
 * No result from open, enrollment, renewal or storage grants permission to run
 * protected work: call lcc_device_bound_authorize immediately before that work.
 * Handles require exclusive ownership at close; other calls return BUSY on overlap.
 * Blocking network and shell operations belong on an application worker thread.
 * No call silently deletes a key, retires a binding or falls back to legacy.
 * @{ */
#ifdef __cplusplus
extern "C" {
#endif

#define LCC_DEVICE_BOUND_VERSION 1u
#define LCC_DEVICE_BOUND_TRUST_MAX 8u
#define LCC_DEVICE_BOUND_SPKI_MAX 512u

typedef struct LccDeviceBoundClient LccDeviceBoundClient;

/** Stable operation results. OK grants access ONLY from authorize. */
typedef enum LCC_BOUND_RESULT {
	LCC_BOUND_OK = 0,
	LCC_BOUND_INVALID_ARGUMENT = 1,
	LCC_BOUND_UNSUPPORTED_VERSION = 2,
	LCC_BOUND_UNSUPPORTED_PLATFORM = 3,
	LCC_BOUND_BUSY = 4,
	LCC_BOUND_INVALID_STATE = 5,
	LCC_BOUND_RETRY = 6,
	LCC_BOUND_CONFLICT = 7,
	LCC_BOUND_DENIED = 8,
	LCC_BOUND_EXPIRED = 9,
	LCC_BOUND_WAITING = 10,
	LCC_BOUND_CALLBACK_REJECTED = 11,
	LCC_BOUND_CALLBACK_RECEIVED = 12,
	LCC_BOUND_ENROLLMENT_REQUIRED = 13,
	LCC_BOUND_ONLINE_REQUIRED = 14,
	LCC_BOUND_RESUME_REQUIRED = 15,
	LCC_BOUND_INVALID_RESPONSE = 16,
	LCC_BOUND_PROVIDER_ERROR = 17,
	LCC_BOUND_STORAGE_ERROR = 18,
	LCC_BOUND_BROWSER_UNAVAILABLE = 19,
	LCC_BOUND_CANCELLED = 20,
	LCC_BOUND_INTERNAL_ERROR = 255
} LCC_BOUND_RESULT;

/** Independent persistence outcome; never an access decision. */
typedef enum LCC_BOUND_CHECKPOINT_RESULT {
	LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED = 0,
	LCC_BOUND_CHECKPOINT_SAVED = 1,
	LCC_BOUND_CHECKPOINT_UNCHANGED = 2,
	LCC_BOUND_CHECKPOINT_MISSING = 3,
	LCC_BOUND_CHECKPOINT_BUSY = 4,
	LCC_BOUND_CHECKPOINT_STALE = 5,
	LCC_BOUND_CHECKPOINT_CONFLICT = 6,
	LCC_BOUND_CHECKPOINT_INVALID = 7,
	LCC_BOUND_CHECKPOINT_IO_ERROR = 8,
	LCC_BOUND_CHECKPOINT_MIRROR_PENDING = 9,
	LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN = 10,
	LCC_BOUND_CHECKPOINT_LOADED = 11
} LCC_BOUND_CHECKPOINT_RESULT;

/** Canonical DER RSA-3072 public signing key; no private key or token-selected key. */
typedef struct LccDeviceBoundTrustKey {
	uint32_t spki_size; /**< Number of DER bytes, at most SPKI_MAX. */
	uint32_t retired; /**< Zero for active, one for retired. */
	uint8_t spki[LCC_DEVICE_BOUND_SPKI_MAX];
} LccDeviceBoundTrustKey;

/** All strings are bounded NUL-terminated UTF-8; copied during open.
 * Policy is fixed to hardware-required and current-user scope. No storage-root,
 * software-provider, caller clock, transport or response override is exposed.
 */
typedef struct LccDeviceBoundOptions {
	uint32_t size;
	uint32_t version;
	uint32_t trust_key_count;
	uint32_t reserved; /**< Must be zero. */
	char application_id[129]; /**< Stable lowercase provider namespace. */
	char endpoint_origin[1025]; /**< Canonical HTTPS DNS origin, no path. */
	char portal_authorization_url[1025]; /**< Fixed HTTPS consent path. */
	char issuer[1025];
	char lease_audience[1025];
	char proof_audience[1025];
	char project[128];
	char feature[16];
	char client_id[128];
	char device_label[321]; /**< At most 80 Unicode code points after trimming. */
	char callback_path[256]; /**< Registered loopback path; default /callback. */
	LccDeviceBoundTrustKey trust_keys[LCC_DEVICE_BOUND_TRUST_MAX];
} LccDeviceBoundOptions;

/** Prepared native comparison. Display and flush it before calling launch.
 * No secret callback code, attempt handle or PKCE value is returned.
 */
typedef struct LccDeviceBoundView {
	uint32_t size;
	uint32_t version;
	uint64_t expires_at; /**< Display metadata, never a local authorization clock. */
	char comparison_code[15]; /**< XXXX-XXXX-XXXX plus NUL. */
} LccDeviceBoundView;

/** Additional result details. Initialize before each call.
 * Primary return and checkpoint_result must be handled independently. Activation,
 * renewal and abandonment attempt to save every available authenticated statement,
 * even after a provider or clock failure. Retry persistence with save_checkpoint.
 */
typedef struct LccDeviceBoundOutcome {
	uint32_t size;
	uint32_t version;
	uint32_t provider_result; /**< LCC_DEVICE_RESULT. */
	uint32_t checkpoint_result; /**< LCC_BOUND_CHECKPOINT_RESULT. */
	uint32_t renewal_due; /**< Scheduling hint, not permission. */
	uint32_t reserved;
	uint64_t effective_time; /**< Only authorize reports an effective lease time. */
} LccDeviceBoundOutcome;

void lcc_init_device_bound_options(LccDeviceBoundOptions*);
void lcc_init_device_bound_view(LccDeviceBoundView*);
void lcc_init_device_bound_outcome(LccDeviceBoundOutcome*);

/** Explicit enrollment may create a missing key only when both checkpoint slots
 * are absent. Existing state returns RESUME_REQUIRED and is never overwritten.
 * Pass a NULL handle in *out. The handle remains unchanged on failure; admitted
 * open failures populate outcome. Options/outcome are checked before
 * side effects. No network request is made by open.
 */
LCC_BOUND_RESULT lcc_device_bound_open_enrollment(const LccDeviceBoundOptions*, LccDeviceBoundClient** out,
												  LccDeviceBoundOutcome*);
/** Open existing key and authenticated checkpoint. Requires fresh online renewal;
 * never restores offline permission or automatically creates a missing key.
 */
LCC_BOUND_RESULT lcc_device_bound_open_resume(const LccDeviceBoundOptions*, LccDeviceBoundClient** out,
											  LccDeviceBoundOutcome*);
/** Start the listener's five-minute lifetime and register, or retry the same attempt. Fixed-size output is validated
 * before I/O and unchanged on failure; there is no network-active sizing query.
 */
LCC_BOUND_RESULT lcc_device_bound_prepare(LccDeviceBoundClient*, LccDeviceBoundView*);
/** Submit the prepared URL to the system browser after native comparison display. */
LCC_BOUND_RESULT lcc_device_bound_launch(LccDeviceBoundClient*);
/** Poll the owned listener, wait_ms 0..1000. Rejected callbacks leave it usable. */
LCC_BOUND_RESULT lcc_device_bound_poll(LccDeviceBoundClient*, uint32_t wait_ms);
LCC_BOUND_RESULT lcc_device_bound_activate(LccDeviceBoundClient*, LccDeviceBoundOutcome*);
LCC_BOUND_RESULT lcc_device_bound_renew(LccDeviceBoundClient*, LccDeviceBoundOutcome*);
/** Fresh local key-possession and current-process lease check. Only OK permits work. */
LCC_BOUND_RESULT lcc_device_bound_authorize(LccDeviceBoundClient*, LccDeviceBoundOutcome*);
/** Retry saving the owner's exact signed statement; accepts no caller bytes. */
LCC_BOUND_RESULT lcc_device_bound_save_checkpoint(LccDeviceBoundClient*, LccDeviceBoundOutcome*);
/** Abandon unresolved local issuance; does not undo a possible server allocation. */
LCC_BOUND_RESULT lcc_device_bound_abandon_pending(LccDeviceBoundClient*, LccDeviceBoundOutcome*);
/** Terminal local authority shutdown; never deletes the device key. If checkpoint
 * capture fails, authority is still disabled and INTERNAL_ERROR means cleanup is
 * pending. BUSY means another public operation owns the handle and no state changed. Retry cancel
 * or save_checkpoint to recover the statement and finish cleanup before close.
 */
LCC_BOUND_RESULT lcc_device_bound_cancel(LccDeviceBoundClient*);
/** Close only after all concurrent calls have returned. NULL is allowed. */
void lcc_device_bound_close(LccDeviceBoundClient*);

#ifdef __cplusplus
}
#endif
/** @} */
#endif
