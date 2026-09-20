#include "bound_public.hpp"
#include "device_identity_handle.hpp"
#ifdef _WIN32
#include "bound_desktop.hpp"
#endif
#include <cstring>

using namespace license::device_identity;
struct LccDeviceBoundClient {
	std::mutex mutex;
	std::unique_ptr<BoundCheckpointStore> storage;
	std::unique_ptr<BoundRenewalClient> renewal;
#ifdef _WIN32
	std::unique_ptr<BoundDesktopEnrollment> enrollment;
	std::unique_ptr<BoundEnrollmentFlow> pending;
	std::unique_ptr<BoundBrowserLauncher> browser;
	std::string callback_path;
#endif
	std::string retained;
	std::function<bool()> capture_allowed;
	bool cancelled = false;
	BoundResumeExport capture() {
		if (capture_allowed && !capture_allowed()) return BoundResumeExport::error;
		if (renewal) return renewal->capture_resume_statement(retained);
#ifdef _WIN32
		if (enrollment) return enrollment->capture_resume_statement(retained);
		if (pending) return pending->capture_resume_statement(retained);
#endif
		return BoundResumeExport::absent;
	}
	void stop() noexcept {
#ifdef _WIN32
		enrollment.reset();
		pending.reset();
		browser.reset();
#endif
		renewal.reset();
	}
	LCC_BOUND_CHECKPOINT_RESULT save() {
		const auto captured = capture();
		if (captured == BoundResumeExport::busy) return LCC_BOUND_CHECKPOINT_BUSY;
		if (captured == BoundResumeExport::error) return LCC_BOUND_CHECKPOINT_IO_ERROR;
		if (cancelled) stop();
		return retained.empty() ? LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED : bound_public_checkpoint(storage->save(retained));
	}
};

namespace {
template <class F>
LCC_BOUND_RESULT locked(LccDeviceBoundClient* client, F body) noexcept {
	if (!client) return LCC_BOUND_INVALID_ARGUMENT;
	try {
		std::unique_lock<std::mutex> lock(client->mutex, std::try_to_lock);
		if (!lock.owns_lock()) return LCC_BOUND_BUSY;
		return body(*client);
	} catch (...) {
		return LCC_BOUND_INTERNAL_ERROR;
	}
}
template <class F>
LCC_BOUND_RESULT outcome(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out, F body) noexcept {
	const auto valid = bound_public_structure(out);
	if (valid != LCC_BOUND_OK) return valid;
	return locked(client, [&](LccDeviceBoundClient& owner) {
		LccDeviceBoundOutcome next;
		lcc_init_device_bound_outcome(&next);
		const auto result = body(owner, next);
		next.size = out->size;
		*out = next;
		return result;
	});
}
LCC_BOUND_RESULT checkpoint_result(LCC_BOUND_CHECKPOINT_RESULT value) {
	if (value == LCC_BOUND_CHECKPOINT_SAVED || value == LCC_BOUND_CHECKPOINT_UNCHANGED) return LCC_BOUND_OK;
	if (value == LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED) return LCC_BOUND_INVALID_STATE;
	if (value == LCC_BOUND_CHECKPOINT_BUSY) return LCC_BOUND_BUSY;
	return LCC_BOUND_STORAGE_ERROR;
}
#ifdef _WIN32
LCC_BOUND_RESULT finish(LccDeviceBoundClient& owner, const BoundRenewResult& value, LccDeviceBoundOutcome& out) {
	if (owner.enrollment) {
		auto renewal = owner.enrollment->take_client();
		if (renewal) {
			owner.renewal = std::move(renewal);
			owner.enrollment.reset();
		}
	}
	bound_public_result(value.decision, out);
	const auto primary = value.status == BoundRenewStatus::session_error ? bound_public_result(value.decision, out)
																		 : bound_public_result(value.status);
	out.checkpoint_result = owner.save();
	return primary;
}
#endif
}  // namespace

