#include <jni.h>
#include <licensecc/device_bound.h>
#include <licensecc/feature_session.h>
#include <cstdint>
#include <cstddef>
#include <cstring>

#ifdef LCC_JNI_TEST_FIXTURE
void lcc_jni_test_publication(JNIEnv*, bool);
#endif

namespace {
static_assert(sizeof(void*) == sizeof(jlong), "The JNI adapter requires x64");
static_assert(LCC_DEVICE_BOUND_VERSION == 1 && LCC_DEVICE_BOUND_TRUST_MAX == 8 && LCC_DEVICE_BOUND_SPKI_MAX == 512,
			  "Review JNI marshaling before changing the public C contract");

void invalid(JNIEnv* env, const char* message) {
	if (env->ExceptionCheck()) return;
	auto type = env->FindClass("java/lang/IllegalStateException");
	if (type) {
		env->ThrowNew(type, message);
		env->DeleteLocalRef(type);
	}
}
bool length(JNIEnv* env, jarray value, jsize expected) {
	if (!value || env->GetArrayLength(value) != expected) {
		invalid(env, "Invalid JNI array shape");
		return false;
	}
	return !env->ExceptionCheck();
}
bool bytes(JNIEnv* env, jobjectArray source, jsize index, void* target, std::size_t capacity, bool text,
		   std::uint32_t* size = nullptr) {
	auto value = static_cast<jbyteArray>(env->GetObjectArrayElement(source, index));
	if (env->ExceptionCheck()) return false;
	if (!value) {
		invalid(env, "Null JNI configuration field");
		return false;
	}
	const auto count = env->GetArrayLength(value);
	const bool fits = text ? count >= 0 && static_cast<std::size_t>(count) < capacity
						   : count > 0 && static_cast<std::size_t>(count) <= capacity;
	if (fits) env->GetByteArrayRegion(value, 0, count, static_cast<jbyte*>(target));
	env->DeleteLocalRef(value);
	if (env->ExceptionCheck()) return false;
	if (!fits || (text && std::memchr(target, 0, static_cast<std::size_t>(count)))) {
		invalid(env, "Invalid JNI configuration field size or NUL");
		return false;
	}
	if (size) *size = static_cast<std::uint32_t>(count);
	return true;
}
bool options(JNIEnv* env, jobjectArray fields, jobjectArray keys, jbooleanArray retired, LccDeviceBoundOptions& out) {
	if (!length(env, fields, 11) || !keys || !retired) {
		invalid(env, "Missing JNI configuration");
		return false;
	}
	const auto count = env->GetArrayLength(keys);
	if (count < 1 || count > 8 || !length(env, retired, count)) {
		invalid(env, "Invalid JNI trust count");
		return false;
	}
	lcc_init_device_bound_options(&out);
	struct Field {
		char* data;
		std::size_t capacity;
	};
#define FIELD(name) \
	{ out.name, sizeof(out.name) }
	const Field targets[]{FIELD(application_id), FIELD(endpoint_origin), FIELD(portal_authorization_url),
						  FIELD(issuer),		 FIELD(lease_audience),	 FIELD(proof_audience),
						  FIELD(project),		 FIELD(feature),		 FIELD(client_id),
						  FIELD(device_label),	 FIELD(callback_path)};
#undef FIELD
	for (jsize i = 0; i < 11; ++i) {
		std::memset(targets[i].data, 0, targets[i].capacity);
		if (!bytes(env, fields, i, targets[i].data, targets[i].capacity, true)) return false;
	}
	jboolean flags[8]{};
	env->GetBooleanArrayRegion(retired, 0, count, flags);
	if (env->ExceptionCheck()) return false;
	out.trust_key_count = static_cast<std::uint32_t>(count);
	for (jsize i = 0; i < count; ++i) {
		if (flags[i] != JNI_FALSE && flags[i] != JNI_TRUE) {
			invalid(env, "Invalid JNI trust flag");
			return false;
		}
		if (!bytes(env, keys, i, out.trust_keys[i].spki, sizeof(out.trust_keys[i].spki), false,
				   &out.trust_keys[i].spki_size))
			return false;
		out.trust_keys[i].retired = flags[i] == JNI_FALSE ? 0u : 1u;
	}
	return true;
}
// Preserve the unsigned uint64 bit pattern in Java's signed long without narrowing conversion.
jlong bits(std::uint64_t value) {
	jlong result;
	std::memcpy(&result, &value, sizeof(result));
	return result;
}
LccDeviceBoundClient* pointer(jlong handle) {
	return reinterpret_cast<LccDeviceBoundClient*>(static_cast<std::uintptr_t>(handle));
}
bool outcome(JNIEnv* env, LCC_BOUND_RESULT code, const LccDeviceBoundOutcome& value, jlong* out) {
	if (value.size != sizeof(value) || value.version != 1 || value.reserved != 0) {
		invalid(env, "Invalid native outcome layout");
		return false;
	}
	out[0] = code;
	out[1] = value.provider_result;
	out[2] = value.checkpoint_result;
	out[3] = value.renewal_due;
	out[4] = bits(value.effective_time);
	return true;
}
struct HandleOwner {
	LccDeviceBoundClient* handle = nullptr;
	~HandleOwner() {
		if (handle) lcc_device_bound_close(handle);
	}
};
}  // namespace

