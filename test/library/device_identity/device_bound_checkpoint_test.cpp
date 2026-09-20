#define BOOST_TEST_MODULE device_bound_checkpoint_test
#include <boost/test/unit_test.hpp>
#include "bound_checkpoint.hpp"
#include "bound_session_signer.hpp"
#include <future>
#include <functional>

using namespace license::device_identity;
namespace {
struct Fixture {
	SessionTestSigner signer;
	BoundSessionContext context;
	BoundResumeExpected expected;
	Fixture() {
		context.lease = {"https://issuer.test",
						 "app",
						 "CAD",
						 "DEFAULT",
						 std::string(64, 'a'),
						 std::string(22, 'A'),
						 "sha256:" + std::string(64, 'b'),
						 "",
						 1,
						 0};
		expected = {context.lease.issuer, context.lease.audience, "CAD", "DEFAULT", context.lease.device_key_id};
	}
	std::string token(std::uint64_t revision, std::uint64_t issued = 2000000000,
					  const std::string& operation = std::string(43, 'A')) {
		const auto initial = signer.lease(context, operation, revision);
		ParsedBoundLease parsed;
		BOOST_REQUIRE(decode_bound_lease(initial, parsed));
		std::string payload(parsed.payload.begin(), parsed.payload.end());
		const auto replace = [&](const char* field, std::uint64_t value) {
			const auto start = payload.find(std::string(field) + '=') + std::strlen(field) + 1;
			payload.replace(start, payload.find('\n', start) - start, std::to_string(value));
		};
		replace("issued-at", issued);
		replace("renew-after", issued + 43200);
		replace("expires-at", issued + 86400);
		return signer.sign(payload);
	}
	BoundCheckpointDecision compare(const std::string& next, const std::string* current) {
		return compare_bound_checkpoints(next, current, {{signer.spki, false}}, expected);
	}
};
struct Files {
	std::mutex lock;
	std::string slots[2];
	bool present[2]{};
	unsigned writes = 0, fail_write = 0;
	unsigned confirmations = 0, fail_confirmation = 0;
	enum class Fault { none, before, after, corrupt, reread, other_changed, other_missing } fault = Fault::none;
	std::string other_token;
	bool read_failure = false;
	std::function<void()> write_hook;
};
class MemoryStorage final : public BoundCheckpointStorage {
	std::shared_ptr<Files> files_;

public:
	explicit MemoryStorage(std::shared_ptr<Files> files) : files_(std::move(files)) {}
	BoundCheckpointIo lock() noexcept override {
		return files_->lock.try_lock() ? BoundCheckpointIo::ok : BoundCheckpointIo::busy;
	}
	void unlock() noexcept override { files_->lock.unlock(); }
	BoundCheckpointIo read(unsigned slot, std::string& out) noexcept override {
		try {
			if (files_->read_failure) return BoundCheckpointIo::error;
			if (!files_->present[slot]) return BoundCheckpointIo::missing;
			out = files_->slots[slot];
			return BoundCheckpointIo::ok;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
	BoundCheckpointIo publish(unsigned slot, const std::string& token) noexcept override {
		try {
			++files_->writes;
			if (files_->write_hook) files_->write_hook();
			const auto fault = files_->writes == files_->fail_write ? files_->fault : Files::Fault::none;
			if (fault == Files::Fault::before) return BoundCheckpointIo::error;
			files_->slots[slot] = fault == Files::Fault::corrupt ? "incomplete" : token;
			files_->present[slot] = true;
			if (fault == Files::Fault::reread) files_->read_failure = true;
			if (fault == Files::Fault::other_changed) files_->slots[1 - slot] = files_->other_token;
			if (fault == Files::Fault::other_missing) files_->present[1 - slot] = false;
			return fault == Files::Fault::none ? BoundCheckpointIo::ok : BoundCheckpointIo::error;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
	BoundCheckpointIo confirm(unsigned slot, const std::string& token) noexcept override {
		++files_->confirmations;
		return files_->confirmations != files_->fail_confirmation && files_->present[slot] &&
					   files_->slots[slot] == token
				   ? BoundCheckpointIo::ok
				   : BoundCheckpointIo::error;
	}
};
std::unique_ptr<BoundCheckpointStore> store(Fixture& f, const std::shared_ptr<Files>& files) {
	auto value =
		BoundCheckpointStore::create(std::make_unique<MemoryStorage>(files), {{f.signer.spki, false}}, f.expected);
	BOOST_REQUIRE(value);
	return value;
}
}  // namespace
BOOST_AUTO_TEST_CASE(revision_dominates_signed_time_and_arrival_order) {
	Fixture f;
	auto current = f.token(7, 2000000100);
	BOOST_CHECK(f.compare(current, nullptr) == BoundCheckpointDecision::replace);
	BOOST_CHECK(f.compare(current, &current) == BoundCheckpointDecision::unchanged);
	BOOST_CHECK(f.compare(f.token(6, 2000000200), &current) == BoundCheckpointDecision::stale);
	BOOST_CHECK(f.compare(f.token(8, 2000000000), &current) == BoundCheckpointDecision::replace);
	const auto newer = f.token(8, 2000000000);
	BOOST_CHECK(f.compare(current, &newer) == BoundCheckpointDecision::stale);
}
BOOST_AUTO_TEST_CASE(equal_revision_requires_signed_freshness_or_exact_idempotency) {
	Fixture f;
	auto current = f.token(7, 2000000100);
	BOOST_CHECK(f.compare(f.token(7, 2000000101), &current) == BoundCheckpointDecision::replace);
	BOOST_CHECK(f.compare(f.token(7, 2000000099), &current) == BoundCheckpointDecision::stale);
	BOOST_CHECK(f.compare(f.token(7, 2000000100, std::string(42, 'B') + "A"), &current) ==
				BoundCheckpointDecision::conflict);
	// Both keys stay trusted while a newer signed checkpoint migrates storage.
	SessionTestSigner rotated;
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(f.token(7, 2000000101), parsed));
	std::string payload(parsed.payload.begin(), parsed.payload.end());
	P256Digest digest;
	BOOST_REQUIRE(sha256(rotated.spki.data(), rotated.spki.size(), digest));
	const auto start = payload.find("key-id=") + 7;
	payload.replace(start, payload.find('\n', start) - start,
					bound_encoding::base64url("sha256:" + lowercase_hex(digest.data(), digest.size())));
	const auto candidate = rotated.sign(payload);
	BOOST_CHECK(compare_bound_checkpoints(candidate, &current, {{f.signer.spki, false}, {rotated.spki, false}},
										  f.expected) == BoundCheckpointDecision::replace);
	BOOST_CHECK(compare_bound_checkpoints(candidate, &current, {{f.signer.spki, true}, {rotated.spki, false}},
										  f.expected) == BoundCheckpointDecision::invalid_stored);
	BOOST_CHECK(compare_bound_checkpoints(current, &candidate, {{f.signer.spki, false}}, f.expected) ==
				BoundCheckpointDecision::invalid_stored);
}
BOOST_AUTO_TEST_CASE(authenticated_different_binding_generation_or_license_needs_explicit_recovery) {
	Fixture f;
	auto current = f.token(7);
	const auto original = f.context;
	for (unsigned field = 0; field < 3; ++field) {
		f.context = original;
		if (field == 0) f.context.lease.binding_id[0] = 'B';
		if (field == 1) f.context.lease.license_fingerprint = std::string(64, 'c');
		if (field == 2) f.context.lease.generation = 2;
		BOOST_CHECK(f.compare(f.token(8), &current) == BoundCheckpointDecision::conflict);
	}
}
BOOST_AUTO_TEST_CASE(invalid_stored_record_is_distinct_from_missing_and_cannot_be_overwritten) {
	Fixture f;
	auto candidate = f.token(7);
	std::string empty;
	BOOST_CHECK(f.compare(candidate, &empty) == BoundCheckpointDecision::invalid_stored);
	auto damaged = candidate;
	damaged.back() = damaged.back() == 'A' ? 'B' : 'A';
	BOOST_CHECK(f.compare(candidate, &damaged) == BoundCheckpointDecision::invalid_stored);
	BOOST_CHECK(f.compare(damaged, &candidate) == BoundCheckpointDecision::invalid_candidate);
	BOOST_CHECK(f.compare(std::string(8193, 'x'), nullptr) == BoundCheckpointDecision::invalid_candidate);
	f.expected.device_key_id = "sha256:" + std::string(64, 'c');
	BOOST_CHECK(f.compare(candidate, nullptr) == BoundCheckpointDecision::invalid_candidate);
}
BOOST_AUTO_TEST_CASE(store_mirrors_and_stale_writers_cannot_replace_the_winner) {
	Fixture f;
	auto files = std::make_shared<Files>();
	auto first = store(f, files), second = store(f, files);
	std::string out = "unchanged";
	BOOST_CHECK(first->load(out) == BoundCheckpointStatus::missing);
	BOOST_CHECK_EQUAL(out, "unchanged");
	const auto old = f.token(3), newer = f.token(7);
	BOOST_CHECK(first->save(old) == BoundCheckpointStatus::saved);
	BOOST_CHECK_EQUAL(files->slots[0], old);
	BOOST_CHECK_EQUAL(files->slots[1], old);
	BOOST_CHECK(second->save(newer) == BoundCheckpointStatus::saved);
	const auto writes = files->writes;
	BOOST_CHECK(first->save(old) == BoundCheckpointStatus::stale);
	BOOST_CHECK(first->save(newer) == BoundCheckpointStatus::unchanged);
	BOOST_CHECK_EQUAL(files->writes, writes);
	BOOST_CHECK(first->load(out) == BoundCheckpointStatus::loaded);
	BOOST_CHECK_EQUAL(out, newer);
}
BOOST_AUTO_TEST_CASE(prepublication_failure_preserves_winner_and_visible_unconfirmed_write_stops_mirroring) {
	Fixture f;
	const auto old = f.token(3), newer = f.token(7);
	for (auto fault : {Files::Fault::before, Files::Fault::after}) {
		auto files = std::make_shared<Files>();
		auto owner = store(f, files);
		BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
		files->fault = fault;
		files->fail_write = files->writes + 1;
		const auto result = owner->save(newer);
		BOOST_CHECK(result == (fault == Files::Fault::before ? BoundCheckpointStatus::storage_error
															 : BoundCheckpointStatus::commit_unknown));
		BOOST_CHECK_EQUAL(files->writes, 3);
		BOOST_CHECK_EQUAL(files->slots[0], old);
		std::string out;
		BOOST_REQUIRE(owner->load(out) == BoundCheckpointStatus::loaded);
		BOOST_CHECK_EQUAL(out, fault == Files::Fault::before ? old : newer);
	}
}
BOOST_AUTO_TEST_CASE(unexpected_mutation_of_other_slot_stops_without_mirror_or_rollback) {
	Fixture f;
	const auto old = f.token(3), newer = f.token(7), unexpected = f.token(8);
	for (auto fault : {Files::Fault::other_changed, Files::Fault::other_missing}) {
		auto files = std::make_shared<Files>();
		auto owner = store(f, files);
		BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
		files->fault = fault;
		files->fail_write = files->writes + 1;
		files->other_token = unexpected;
		BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::commit_unknown);
		BOOST_CHECK_EQUAL(files->writes, 3);
		BOOST_CHECK_EQUAL(files->slots[1], newer);
		if (fault == Files::Fault::other_changed)
			BOOST_CHECK_EQUAL(files->slots[0], unexpected);
		else
			BOOST_CHECK(!files->present[0]);
	}
}
BOOST_AUTO_TEST_CASE(uncertain_mirror_retains_first_completed_winner_and_invalid_secondary_blocks_load) {
	Fixture f;
	const auto old = f.token(3), newer = f.token(7);
	for (auto fault : {Files::Fault::corrupt, Files::Fault::reread}) {
		auto files = std::make_shared<Files>();
		auto owner = store(f, files);
		BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
		files->fault = fault;
		files->fail_write = files->writes + 2;
		BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::commit_unknown);
		BOOST_CHECK_EQUAL(files->slots[1], newer);
		BOOST_CHECK_EQUAL(files->writes, 4);
		std::string out = "unchanged";
		BOOST_CHECK(owner->load(out) == (fault == Files::Fault::corrupt ? BoundCheckpointStatus::invalid_stored
																		: BoundCheckpointStatus::storage_error));
		BOOST_CHECK_EQUAL(out, "unchanged");
	}
}
BOOST_AUTO_TEST_CASE(only_second_slot_can_resume_but_conflicting_committed_records_cannot) {
	Fixture f;
	auto files = std::make_shared<Files>();
	auto owner = store(f, files);
	const auto token = f.token(7);
	files->present[1] = true;
	files->slots[1] = token;
	std::string out;
	BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::loaded);
	BOOST_CHECK_EQUAL(out, token);
	BOOST_CHECK(owner->save(token) == BoundCheckpointStatus::saved);
	BOOST_CHECK_EQUAL(files->slots[0], token);
	const auto writes = files->writes;
	files->slots[0] = f.token(7, 2000000000, std::string(42, 'B') + "A");
	out = "unchanged";
	BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::conflict);
	BOOST_CHECK_EQUAL(out, "unchanged");
	BOOST_CHECK(owner->save(f.token(8)) == BoundCheckpointStatus::conflict);
	BOOST_CHECK_EQUAL(files->writes, writes);
	f.context.lease.generation = 2;
	files->slots[0] = f.token(8);
	BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::conflict);
	BOOST_CHECK_EQUAL(out, "unchanged");
}
BOOST_AUTO_TEST_CASE(identical_slots_after_unknown_mirror_require_confirmation_on_retry) {
	Fixture f;
	auto files = std::make_shared<Files>();
	auto owner = store(f, files);
	const auto old = f.token(3), newer = f.token(7);
	BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
	files->fault = Files::Fault::after;
	files->fail_write = files->writes + 2;
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::commit_unknown);
	BOOST_REQUIRE_EQUAL(files->slots[0], newer);
	BOOST_REQUIRE_EQUAL(files->slots[1], newer);
	const auto writes = files->writes;
	files->fail_confirmation = files->confirmations + 1;
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::commit_unknown);
	BOOST_CHECK_EQUAL(files->writes, writes);
	files->fail_confirmation = 0;
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::unchanged);
	BOOST_CHECK_EQUAL(files->writes, writes);
	BOOST_CHECK_EQUAL(files->confirmations, 3);
}
BOOST_AUTO_TEST_CASE(mirror_failure_retains_new_winner_and_retry_finishes_mirroring) {
	Fixture f;
	auto files = std::make_shared<Files>();
	auto owner = store(f, files);
	const auto old = f.token(3), newer = f.token(7);
	BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
	files->fault = Files::Fault::before;
	files->fail_write = files->writes + 2;
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::mirror_pending);
	BOOST_CHECK(files->slots[0] == newer || files->slots[1] == newer);
	std::string out;
	BOOST_REQUIRE(owner->load(out) == BoundCheckpointStatus::loaded);
	BOOST_CHECK_EQUAL(out, newer);
	files->fail_write = files->writes + 1;
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::storage_error);
	files->fault = Files::Fault::none;
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::saved);
	BOOST_CHECK_EQUAL(files->slots[0], newer);
	BOOST_CHECK_EQUAL(files->slots[1], newer);
}
BOOST_AUTO_TEST_CASE(uncertain_or_invalid_secondary_record_never_falls_back_or_rolls_back) {
	Fixture f;
	const auto old = f.token(3), newer = f.token(7);
	for (auto fault : {Files::Fault::corrupt, Files::Fault::reread}) {
		auto files = std::make_shared<Files>();
		auto owner = store(f, files);
		BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
		files->fault = fault;
		files->fail_write = files->writes + 1;
		BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::commit_unknown);
		BOOST_CHECK_EQUAL(files->slots[0], old);  // The original selected slot was never targeted.
		std::string out = "unchanged";
		BOOST_CHECK(owner->load(out) == (fault == Files::Fault::corrupt ? BoundCheckpointStatus::invalid_stored
																		: BoundCheckpointStatus::storage_error));
		BOOST_CHECK_EQUAL(out, "unchanged");
		const auto writes = files->writes;
		owner->save(newer);
		BOOST_CHECK_EQUAL(files->writes, writes);
	}
}
BOOST_AUTO_TEST_CASE(storage_lock_serializes_distinct_owners_and_busy_leaves_output_and_files_unchanged) {
	Fixture f;
	auto files = std::make_shared<Files>();
	auto first = store(f, files), second = store(f, files);
	const auto old = f.token(3), newer = f.token(7);
	BOOST_REQUIRE(first->save(old) == BoundCheckpointStatus::saved);
	std::promise<void> entered, release;
	auto released = release.get_future().share();
	unsigned hooks = 0;
	files->write_hook = [&] {
		if (++hooks == 1) {
			entered.set_value();
			released.wait();
		}
	};
	auto saving = std::async(std::launch::async, [&] { return first->save(newer); });
	entered.get_future().wait();
	std::string out = "unchanged";
	const auto load = second->load(out), save = second->save(old);
	release.set_value();
	const auto result = saving.get();
	BOOST_CHECK(load == BoundCheckpointStatus::busy);
	BOOST_CHECK(save == BoundCheckpointStatus::busy);
	BOOST_CHECK_EQUAL(out, "unchanged");
	BOOST_CHECK(result == BoundCheckpointStatus::saved);
	BOOST_CHECK(second->save(old) == BoundCheckpointStatus::stale);
}