namespace license {
namespace device_identity {
LCC_BOUND_RESULT authorize_bound_public(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out,
										BoundSessionDecision* verified) noexcept {
	return outcome(client, out, [&](LccDeviceBoundClient& owner, LccDeviceBoundOutcome& next) {
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
		if (!owner.renewal) return LCC_BOUND_ENROLLMENT_REQUIRED;
		const auto decision = owner.renewal->authorize_operation();
		const auto result = bound_public_result(decision, next);
		if (result == LCC_BOUND_OK) {
			next.effective_time = decision.effective_time;
			if (verified) *verified = decision;
		}
		return result;
	});
}
LCC_BOUND_RESULT open_bound_public(const LccDeviceBoundOptions* options, LccDeviceBoundClient** out,
								   LccDeviceBoundOutcome* detail, bool resume, const BoundPublicHooks& hooks) noexcept {
	if (!out || *out) return LCC_BOUND_INVALID_ARGUMENT;
	const auto valid = bound_public_structure(detail);
	if (valid != LCC_BOUND_OK) return valid;
	BoundPublicConfig config;
	const auto checked = validate_bound_public_options(options, config);
	if (checked != LCC_BOUND_OK) return checked;
#ifndef _WIN32
	return LCC_BOUND_UNSUPPORTED_PLATFORM;
#else
	try {
		if (!hooks.identity || !hooks.storage || !hooks.clock || !hooks.transport || !hooks.browser)
			return LCC_BOUND_INVALID_ARGUMENT;
		LccDeviceBoundOutcome next;
		lcc_init_device_bound_outcome(&next);
		const auto done = [&](LCC_BOUND_RESULT result) {
			next.size = detail->size;
			*detail = next;
			return result;
		};
		auto owner = std::make_unique<LccDeviceBoundClient>();
		owner->retained.reserve(8192);
		owner->capture_allowed = hooks.capture_allowed;
		auto storage = hooks.storage(config.storage);
		if (!storage) {
			next.checkpoint_result = LCC_BOUND_CHECKPOINT_IO_ERROR;
			return done(LCC_BOUND_STORAGE_ERROR);
		}
		const auto admission = storage->lock();
		if (admission != BoundCheckpointIo::ok) {
			next.checkpoint_result =
				admission == BoundCheckpointIo::busy ? LCC_BOUND_CHECKPOINT_BUSY : LCC_BOUND_CHECKPOINT_IO_ERROR;
			return done(admission == BoundCheckpointIo::busy ? LCC_BOUND_BUSY : LCC_BOUND_STORAGE_ERROR);
		}
		struct Unlock {
			BoundCheckpointStorage* io;
			~Unlock() {
				if (io) io->unlock();
			}
		} unlock{storage.get()};
		const auto empty = [&]() {
			for (unsigned slot = 0; slot < 2; ++slot) {
				std::string bytes;
				const auto read = storage->read(slot, bytes);
				if (read == BoundCheckpointIo::ok) return LCC_BOUND_RESUME_REQUIRED;
				if (read != BoundCheckpointIo::missing) {
					next.checkpoint_result = LCC_BOUND_CHECKPOINT_IO_ERROR;
					return LCC_BOUND_STORAGE_ERROR;
				}
			}
			return LCC_BOUND_OK;
		};
		if (!resume) {
			const auto probe = empty();
			if (probe != LCC_BOUND_OK) return done(probe);
		}
		LccDeviceIdentityOptions identity_options;
		lcc_init_device_identity_options(&identity_options);
		identity_options.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
		identity_options.flags = resume ? 0 : LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		std::strcpy(identity_options.application_id, config.storage.application_id.c_str());
		std::strcpy(identity_options.project, config.storage.project.c_str());
		BoundIdentityOwner identity;
		next.provider_result = hooks.identity(identity_options, identity);
		if (next.provider_result != LCC_DEVICE_OK) return done(LCC_BOUND_PROVIDER_ERROR);
		if (!identity) return done(LCC_BOUND_INTERNAL_ERROR);
		if (!resume) {
			const auto probe = empty();
			if (probe != LCC_BOUND_OK) return done(probe);
		}
		storage->unlock();
		unlock.io = nullptr;
		auto& context = config.enrollment.session;
		context.provider_policy = hooks.policy;
		owner->storage = BoundCheckpointStore::create(
			std::move(storage), config.trust,
			{context.issuer, context.lease_audience, context.project, context.feature, identity->device_key_id});
		if (!owner->storage) return done(LCC_BOUND_INTERNAL_ERROR);
		if (resume) {
			const auto loaded = owner->storage->load(owner->retained);
			next.checkpoint_result = bound_public_checkpoint(loaded);
			if (loaded != BoundCheckpointStatus::loaded)
				return done(loaded == BoundCheckpointStatus::missing ? LCC_BOUND_ENROLLMENT_REQUIRED
							: loaded == BoundCheckpointStatus::busy	 ? LCC_BOUND_BUSY
																	 : LCC_BOUND_STORAGE_ERROR);
			owner->retained.reserve(8192);
			owner->renewal = BoundRenewalClient::create_for_resume(std::move(identity), context, config.trust,
																   config.enrollment.endpoint_origin, owner->retained,
																   hooks.clock, hooks.transport);
			if (!owner->renewal) return done(LCC_BOUND_INTERNAL_ERROR);
		} else {
			owner->callback_path = config.callback_path;
			owner->browser = hooks.browser(config.enrollment.portal_authorization_url);
			owner->pending = BoundEnrollmentFlow::create(std::move(identity), config.enrollment, config.trust,
														 hooks.clock, hooks.transport);
			if (!owner->pending || !owner->browser) return done(LCC_BOUND_INTERNAL_ERROR);
		}
		*out = owner.release();
		return done(LCC_BOUND_OK);
	} catch (...) {
		return LCC_BOUND_INTERNAL_ERROR;
	}
#endif
}
}  // namespace device_identity
}  // namespace license