extern "C" JNIEXPORT jint JNICALL Java_io_licensecc_client_DeviceBoundNative_version(JNIEnv*, jclass) { return 1; }

extern "C" JNIEXPORT void JNICALL
Java_io_licensecc_client_DeviceBoundNative_openNative(JNIEnv* env, jclass, jobjectArray fields, jobjectArray keys,
													  jbooleanArray retired, jboolean resume, jlongArray result) try {
	if (!length(env, result, 6)) return;
	LccDeviceBoundOptions configuration{};
	if (!options(env, fields, keys, retired, configuration)) return;
	LccDeviceBoundOutcome details{};
	lcc_init_device_bound_outcome(&details);
	HandleOwner owner;
	const auto code = resume ? lcc_device_bound_open_resume(&configuration, &owner.handle, &details)
							 : lcc_device_bound_open_enrollment(&configuration, &owner.handle, &details);
	jlong output[6]{bits(reinterpret_cast<std::uintptr_t>(owner.handle))};
	if (!outcome(env, code, details, output + 1)) return;
		// Acquire only after native work; no Java array stays pinned across I/O.
#ifdef LCC_JNI_TEST_FIXTURE
	lcc_jni_test_publication(env, false);
#endif
	if (env->ExceptionCheck()) return;
	auto destination = env->GetLongArrayElements(result, nullptr);
	if (!destination) return;  // VM has raised allocation failure; RAII retains ownership.
	if (env->ExceptionCheck()) {
		env->ReleaseLongArrayElements(result, destination, JNI_ABORT);
		return;
	}
	std::memcpy(destination, output, sizeof(output));
	// Commit ownership unconditionally with the array. Release is valid even
	// with a pending exception; never retract a handle already visible to Java.
	owner.handle = nullptr;
	env->ReleaseLongArrayElements(result, destination, 0);
#ifdef LCC_JNI_TEST_FIXTURE
	lcc_jni_test_publication(env, true);
#endif
} catch (...) {
	invalid(env, "Native open failed unexpectedly");
}

