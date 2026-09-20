#include "bound_checkpoint.hpp"

namespace license {
namespace device_identity {
namespace {
struct Unlock {
	BoundCheckpointStorage& storage;
	~Unlock() { storage.unlock(); }
};
struct Slots {
	std::string token[2];
	bool present[2]{};
	unsigned winner = 0;
};
BoundCheckpointStatus decision(BoundCheckpointDecision value) {
	switch (value) {
		case BoundCheckpointDecision::replace:
			return BoundCheckpointStatus::saved;
		case BoundCheckpointDecision::unchanged:
			return BoundCheckpointStatus::unchanged;
		case BoundCheckpointDecision::stale:
			return BoundCheckpointStatus::stale;
		case BoundCheckpointDecision::conflict:
			return BoundCheckpointStatus::conflict;
		case BoundCheckpointDecision::invalid_candidate:
			return BoundCheckpointStatus::invalid_candidate;
		case BoundCheckpointDecision::invalid_stored:
			return BoundCheckpointStatus::invalid_stored;
		case BoundCheckpointDecision::internal_error:
			return BoundCheckpointStatus::storage_error;
	}
	return BoundCheckpointStatus::storage_error;
}
BoundCheckpointStatus read_slots(BoundCheckpointStorage& storage, const std::vector<BoundLeaseTrustKey>& trust,
								 const BoundResumeExpected& expected, Slots& slots) {
	for (unsigned i = 0; i < 2; ++i) {
		const auto read = storage.read(i, slots.token[i]);
		if (read == BoundCheckpointIo::missing) continue;
		if (read != BoundCheckpointIo::ok) return BoundCheckpointStatus::storage_error;
		slots.present[i] = true;
		if (compare_bound_checkpoints(slots.token[i], nullptr, trust, expected) != BoundCheckpointDecision::replace)
			return BoundCheckpointStatus::invalid_stored;
	}
	if (!slots.present[0] && !slots.present[1]) return BoundCheckpointStatus::missing;
	if (!slots.present[0])
		slots.winner = 1;
	else if (slots.present[1]) {
		const auto compared = compare_bound_checkpoints(slots.token[1], &slots.token[0], trust, expected);
		if (compared == BoundCheckpointDecision::replace)
			slots.winner = 1;
		else if (compared != BoundCheckpointDecision::unchanged && compared != BoundCheckpointDecision::stale)
			return decision(compared);
	}
	return BoundCheckpointStatus::loaded;
}
// Read back even on publication error: the OS may have completed the rename.
// Never roll back or delete state after an ambiguous outcome.
BoundCheckpointStatus publish(BoundCheckpointStorage& storage, unsigned target, const std::string& token,
							  const Slots& before, const std::vector<BoundLeaseTrustKey>& trust,
							  const BoundResumeExpected& expected) {
	const auto published = storage.publish(target, token);
	Slots after;
	const auto read = read_slots(storage, trust, expected, after);
	if (read != BoundCheckpointStatus::loaded && read != BoundCheckpointStatus::missing)
		return BoundCheckpointStatus::commit_unknown;
	const unsigned other = 1 - target;
	if (after.present[other] != before.present[other] ||
		(before.present[other] && after.token[other] != before.token[other]))
		return BoundCheckpointStatus::commit_unknown;
	if (after.present[target] && after.token[target] == token)
		return published == BoundCheckpointIo::ok ? BoundCheckpointStatus::saved
												  : BoundCheckpointStatus::commit_unknown;
	if (after.present[target] == before.present[target] &&
		(!before.present[target] || after.token[target] == before.token[target]))
		return BoundCheckpointStatus::storage_error;
	return BoundCheckpointStatus::commit_unknown;
}
}  // namespace
std::unique_ptr<BoundCheckpointStore> BoundCheckpointStore::create(std::unique_ptr<BoundCheckpointStorage> storage,
																   std::vector<BoundLeaseTrustKey> trust,
																   BoundResumeExpected expected) noexcept {
	try {
		if (!storage || !validate_bound_lease_trust(trust)) return nullptr;
		auto owner = std::unique_ptr<BoundCheckpointStore>(new BoundCheckpointStore);
		owner->storage_ = std::move(storage);
		owner->trust_ = std::move(trust);
		owner->expected_ = std::move(expected);
		return owner;
	} catch (...) {
		return nullptr;
	}
}
BoundCheckpointStatus BoundCheckpointStore::load(std::string& out) noexcept {
	try {
		std::unique_lock<std::mutex> local(mutex_, std::try_to_lock);
		if (!local.owns_lock()) return BoundCheckpointStatus::busy;
		const auto acquired = storage_->lock();
		if (acquired != BoundCheckpointIo::ok)
			return acquired == BoundCheckpointIo::busy ? BoundCheckpointStatus::busy
													   : BoundCheckpointStatus::storage_error;
		Unlock unlock{*storage_};
		Slots slots;
		const auto result = read_slots(*storage_, trust_, expected_, slots);
		if (result == BoundCheckpointStatus::loaded) out.swap(slots.token[slots.winner]);
		return result;
	} catch (...) {
		return BoundCheckpointStatus::storage_error;
	}
}
BoundCheckpointStatus BoundCheckpointStore::save(const std::string& candidate) noexcept {
	bool publishing = false;
	try {
		std::unique_lock<std::mutex> local(mutex_, std::try_to_lock);
		if (!local.owns_lock()) return BoundCheckpointStatus::busy;
		if (compare_bound_checkpoints(candidate, nullptr, trust_, expected_) != BoundCheckpointDecision::replace)
			return BoundCheckpointStatus::invalid_candidate;
		const auto acquired = storage_->lock();
		if (acquired != BoundCheckpointIo::ok)
			return acquired == BoundCheckpointIo::busy ? BoundCheckpointStatus::busy
													   : BoundCheckpointStatus::storage_error;
		Unlock unlock{*storage_};
		Slots slots;
		const auto read = read_slots(*storage_, trust_, expected_, slots);
		if (read != BoundCheckpointStatus::loaded && read != BoundCheckpointStatus::missing) return read;
		const auto compared = compare_bound_checkpoints(
			candidate, read == BoundCheckpointStatus::missing ? nullptr : &slots.token[slots.winner], trust_,
			expected_);
		if (compared != BoundCheckpointDecision::replace && compared != BoundCheckpointDecision::unchanged)
			return decision(compared);
		if (compared == BoundCheckpointDecision::unchanged && slots.present[1 - slots.winner] &&
			slots.token[1 - slots.winner] == candidate) {
			publishing = true;
			if (storage_->confirm(0, candidate) != BoundCheckpointIo::ok ||
				storage_->confirm(1, candidate) != BoundCheckpointIo::ok)
				return BoundCheckpointStatus::commit_unknown;
			Slots confirmed;
			if (read_slots(*storage_, trust_, expected_, confirmed) != BoundCheckpointStatus::loaded ||
				!confirmed.present[0] || !confirmed.present[1] || confirmed.token[0] != candidate ||
				confirmed.token[1] != candidate)
				return BoundCheckpointStatus::commit_unknown;
			return BoundCheckpointStatus::unchanged;
		}
		unsigned target = read == BoundCheckpointStatus::missing ? 0 : 1 - slots.winner;
		// Stage all token copies before the first publication.
		Slots after_first = slots;
		after_first.token[target] = candidate;
		after_first.present[target] = true;
		publishing = true;
		auto result = publish(*storage_, target, candidate, slots, trust_, expected_);
		if (result != BoundCheckpointStatus::saved) return result;
		const unsigned mirror = 1 - target;
		if (!after_first.present[mirror] || after_first.token[mirror] != candidate) {
			result = publish(*storage_, mirror, candidate, after_first, trust_, expected_);
			if (result != BoundCheckpointStatus::saved)
				return result == BoundCheckpointStatus::storage_error ? BoundCheckpointStatus::mirror_pending
																	  : BoundCheckpointStatus::commit_unknown;
		}
		return BoundCheckpointStatus::saved;
	} catch (...) {
		return publishing ? BoundCheckpointStatus::commit_unknown : BoundCheckpointStatus::storage_error;
	}
}
}  // namespace device_identity
}  // namespace license
