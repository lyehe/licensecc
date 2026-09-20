#include <licensecc/feature_session.h>
#include <cstring>
#include <map>
#include <sstream>
#include <stdexcept>
#include <vector>
namespace feature_fixture {
std::map<LccFeatureSession*, std::string> features;
std::vector<std::string> opened;
unsigned starts = 0, checks = 0, stops = 0, closes = 0, renewals = 0;
unsigned deny_check = 0;
bool reject_start = false, due = false, reject_renew = false;
LCC_BOUND_RESULT open(const LccDeviceBoundOptions* options, LccFeatureSession** owner, LccFeatureSessionOutcome*) {
	*owner = reinterpret_cast<LccFeatureSession*>(static_cast<uintptr_t>(opened.size() + 1));
	features[*owner] = options->feature;
	opened.emplace_back(options->feature);
	return LCC_BOUND_OK;
}
LCC_BOUND_RESULT start(LccFeatureSession*, LccFeatureSessionOutcome*) {
	++starts;
	return reject_start ? LCC_BOUND_DENIED : LCC_BOUND_OK;
}
LCC_BOUND_RESULT authorize(LccFeatureSession* owner, const char* feature, LccFeatureSessionOutcome* out) {
	++checks;
	out->state = LCC_FEATURE_SESSION_ACTIVE;
	out->renewal_due = due;
	return features.at(owner) != feature || checks == deny_check ? LCC_BOUND_DENIED : LCC_BOUND_OK;
}
LCC_BOUND_RESULT renew(LccFeatureSession*, LccFeatureSessionOutcome*) {
	++renewals;
	return reject_renew ? LCC_BOUND_DENIED : LCC_BOUND_OK;
}
LCC_BOUND_RESULT stop(LccFeatureSession*, LccFeatureSessionOutcome*) {
	++stops;
	return LCC_BOUND_OK;
}
LCC_BOUND_RESULT save(LccFeatureSession*, LccFeatureSessionOutcome*) {
	throw std::runtime_error("unexpected persistence");
}
void close(LccFeatureSession* owner) {
	features.erase(owner);
	++closes;
}
void reset() {
	if (!features.empty()) throw std::runtime_error("leaked session");
	opened.clear();
	starts = checks = stops = closes = renewals = deny_check = 0;
	reject_start = due = reject_renew = false;
}
}  // namespace feature_fixture
#define lcc_feature_session_open feature_fixture::open
#define lcc_feature_session_start feature_fixture::start
#define lcc_feature_session_authorize feature_fixture::authorize
#define lcc_feature_session_renew feature_fixture::renew
#define lcc_feature_session_stop feature_fixture::stop
#define lcc_feature_session_save_checkpoint feature_fixture::save
#define lcc_feature_session_close feature_fixture::close
#define main feature_example_main
#include "feature_sessions.cpp"
#undef main
void require(bool value) {
	if (!value) throw std::runtime_error("feature example flow assertion failed");
}
int main() {
	using namespace feature_fixture;
	// These tests characterize application guards, not native/server enforcement.
	const char* path = "feature-session-example-input.tmp";
	{
		std::ofstream file(path, std::ios::binary);
		file << "abc";
	}
	std::ostringstream output;
	auto* previous = std::cout.rdbuf(output.rdbuf());
	int result = 0;
	try {
		Report report;
		require(run_batch(path, report) && run_batch(path, report) && export_report(report));
		require(opened == std::vector<std::string>({"BATCH_RUN", "BATCH_RUN", "EXPORT"}));
		require(starts == 3 && checks == 5 && stops == 3 && closes == 3);
		require(report.bytes == 3 && report.checksum == 294 && output.str() == "bytes,checksum\n3,294\n");
		reset();
		reject_start = true;
		report = {99, 99};
		require(!run_batch(path, report) && starts == 1 && checks == 0 && closes == 1 && report.bytes == 99);
		reset();
		deny_check = 1;
		require(!run_batch(path, report) && checks == 1 && report.bytes == 99 && closes == 1);
		reset();
		deny_check = 2;
		require(!run_batch(path, report) && checks == 2 && report.bytes == 99 && closes == 1);
		reset();
		output.str("");
		deny_check = 1;
		require(!export_report(report) && output.str().empty() && closes == 1);
		reset();
		due = true;
		reject_renew = true;
		require(!run_batch(path, report) && renewals == 1 && report.bytes == 99 && closes == 1);
		reset();
		due = true;
		require(run_batch(path, report) && renewals == 2 && checks == 4 && closes == 1);
		reset();
		cancelled = 1;
		require(!run_batch(path, report) && starts == 0 && checks == 0 && closes == 1);
		reset();
		cancelled = 0;
	} catch (const std::exception& error) {
		std::cerr << error.what() << '\n';
		result = 1;
	}
	std::cout.rdbuf(previous);
	std::remove(path);
	return result;
}