extern "C" JNIEXPORT void JNICALL Java_io_licensecc_client_DeviceBoundNative_invokeNative(JNIEnv* env, jclass,
																						  jlong handle, jint operation,
																						  jlongArray result) try {
	if (!length(env, result, 5)) return;
	LccDeviceBoundOutcome details{};
	lcc_init_device_bound_outcome(&details);
	LCC_BOUND_RESULT code = LCC_BOUND_INVALID_ARGUMENT;
	switch (operation) {
		case 0:
			code = lcc_device_bound_activate(pointer(handle), &details);
			break;
		case 1:
			code = lcc_device_bound_renew(pointer(handle), &details);
			break;
		case 2:
			code = lcc_device_bound_authorize(pointer(handle), &details);
			break;
		case 3:
			code = lcc_device_bound_save_checkpoint(pointer(handle), &details);
			break;
		case 4:
			code = lcc_device_bound_abandon_pending(pointer(handle), &details);
			break;
		default:
			break;
	}
	jlong output[5]{};
	if (outcome(env, code, details, output)) env->SetLongArrayRegion(result, 0, 5, output);
} catch (...) {
	invalid(env, "Native operation failed unexpectedly");
}

extern "C" JNIEXPORT void JNICALL Java_io_licensecc_client_DeviceBoundNative_prepareNative(JNIEnv* env, jclass,
																						   jlong handle,
																						   jlongArray result,
																						   jbyteArray comparison) try {
	if (!length(env, result, 2) || !length(env, comparison, 15)) return;
	LccDeviceBoundView view{};
	lcc_init_device_bound_view(&view);
	const auto code = lcc_device_bound_prepare(pointer(handle), &view);
	if (code == LCC_BOUND_OK) {
		if (view.size != sizeof(view) || view.version != 1) {
			invalid(env, "Invalid native comparison layout");
			return;
		}
		env->SetByteArrayRegion(comparison, 0, 15, reinterpret_cast<const jbyte*>(view.comparison_code));
		if (env->ExceptionCheck()) return;
	}
	const jlong output[]{code, bits(view.expires_at)};
	env->SetLongArrayRegion(result, 0, 2, output);
} catch (...) {
	invalid(env, "Native preparation failed unexpectedly");
}

extern "C" JNIEXPORT jint JNICALL Java_io_licensecc_client_DeviceBoundNative_simpleNative(JNIEnv* env, jclass,
																						  jlong handle, jint operation,
																						  jint waitMilliseconds) try {
	switch (operation) {
		case 0:
			return lcc_device_bound_launch(pointer(handle));
		case 1:
			return waitMilliseconds >= 0 && waitMilliseconds <= 1000
					   ? lcc_device_bound_poll(pointer(handle), static_cast<std::uint32_t>(waitMilliseconds))
					   : LCC_BOUND_INVALID_ARGUMENT;
		case 2:
			return lcc_device_bound_cancel(pointer(handle));
		default:
			return LCC_BOUND_INVALID_ARGUMENT;
	}
} catch (...) {
	invalid(env, "Native operation failed unexpectedly");
	return LCC_BOUND_INTERNAL_ERROR;
}
extern "C" JNIEXPORT void JNICALL Java_io_licensecc_client_DeviceBoundNative_closeNative(JNIEnv* env, jclass,
																						 jlong handle) try {
	lcc_device_bound_close(pointer(handle));
} catch (...) {
	invalid(env, "Native close failed unexpectedly");
}

