#include "feature_session.hpp"
#include "bound_encoding.hpp"
#include <cstddef>
#include <cstring>

using namespace license::device_identity;
static_assert(offsetof(LccFeatureSessionOutcome, effective_time) == 32, "feature-session time ABI");
static_assert(sizeof(LccFeatureSessionOutcome) == 56, "feature-session outcome ABI");

struct LccFeatureSession {
	struct Closer {
		void operator()(LccDeviceBoundClient* p) const noexcept { lcc_device_bound_close(p); }
	};
	std::mutex mutex;
	std::unique_ptr<LccDeviceBoundClient, Closer> client;
	std::string feature;
	LCC_FEATURE_SESSION_STATE state = LCC_FEATURE_SESSION_READY;
};

namespace {
LCC_BOUND_RESULT structure(const LccFeatureSessionOutcome* out) noexcept {
	if (!out || out->size < sizeof(*out)) return LCC_BOUND_INVALID_ARGUMENT;
	return out->version == LCC_FEATURE_SESSION_VERSION ? LCC_BOUND_OK : LCC_BOUND_UNSUPPORTED_VERSION;
}
enum class Action { start, authorize, renew, stop, save };
bool allowed(LCC_FEATURE_SESSION_STATE state, Action action) noexcept {
	if (action == Action::start) return state == LCC_FEATURE_SESSION_READY || state == LCC_FEATURE_SESSION_STARTING;
	if (action == Action::renew)
		return state == LCC_FEATURE_SESSION_ACTIVE || state == LCC_FEATURE_SESSION_NEEDS_ONLINE;
	return true;
}
void details(LccFeatureSessionOutcome& out, const LccDeviceBoundOutcome& inner) noexcept {
	out.provider_result = inner.provider_result;
	out.checkpoint_result = inner.checkpoint_result;
	out.renewal_due = inner.renewal_due;
}
void times(LccFeatureSessionOutcome& out, const BoundSessionDecision& verified) noexcept {
	out.effective_time = verified.effective_time;
	out.renew_after = verified.renew_after;
	out.expires_at = verified.expires_at;
}
void failed(LccFeatureSession& owner, LCC_BOUND_RESULT result, bool starting) noexcept {
	if (result == LCC_BOUND_DENIED)
		owner.state = LCC_FEATURE_SESSION_DENIED;
	else if (result == LCC_BOUND_CONFLICT)
		owner.state = LCC_FEATURE_SESSION_FAILED;
	else if (!starting)
		owner.state = LCC_FEATURE_SESSION_NEEDS_ONLINE;
}
template <class F>
LCC_BOUND_RESULT admitted(LccFeatureSession* session, LccFeatureSessionOutcome* out, Action action, F body) noexcept {
	const auto valid = structure(out);
	if (valid != LCC_BOUND_OK) return valid;
	if (!session) return LCC_BOUND_INVALID_ARGUMENT;
	try {
		std::unique_lock<std::mutex> lock(session->mutex, std::try_to_lock);
		if (!lock.owns_lock()) return LCC_BOUND_BUSY;
		if (!allowed(session->state, action)) return LCC_BOUND_INVALID_STATE;
		LccFeatureSessionOutcome next;
		lcc_init_feature_session_outcome(&next);
		LCC_BOUND_RESULT result;
		try {
			result = body(*session, next);
		} catch (...) {
			if (action == Action::renew || action == Action::authorize)
				failed(*session, LCC_BOUND_INTERNAL_ERROR, false);
			result = LCC_BOUND_INTERNAL_ERROR;
		}
		next.state = session->state;
		next.size = out->size;
		*out = next;
		return result;
	} catch (...) {
		return LCC_BOUND_INTERNAL_ERROR;
	}
}
LCC_BOUND_RESULT open(const LccDeviceBoundOptions* options, LccFeatureSession** out, LccFeatureSessionOutcome* detail,
					  const BoundPublicHooks* hooks) noexcept {
	if (!out || *out) return LCC_BOUND_INVALID_ARGUMENT;
	const auto valid = structure(detail);
	if (valid != LCC_BOUND_OK) return valid;
	BoundPublicConfig config;
	const auto checked = validate_bound_public_options(options, config);
	if (checked != LCC_BOUND_OK) return checked;
	LccFeatureSessionOutcome next;
	lcc_init_feature_session_outcome(&next);
	LCC_BOUND_RESULT result = LCC_BOUND_INTERNAL_ERROR;
	try {
		auto session = std::make_unique<LccFeatureSession>();
		session->feature = config.enrollment.session.feature;
		LccDeviceBoundOutcome inner;
		lcc_init_device_bound_outcome(&inner);
		LccDeviceBoundClient* raw = nullptr;
		result = hooks ? open_bound_public(options, &raw, &inner, true, *hooks)
					   : lcc_device_bound_open_resume(options, &raw, &inner);
		session->client.reset(raw);
		details(next, inner);
		if (result == LCC_BOUND_OK) {
			next.state = session->state;
			*out = session.release();
		}
	} catch (...) {
		result = LCC_BOUND_INTERNAL_ERROR;
	}
	next.size = detail->size;
	*detail = next;
	return result;
}
LCC_BOUND_RESULT online(LccFeatureSession& owner, LccFeatureSessionOutcome& out, bool starting) noexcept {
	const auto previous = owner.state;
	if (starting) owner.state = LCC_FEATURE_SESSION_STARTING;
	LccDeviceBoundOutcome inner;
	lcc_init_device_bound_outcome(&inner);
	auto result = lcc_device_bound_renew(owner.client.get(), &inner);
	details(out, inner);
	if (result == LCC_BOUND_BUSY) {
		owner.state = previous;
		return result;
	}
	if (result != LCC_BOUND_OK) {
		// Only a transport-classified transient preserves ACTIVE fallback.
		// Request rejection can also map to INVALID_STATE; it was admitted here
		// and must pause, unlike a rejected public lifecycle precondition.
		if (result != LCC_BOUND_RETRY) failed(owner, result, starting);
		return result;
	}
	BoundSessionDecision verified;
	result = authorize_bound_public(owner.client.get(), &inner, &verified);
	out.provider_result = inner.provider_result;
	out.renewal_due = inner.renewal_due;
	if (result == LCC_BOUND_OK) {
		owner.state = LCC_FEATURE_SESSION_ACTIVE;
		if (starting) times(out, verified);
	} else
		failed(owner, result, starting);
	// Never return cached authority on a STARTING retry: each invocation above
	// renews, retaining an unresolved operation or creating one if consumed.
	return result;
}
}  // namespace