namespace {
LCC_BOUND_RESULT open_default(const LccDeviceBoundOptions* options, LccDeviceBoundClient** out,
							  LccDeviceBoundOutcome* detail, bool resume) noexcept {
	try {
		BoundPublicHooks hooks;
#ifdef _WIN32
		hooks.identity = [](const LccDeviceIdentityOptions& in, BoundIdentityOwner& owner) {
			LccDeviceIdentity* raw = nullptr;
			const auto result = lcc_device_identity_open(&in, &raw);
			owner.reset(raw);
			return result;
		};
		hooks.storage = make_bound_checkpoint_storage;
		hooks.browser = make_bound_browser_launcher;
#endif
		return open_bound_public(options, out, detail, resume, hooks);
	} catch (...) {
		return LCC_BOUND_INTERNAL_ERROR;
	}
}
}  // namespace
extern "C" {
LCC_BOUND_RESULT lcc_device_bound_open_enrollment(const LccDeviceBoundOptions* options, LccDeviceBoundClient** out,
												  LccDeviceBoundOutcome* detail) {
	return open_default(options, out, detail, false);
}
LCC_BOUND_RESULT lcc_device_bound_open_resume(const LccDeviceBoundOptions* options, LccDeviceBoundClient** out,
											  LccDeviceBoundOutcome* detail) {
	return open_default(options, out, detail, true);
}
LCC_BOUND_RESULT lcc_device_bound_prepare(LccDeviceBoundClient* client, LccDeviceBoundView* out) {
	const auto valid = bound_public_structure(out);
	if (valid != LCC_BOUND_OK) return valid;
	return locked(client, [&](LccDeviceBoundClient& owner) {
#ifdef _WIN32
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
		if (!owner.enrollment && owner.pending) {
			std::string present;
			const auto stored = owner.storage->load(present);
			if (stored != BoundCheckpointStatus::missing)
				return stored == BoundCheckpointStatus::loaded ? LCC_BOUND_RESUME_REQUIRED
					   : stored == BoundCheckpointStatus::busy ? LCC_BOUND_BUSY
															   : LCC_BOUND_STORAGE_ERROR;
			auto listener = BoundLoopbackListener::create(owner.callback_path);
			if (!listener) return LCC_BOUND_RETRY;
			owner.enrollment =
				BoundDesktopEnrollment::create(std::move(owner.pending), std::move(listener), std::move(owner.browser));
			if (!owner.enrollment) return LCC_BOUND_INTERNAL_ERROR;
		}
		if (!owner.enrollment) return LCC_BOUND_INVALID_STATE;
		BoundEnrollmentView view;
		const auto result = owner.enrollment->prepare(view);
		if (result.status != BoundEnrollmentStatus::ready) return bound_public_result(result.status);
		if (view.comparison_code.size() != 14) return LCC_BOUND_INTERNAL_ERROR;
		LccDeviceBoundView next;
		lcc_init_device_bound_view(&next);
		next.size = out->size;
		next.expires_at = view.expires_at;
		std::memcpy(next.comparison_code, view.comparison_code.c_str(), 15);
		*out = next;
		return LCC_BOUND_OK;
#else
        return LCC_BOUND_UNSUPPORTED_PLATFORM;
#endif
	});
}
LCC_BOUND_RESULT lcc_device_bound_launch(LccDeviceBoundClient* client) {
	return locked(client, [](LccDeviceBoundClient& owner) {
#ifdef _WIN32
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
		if (!owner.enrollment) return LCC_BOUND_INVALID_STATE;
		switch (owner.enrollment->launch()) {
			case BoundBrowserStatus::opened:
				return LCC_BOUND_OK;
			case BoundBrowserStatus::unavailable:
				return LCC_BOUND_BROWSER_UNAVAILABLE;
			case BoundBrowserStatus::invalid_input:
				return LCC_BOUND_INVALID_STATE;
			case BoundBrowserStatus::busy:
				return LCC_BOUND_BUSY;
			case BoundBrowserStatus::expired:
				return LCC_BOUND_EXPIRED;
		}
#endif
		return LCC_BOUND_UNSUPPORTED_PLATFORM;
	});
}
LCC_BOUND_RESULT lcc_device_bound_poll(LccDeviceBoundClient* client, uint32_t wait_ms) {
	if (wait_ms > 1000) return LCC_BOUND_INVALID_ARGUMENT;
	return locked(client, [&](LccDeviceBoundClient& owner) {
#ifdef _WIN32
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
		if (!owner.enrollment) return LCC_BOUND_INVALID_STATE;
		switch (owner.enrollment->poll(wait_ms)) {
			case BoundLoopbackStatus::waiting:
				return LCC_BOUND_WAITING;
			case BoundLoopbackStatus::rejected:
				return LCC_BOUND_CALLBACK_REJECTED;
			case BoundLoopbackStatus::received:
				return LCC_BOUND_CALLBACK_RECEIVED;
			case BoundLoopbackStatus::expired:
				return LCC_BOUND_EXPIRED;
			case BoundLoopbackStatus::closed:
				return LCC_BOUND_INVALID_STATE;
			case BoundLoopbackStatus::busy:
				return LCC_BOUND_BUSY;
			case BoundLoopbackStatus::failed:
				return LCC_BOUND_INTERNAL_ERROR;
		}
#endif
		return LCC_BOUND_UNSUPPORTED_PLATFORM;
	});
}
LCC_BOUND_RESULT lcc_device_bound_activate(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out) {
	return outcome(client, out, [](LccDeviceBoundClient& owner, LccDeviceBoundOutcome& next) {
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
#ifdef _WIN32
		if (!owner.enrollment) return LCC_BOUND_INVALID_STATE;
		return finish(owner, owner.enrollment->activate(), next);
#else
        return LCC_BOUND_UNSUPPORTED_PLATFORM;
#endif
	});
}
LCC_BOUND_RESULT lcc_device_bound_renew(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out) {
	return outcome(client, out, [](LccDeviceBoundClient& owner, LccDeviceBoundOutcome& next) {
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
		if (!owner.renewal) return LCC_BOUND_ENROLLMENT_REQUIRED;
#ifdef _WIN32
		return finish(owner, owner.renewal->renew(), next);
#else
        return LCC_BOUND_UNSUPPORTED_PLATFORM;
#endif
	});
}
LCC_BOUND_RESULT lcc_device_bound_authorize(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out) {
	return authorize_bound_public(client, out, nullptr);
}
LCC_BOUND_RESULT lcc_device_bound_save_checkpoint(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out) {
	return outcome(client, out, [](LccDeviceBoundClient& owner, LccDeviceBoundOutcome& next) {
		const auto saved = owner.save();
		next.checkpoint_result = saved;
		return checkpoint_result(saved);
	});
}
LCC_BOUND_RESULT lcc_device_bound_abandon_pending(LccDeviceBoundClient* client, LccDeviceBoundOutcome* out) {
	return outcome(client, out, [](LccDeviceBoundClient& owner, LccDeviceBoundOutcome& next) {
		if (owner.cancelled) return LCC_BOUND_CANCELLED;
		if (owner.renewal) {
			const auto result = bound_public_result(owner.renewal->abandon_renewal(), next);
			next.checkpoint_result = owner.save();
			return result;
		}
#ifdef _WIN32
		if (owner.enrollment) return finish(owner, owner.enrollment->abandon_exchange(), next);
#endif
		return LCC_BOUND_INVALID_STATE;
	});
}
LCC_BOUND_RESULT lcc_device_bound_cancel(LccDeviceBoundClient* client) {
	return locked(client, [](LccDeviceBoundClient& owner) {
		owner.cancelled = true;
		const auto captured = owner.capture();
		if (captured == BoundResumeExport::busy) return LCC_BOUND_INTERNAL_ERROR;
		if (captured == BoundResumeExport::error) return LCC_BOUND_INTERNAL_ERROR;
		owner.stop();
		return LCC_BOUND_CANCELLED;
	});
}
void lcc_device_bound_close(LccDeviceBoundClient* client) { delete client; }
}