#ifndef LCC_JNI_TEST_FIXTURE
namespace {
static_assert(sizeof(LccFeatureSessionOutcome) == 56 && offsetof(LccFeatureSessionOutcome, effective_time) == 32,
			  "Review feature-session JNI marshaling after ABI changes");
LccFeatureSession* feature_pointer(jlong handle) {
	return reinterpret_cast<LccFeatureSession*>(static_cast<std::uintptr_t>(handle));
}
bool feature_outcome(JNIEnv* env, LCC_BOUND_RESULT code, const LccFeatureSessionOutcome& value, jlong* output) {
	if (value.size != sizeof(value) || value.version != 1 || value.reserved[0] || value.reserved[1]) {
		invalid(env, "Invalid native feature-session layout");
		return false;
	}
	output[0] = code;
	output[1] = value.state;
	output[2] = value.provider_result;
	output[3] = value.checkpoint_result;
	output[4] = value.renewal_due;
	output[5] = bits(value.effective_time);
	output[6] = bits(value.renew_after);
	output[7] = bits(value.expires_at);
	return true;
}
struct FeatureOwner {
	LccFeatureSession* handle = nullptr;
	~FeatureOwner() {
		if (handle) lcc_feature_session_close(handle);
	}
};
}  // namespace
extern "C" JNIEXPORT jint JNICALL Java_io_licensecc_client_FeatureSessionNative_version(JNIEnv*, jclass) { return 1; }
extern "C" JNIEXPORT void JNICALL Java_io_licensecc_client_FeatureSessionNative_openNative(
	JNIEnv* env, jclass, jobjectArray fields, jobjectArray keys, jbooleanArray retired, jlongArray result) try {
	if (!length(env, result, 9)) return;
	LccDeviceBoundOptions configuration{};
	if (!options(env, fields, keys, retired, configuration)) return;
	LccFeatureSessionOutcome details;
	lcc_init_feature_session_outcome(&details);
	FeatureOwner owner;
	const auto code = lcc_feature_session_open(&configuration, &owner.handle, &details);
	jlong output[9]{bits(reinterpret_cast<std::uintptr_t>(owner.handle))};
	if (!feature_outcome(env, code, details, output + 1)) return;
	auto destination = env->GetLongArrayElements(result, nullptr);
	if (!destination) return;
	if (env->ExceptionCheck()) {
		env->ReleaseLongArrayElements(result, destination, JNI_ABORT);
		return;
	}
	std::memcpy(destination, output, sizeof(output));
	env->ReleaseLongArrayElements(result, destination, 0);
	owner.handle = nullptr;	 // Java owns the published handle, including pending exceptions.
} catch (...) {
	invalid(env, "Native feature open failed unexpectedly");
}
extern "C" JNIEXPORT void JNICALL Java_io_licensecc_client_FeatureSessionNative_invokeNative(
	JNIEnv* env, jclass, jlong handle, jint operation, jbyteArray feature, jlongArray result) try {
	if (!length(env, result, 8)) return;
	char required[16]{};
	if (operation == 4) {
		if (!feature) {
			invalid(env, "Missing required feature");
			return;
		}
		const auto count = env->GetArrayLength(feature);
		if (count < 1 || count > 15) {
			invalid(env, "Invalid required feature length");
			return;
		}
		env->GetByteArrayRegion(feature, 0, count, reinterpret_cast<jbyte*>(required));
		if (env->ExceptionCheck()) return;
		if (std::memchr(required, 0, static_cast<std::size_t>(count))) {
			invalid(env, "Invalid required feature NUL");
			return;
		}
	} else if (feature) {
		invalid(env, "Unexpected feature parameter");
		return;
	}
	LccFeatureSessionOutcome details;
	lcc_init_feature_session_outcome(&details);
	LCC_BOUND_RESULT code = LCC_BOUND_INVALID_ARGUMENT;
	switch (operation) {
		case 0:
			code = lcc_feature_session_start(feature_pointer(handle), &details);
			break;
		case 1:
			code = lcc_feature_session_renew(feature_pointer(handle), &details);
			break;
		case 2:
			code = lcc_feature_session_stop(feature_pointer(handle), &details);
			break;
		case 3:
			code = lcc_feature_session_save_checkpoint(feature_pointer(handle), &details);
			break;
		case 4:
			code = lcc_feature_session_authorize(feature_pointer(handle), required, &details);
			break;
		default:
			break;
	}
	jlong output[8]{};
	if (feature_outcome(env, code, details, output)) env->SetLongArrayRegion(result, 0, 8, output);
} catch (...) {
	invalid(env, "Native feature operation failed unexpectedly");
}
extern "C" JNIEXPORT void JNICALL Java_io_licensecc_client_FeatureSessionNative_closeNative(JNIEnv* env, jclass,
																							jlong handle) try {
	lcc_feature_session_close(feature_pointer(handle));
} catch (...) {
	invalid(env, "Native feature close failed unexpectedly");
}
#endif
