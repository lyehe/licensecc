#include "bound_public.hpp"
namespace license {
namespace device_identity {
LCC_BOUND_RESULT bound_public_result(BoundEnrollmentStatus s) noexcept {
	switch (s) {
		case BoundEnrollmentStatus::ready:
			return LCC_BOUND_OK;
		case BoundEnrollmentStatus::callback_received:
			return LCC_BOUND_CALLBACK_RECEIVED;
		case BoundEnrollmentStatus::retry:
			return LCC_BOUND_RETRY;
		case BoundEnrollmentStatus::busy:
			return LCC_BOUND_BUSY;
		case BoundEnrollmentStatus::invalid_input:
			return LCC_BOUND_INVALID_STATE;
		case BoundEnrollmentStatus::invalid_response:
			return LCC_BOUND_INVALID_RESPONSE;
		case BoundEnrollmentStatus::expired:
			return LCC_BOUND_EXPIRED;
		case BoundEnrollmentStatus::denied:
			return LCC_BOUND_DENIED;
		case BoundEnrollmentStatus::cancelled:
			return LCC_BOUND_CANCELLED;
		case BoundEnrollmentStatus::failed:
			return LCC_BOUND_INTERNAL_ERROR;
	}
	return LCC_BOUND_INTERNAL_ERROR;
}
LCC_BOUND_RESULT bound_public_result(BoundRenewStatus s) noexcept {
	switch (s) {
		case BoundRenewStatus::accepted:
			return LCC_BOUND_OK;
		case BoundRenewStatus::retry:
			return LCC_BOUND_RETRY;
		case BoundRenewStatus::conflict:
			return LCC_BOUND_CONFLICT;
		case BoundRenewStatus::rejected:
			return LCC_BOUND_INVALID_STATE;
		case BoundRenewStatus::denied:
			return LCC_BOUND_DENIED;
		case BoundRenewStatus::busy:
			return LCC_BOUND_BUSY;
		case BoundRenewStatus::session_error:
			return LCC_BOUND_INTERNAL_ERROR;
		case BoundRenewStatus::invalid_response:
			return LCC_BOUND_INVALID_RESPONSE;
		case BoundRenewStatus::internal_error:
			return LCC_BOUND_INTERNAL_ERROR;
		case BoundRenewStatus::enrollment_required:
			return LCC_BOUND_ENROLLMENT_REQUIRED;
		case BoundRenewStatus::renewal_required:
			return LCC_BOUND_ONLINE_REQUIRED;
	}
	return LCC_BOUND_INTERNAL_ERROR;
}
LCC_BOUND_RESULT bound_public_result(const BoundSessionDecision& d, LccDeviceBoundOutcome& out) noexcept {
	out.provider_result = d.provider_result;
	out.renewal_due = d.renewal_due ? 1 : 0;
	switch (d.status) {
		case BoundSessionStatus::ok:
			return LCC_BOUND_OK;
		case BoundSessionStatus::online_required:
			return LCC_BOUND_ONLINE_REQUIRED;
		case BoundSessionStatus::invalid_response:
			return LCC_BOUND_INVALID_RESPONSE;
		case BoundSessionStatus::no_pending:
			return LCC_BOUND_INVALID_STATE;
		case BoundSessionStatus::denied:
			return LCC_BOUND_DENIED;
		case BoundSessionStatus::provider_error:
			return LCC_BOUND_PROVIDER_ERROR;
		case BoundSessionStatus::conflict:
			return LCC_BOUND_CONFLICT;
		case BoundSessionStatus::internal_error:
			return LCC_BOUND_INTERNAL_ERROR;
	}
	return LCC_BOUND_INTERNAL_ERROR;
}
LCC_BOUND_CHECKPOINT_RESULT bound_public_checkpoint(BoundCheckpointStatus s) noexcept {
	switch (s) {
		case BoundCheckpointStatus::saved:
			return LCC_BOUND_CHECKPOINT_SAVED;
		case BoundCheckpointStatus::loaded:
			return LCC_BOUND_CHECKPOINT_LOADED;
		case BoundCheckpointStatus::unchanged:
			return LCC_BOUND_CHECKPOINT_UNCHANGED;
		case BoundCheckpointStatus::missing:
			return LCC_BOUND_CHECKPOINT_MISSING;
		case BoundCheckpointStatus::busy:
			return LCC_BOUND_CHECKPOINT_BUSY;
		case BoundCheckpointStatus::stale:
			return LCC_BOUND_CHECKPOINT_STALE;
		case BoundCheckpointStatus::conflict:
			return LCC_BOUND_CHECKPOINT_CONFLICT;
		case BoundCheckpointStatus::invalid_candidate:
		case BoundCheckpointStatus::invalid_stored:
			return LCC_BOUND_CHECKPOINT_INVALID;
		case BoundCheckpointStatus::storage_error:
			return LCC_BOUND_CHECKPOINT_IO_ERROR;
		case BoundCheckpointStatus::mirror_pending:
			return LCC_BOUND_CHECKPOINT_MIRROR_PENDING;
		case BoundCheckpointStatus::commit_unknown:
			return LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN;
	}
	return LCC_BOUND_CHECKPOINT_IO_ERROR;
}
}  // namespace device_identity
}  // namespace license