namespace license {
namespace device_identity {
LCC_BOUND_RESULT open_feature_session(const LccDeviceBoundOptions* options, LccFeatureSession** out,
									  LccFeatureSessionOutcome* detail, const BoundPublicHooks& hooks) noexcept {
	return open(options, out, detail, &hooks);
}
}  // namespace device_identity
}  // namespace license

extern "C" {
void lcc_init_feature_session_outcome(LccFeatureSessionOutcome* out) {
	if (out) {
		std::memset(out, 0, sizeof(*out));
		out->size = sizeof(*out);
		out->version = LCC_FEATURE_SESSION_VERSION;
	}
}
LCC_BOUND_RESULT lcc_feature_session_open(const LccDeviceBoundOptions* options, LccFeatureSession** out,
										  LccFeatureSessionOutcome* detail) {
	return open(options, out, detail, nullptr);
}
LCC_BOUND_RESULT lcc_feature_session_start(LccFeatureSession* session, LccFeatureSessionOutcome* out) {
	return admitted(session, out, Action::start,
					[](LccFeatureSession& owner, LccFeatureSessionOutcome& next) { return online(owner, next, true); });
}
LCC_BOUND_RESULT lcc_feature_session_authorize(LccFeatureSession* session, const char* required_feature,
											   LccFeatureSessionOutcome* out) {
	if (!required_feature) return LCC_BOUND_INVALID_ARGUMENT;
	std::size_t count = 0;
	while (count < 16 && required_feature[count]) ++count;
	if (count == 16) return LCC_BOUND_INVALID_ARGUMENT;
	try {
		const std::string feature(required_feature, count);
		if (!bound_encoding::name(feature, 15)) return LCC_BOUND_INVALID_ARGUMENT;
		return admitted(session, out, Action::authorize, [&](LccFeatureSession& owner, LccFeatureSessionOutcome& next) {
			if (feature != owner.feature) return LCC_BOUND_DENIED;
			switch (owner.state) {
				case LCC_FEATURE_SESSION_STOPPED:
					return LCC_BOUND_CANCELLED;
				case LCC_FEATURE_SESSION_DENIED:
					return LCC_BOUND_DENIED;
				case LCC_FEATURE_SESSION_FAILED:
					return LCC_BOUND_CONFLICT;
				case LCC_FEATURE_SESSION_ACTIVE:
					break;
				default:
					return LCC_BOUND_ONLINE_REQUIRED;
			}
			LccDeviceBoundOutcome inner;
			lcc_init_device_bound_outcome(&inner);
			BoundSessionDecision verified;
			const auto result = authorize_bound_public(owner.client.get(), &inner, &verified);
			details(next, inner);
			if (result == LCC_BOUND_OK)
				times(next, verified);
			else if (result != LCC_BOUND_BUSY)
				failed(owner, result, false);
			return result;
		});
	} catch (...) {
		return LCC_BOUND_INTERNAL_ERROR;
	}
}
LCC_BOUND_RESULT lcc_feature_session_renew(LccFeatureSession* session, LccFeatureSessionOutcome* out) {
	return admitted(session, out, Action::renew, [](LccFeatureSession& owner, LccFeatureSessionOutcome& next) {
		return online(owner, next, false);
	});
}
LCC_BOUND_RESULT lcc_feature_session_stop(LccFeatureSession* session, LccFeatureSessionOutcome* out) {
	return admitted(session, out, Action::stop, [](LccFeatureSession& owner, LccFeatureSessionOutcome& next) {
		owner.state = LCC_FEATURE_SESSION_STOPPED;
		const auto cancelled = lcc_device_bound_cancel(owner.client.get());
		if (cancelled != LCC_BOUND_CANCELLED) {
			next.checkpoint_result = LCC_BOUND_CHECKPOINT_IO_ERROR;
			return LCC_BOUND_INTERNAL_ERROR;
		}
		LccDeviceBoundOutcome inner;
		lcc_init_device_bound_outcome(&inner);
		lcc_device_bound_save_checkpoint(owner.client.get(), &inner);
		details(next, inner);
		return LCC_BOUND_OK;
	});
}
LCC_BOUND_RESULT lcc_feature_session_save_checkpoint(LccFeatureSession* session, LccFeatureSessionOutcome* out) {
	return admitted(session, out, Action::save, [](LccFeatureSession& owner, LccFeatureSessionOutcome& next) {
		LccDeviceBoundOutcome inner;
		lcc_init_device_bound_outcome(&inner);
		const auto result = lcc_device_bound_save_checkpoint(owner.client.get(), &inner);
		details(next, inner);
		return result;
	});
}
void lcc_feature_session_close(LccFeatureSession* session) { delete session; }
}
