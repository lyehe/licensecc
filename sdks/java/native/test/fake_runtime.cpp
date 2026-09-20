// Test-only native boundary fixture. Not linked to the runtime, installed or shipped.
#include <jni.h>
#include <licensecc/device_bound.h>
#include <cstdlib>
#include <cstring>
#include <cstdint>

struct LccDeviceBoundClient {
	bool alive = false;
};
namespace {
LccDeviceBoundClient client;
int mode = 0;
int closes = 0;
int last_operation = -1;
void require(bool condition) {
	if (!condition) std::abort();
}
LCC_BOUND_RESULT call(LccDeviceBoundClient* handle, int operation, LccDeviceBoundOutcome* details) {
	require(handle == &client && client.alive);
	last_operation = operation;
	if (details) {
		lcc_init_device_bound_outcome(details);
		details->renewal_due = 1;
		details->checkpoint_result = LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN;
		details->effective_time = UINT64_MAX;
	}
	return LCC_BOUND_OK;
}
}  // namespace
void lcc_jni_test_publication(JNIEnv* env, bool committed) {
	if ((mode == 1 && !committed) || (mode == 2 && committed)) {
		auto type = env->FindClass("java/lang/OutOfMemoryError");
		if (type) {
			env->ThrowNew(type, "synthetic native publication failure");
			env->DeleteLocalRef(type);
		}
	}
}
extern "C" JNIEXPORT jint JNICALL Java_io_licensecc_client_DeviceBoundFixtureTest_control(JNIEnv*, jclass, jint value) {
	if (value == -1) return closes;
	if (value == -2) return last_operation;
	require(!client.alive);
	mode = value;
	closes = 0;
	last_operation = -1;
	return 0;
}
extern "C" {
void lcc_init_device_bound_options(LccDeviceBoundOptions* value) {
	std::memset(value, 0, sizeof(*value));
	value->size = sizeof(*value);
	value->version = 1;
}
void lcc_init_device_bound_view(LccDeviceBoundView* value) {
	std::memset(value, 0, sizeof(*value));
	value->size = sizeof(*value);
	value->version = 1;
}
void lcc_init_device_bound_outcome(LccDeviceBoundOutcome* value) {
	std::memset(value, 0, sizeof(*value));
	value->size = sizeof(*value);
	value->version = 1;
}
LCC_BOUND_RESULT lcc_device_bound_open_enrollment(const LccDeviceBoundOptions* options, LccDeviceBoundClient** out,
												  LccDeviceBoundOutcome* details) {
	require(!client.alive && *out == nullptr);
	require(options->size == sizeof(*options) && options->version == 1 && options->reserved == 0 &&
			options->trust_key_count == 1);
	require(options->trust_keys[0].spki_size == 1 && options->trust_keys[0].spki[0] == 1 &&
			options->trust_keys[0].retired == 0);
	require(std::strcmp(options->device_label, "\xF0\x9F\x9A\x80") == 0);
	client.alive = true;
	*out = &client;
	lcc_init_device_bound_outcome(details);
	if (mode == 3) details->reserved = 1;
	return LCC_BOUND_OK;
}
LCC_BOUND_RESULT lcc_device_bound_open_resume(const LccDeviceBoundOptions* options, LccDeviceBoundClient** out,
											  LccDeviceBoundOutcome* details) {
	last_operation = 10;
	return lcc_device_bound_open_enrollment(options, out, details);
}
LCC_BOUND_RESULT lcc_device_bound_prepare(LccDeviceBoundClient* handle, LccDeviceBoundView* view) {
	call(handle, 5, nullptr);
	lcc_init_device_bound_view(view);
	view->expires_at = UINT64_MAX;
	std::memcpy(view->comparison_code, "ABCD-1234-FFFF", 15);
	return LCC_BOUND_OK;
}
LCC_BOUND_RESULT lcc_device_bound_activate(LccDeviceBoundClient* handle, LccDeviceBoundOutcome* out) {
	return call(handle, 0, out);
}
LCC_BOUND_RESULT lcc_device_bound_renew(LccDeviceBoundClient* handle, LccDeviceBoundOutcome* out) {
	return call(handle, 1, out);
}
LCC_BOUND_RESULT lcc_device_bound_authorize(LccDeviceBoundClient* handle, LccDeviceBoundOutcome* out) {
	return call(handle, 2, out);
}
LCC_BOUND_RESULT lcc_device_bound_save_checkpoint(LccDeviceBoundClient* handle, LccDeviceBoundOutcome* out) {
	return call(handle, 3, out);
}
LCC_BOUND_RESULT lcc_device_bound_abandon_pending(LccDeviceBoundClient* handle, LccDeviceBoundOutcome* out) {
	return call(handle, 4, out);
}
LCC_BOUND_RESULT lcc_device_bound_launch(LccDeviceBoundClient* handle) { return call(handle, 6, nullptr); }
LCC_BOUND_RESULT lcc_device_bound_poll(LccDeviceBoundClient* handle, std::uint32_t wait) {
	require(wait == 1000);
	return call(handle, 7, nullptr);
}
LCC_BOUND_RESULT lcc_device_bound_cancel(LccDeviceBoundClient* handle) { return call(handle, 8, nullptr); }
void lcc_device_bound_close(LccDeviceBoundClient* handle) {
	if (!handle) return;
	require(handle == &client && client.alive);
	client.alive = false;
	++closes;
}
}
