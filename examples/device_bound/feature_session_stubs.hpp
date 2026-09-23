#ifndef LICENSECC_EXAMPLE_FEATURE_STUBS_HPP_
#define LICENSECC_EXAMPLE_FEATURE_STUBS_HPP_
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
#endif
