#ifndef LICENSECC_BOUND_CHECKPOINT_HPP_
#define LICENSECC_BOUND_CHECKPOINT_HPP_
#include "bound_lease.hpp"
#include <memory>
#include <mutex>

namespace license {
namespace device_identity {
// Storage decisions only; no outcome grants protected-operation authority.
enum class BoundCheckpointDecision {
	replace,
	unchanged,  // Equivalent signed resume policy; tokens need not be byte-identical.
	stale,
	conflict,
	invalid_candidate,
	invalid_stored,
	internal_error
};
// current == nullptr means no committed record. An existing empty/truncated
// record is invalid, never an invitation to silently overwrite recovery state.
// The caller holds the same storage lock through read, comparison and publish.
BoundCheckpointDecision compare_bound_checkpoints(const std::string& candidate, const std::string* current,
												  const std::vector<BoundLeaseTrustKey>&,
												  const BoundResumeExpected&) noexcept;
enum class BoundCheckpointIo { ok, missing, busy, error };
enum class BoundCheckpointStatus {
	saved,
	loaded,
	unchanged,
	missing,
	busy,
	stale,
	conflict,
	invalid_candidate,
	invalid_stored,
	storage_error,
	mirror_pending,
	commit_unknown
};
// Private platform seam. lock() serializes every process using this namespace.
// read() must bound input to 8192 bytes before allocation. publish() must first
// stabilize/flush any retained other-slot winner, then completely stage and
// flush the candidate before same-directory atomic publication. ok requires
// acknowledged completion of all those steps. Error can mean visible bytes
// with uncertain durability; readback alone cannot turn that into saved.
// It must never change the other slot, including after returning an error.
class BoundCheckpointStorage {
public:
	virtual ~BoundCheckpointStorage() = default;
	virtual BoundCheckpointIo lock() noexcept = 0;
	virtual void unlock() noexcept = 0;
	virtual BoundCheckpointIo read(unsigned slot, std::string& out) noexcept = 0;
	virtual BoundCheckpointIo publish(unsigned slot, const std::string&) noexcept = 0;
	// Check exact existing bytes and stabilize/flush without replacing them.
	// Used on idempotent save/retry, including a prior unknown mirror result.
	virtual BoundCheckpointIo confirm(unsigned slot, const std::string&) noexcept = 0;
};
class BoundCheckpointStore {
public:
	// Destruction requires that no concurrent load/save call is in progress.
	static std::unique_ptr<BoundCheckpointStore> create(std::unique_ptr<BoundCheckpointStorage>,
														std::vector<BoundLeaseTrustKey>, BoundResumeExpected) noexcept;
	BoundCheckpointStatus load(std::string& out) noexcept;
	BoundCheckpointStatus save(const std::string& candidate) noexcept;

private:
	BoundCheckpointStore() = default;
	std::unique_ptr<BoundCheckpointStorage> storage_;
	std::vector<BoundLeaseTrustKey> trust_;
	BoundResumeExpected expected_;
	std::mutex mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
