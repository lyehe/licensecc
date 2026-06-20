#define BOOST_TEST_MODULE test_inspector_section

#include <boost/test/unit_test.hpp>
#include <string>

#include <licensecc/licensecc.h>
#include <licensecc_properties_test.h>

#include "../../src/inspector/inspector_section.hpp"

// Regression coverage for the round-3 inspector over-read. The pre-fix code read a
// fixed 15 bytes from a NUL-terminated section name, so a short name compared
// incorrectly and the copied feature name carried out-of-bounds garbage.
// classify_inspector_section now reads the true length and bounds the feature name via
// the public setter; these tests pin that behavior so a revert is caught.

using lccinspector::classify_inspector_section;
using lccinspector::SectionAction;

BOOST_AUTO_TEST_CASE(default_project_section_is_skipped) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	BOOST_CHECK(classify_inspector_section(LCC_PROJECT_NAME, caller) == SectionAction::SkipDefaultProject);
}

BOOST_AUTO_TEST_CASE(short_feature_section_is_read_at_true_length) {
	// The pre-fix `string(ptr, 15)` turned "pro" into "pro" + 12 garbage bytes, so the
	// feature name was wrong. The true-length read must classify a feature carrying the
	// EXACT name "pro" (this assertion fails against the buggy code).
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	BOOST_REQUIRE(classify_inspector_section("pro", caller) == SectionAction::CheckFeature);
	BOOST_CHECK_EQUAL(std::string(caller.feature_name), "pro");
}

BOOST_AUTO_TEST_CASE(overlong_feature_name_is_rejected_and_cleared) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	const std::string too_long(static_cast<size_t>(LCC_API_FEATURE_NAME_SIZE) + 5, 'x');
	BOOST_CHECK(classify_inspector_section(too_long.c_str(), caller) == SectionAction::NameTooLong);
	BOOST_CHECK_EQUAL(std::string(caller.feature_name).size(), static_cast<size_t>(0));
}
