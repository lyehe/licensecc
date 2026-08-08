/*
 * hw_identifier_facade_test.cpp
 *
 *  Created on: Dec 26, 2019
 *      Author: devel
 */
#define BOOST_TEST_MODULE test_hw_identifier_facade

#include <algorithm>
#include <array>
#include <cstdlib>
#include <exception>
#include <stdexcept>
#include <string>
#include <vector>
#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>
#include <licensecc/licensecc.h>
#include <licensecc/datatypes.h>
#include "../../../src/library/base/base64.h"
#include "../../../src/library/hw_identifier/default_strategy.hpp"
#include "../../../src/library/hw_identifier/hw_identifier_facade.hpp"
#include "../../../src/library/hw_identifier/hw_identifier.hpp"
#include "../../../src/library/hw_identifier/identification_strategy.hpp"
#include "../../../src/library/os/os.h"

namespace license {
namespace test {
using namespace std;
using namespace license::hw_identifier;

static string identifier_for(vector<uint8_t> decoded) {
	string signature = base64(decoded.data(), decoded.size(), 5);
	replace(signature.begin(), signature.end(), '\n', '-');
	if (!signature.empty() && signature.back() == '-') {
		signature.pop_back();
	}
	return signature;
}

struct ScopedIdentificationStrategyEnv {
	explicit ScopedIdentificationStrategyEnv(const char* value) {
		const char* current = getenv(LCC_IDENTIFICATION_STRATEGY_ENV_VAR);
		if (current != nullptr) {
			had_old_value = true;
			old_value = current;
		}
		SETENV(LCC_IDENTIFICATION_STRATEGY_ENV_VAR, value);
	}

	~ScopedIdentificationStrategyEnv() {
		if (had_old_value) {
			SETENV(LCC_IDENTIFICATION_STRATEGY_ENV_VAR, old_value.c_str());
		} else {
			UNSETENV(LCC_IDENTIFICATION_STRATEGY_ENV_VAR);
		}
	}

	bool had_old_value = false;
	string old_value;
};

/**
 * A malformed signature must be rejected gracefully (the HwIdentifier
 * constructor throws on a bad size and the facade catches it), never crash.
 */
BOOST_AUTO_TEST_CASE(validate_malformed_signature) {
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature("not-a-valid-signature"), LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(""), LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature("AEBCQ0RFRkc="), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(validate_unsupported_strategy_signature) {
	const string signature = identifier_for({0x00, 0x60, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(signature), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(validate_rejects_weak_binding_by_default_policy) {
	const string ip_signature = identifier_for({0x00, 0x20, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
	const string env_signature = identifier_for({0x40, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(ip_signature), LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(env_signature), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(validate_weak_binding_policy_opt_in_reaches_strategy_validation) {
	const string ip_signature = identifier_for({0x00, 0x20, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
	const string env_signature = identifier_for({0x40, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
	BOOST_CHECK_NE(HwIdentifierFacade::validate_pc_signature(ip_signature, true, false), LICENSE_MALFORMED);
	BOOST_CHECK_NE(HwIdentifierFacade::validate_pc_signature(env_signature, false, true), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(validate_generated_weak_binding_passes_only_with_policy_opt_in) {
	try {
		const string ip_signature = HwIdentifierFacade::generate_user_pc_signature(STRATEGY_IP_ADDRESS);
		BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(ip_signature), LICENSE_MALFORMED);
		BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(ip_signature, true, false), LICENSE_OK);
	} catch (const exception& ex) {
		BOOST_TEST_MESSAGE(string("Skipping generated IP binding opt-in check: ") + ex.what());
	}

	try {
		ScopedIdentificationStrategyEnv env("2");
		const string env_signature = HwIdentifierFacade::generate_user_pc_signature(STRATEGY_DEFAULT);
		BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(env_signature), LICENSE_MALFORMED);
		BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(env_signature, false, true), LICENSE_OK);
	} catch (const exception& ex) {
		BOOST_TEST_MESSAGE(string("Skipping generated environment-selected binding opt-in check: ") + ex.what());
	}
}

/**
 * A well-formed signature that carries fake data parses successfully, is routed
 * through IdentificationStrategy::get_strategy, and then fails to match the real
 * machine. This exercises the strategy lookup path for a known strategy.
 */
BOOST_AUTO_TEST_CASE(validate_wellformed_unknown_signature) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier id;
	id.set_data(data);
	id.set_identification_strategy(STRATEGY_ETHERNET);
	const string signature = id.print();

	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(signature), IDENTIFIERS_MISMATCH);
}

BOOST_AUTO_TEST_CASE(parse_env_strategy_value_is_strict) {
	BOOST_CHECK_EQUAL(parse_identification_strategy_env_value(nullptr), STRATEGY_DEFAULT);
	BOOST_CHECK_EQUAL(parse_identification_strategy_env_value("0"), STRATEGY_ETHERNET);
	BOOST_CHECK_EQUAL(parse_identification_strategy_env_value("1"), STRATEGY_IP_ADDRESS);
	BOOST_CHECK_EQUAL(parse_identification_strategy_env_value("2"), STRATEGY_DISK);

	const vector<string> invalid_values = {"", "1abc", "1 ", "-1", "3", "4", " 1", "\t1", "+1",
										   "999999999999999999999"};
	for (const string& value : invalid_values) {
		BOOST_CHECK_THROW(parse_identification_strategy_env_value(value.c_str()), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(default_generation_rejects_malformed_env_strategy) {
	vector<string> invalid_values = {"1abc", "1 ", "-1", "3", "4", " 1", "\t1", "+1",
									 "999999999999999999999"};
#ifndef _WIN32
	invalid_values.push_back("");
#endif
	for (const string& value : invalid_values) {
		ScopedIdentificationStrategyEnv env(value.c_str());
		BOOST_CHECK_THROW(HwIdentifierFacade::generate_user_pc_signature(STRATEGY_DEFAULT), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(default_generation_marks_valid_env_selected_strategy) {
	struct StrategyCase {
		const char* env_value;
		LCC_API_HW_IDENTIFICATION_STRATEGY expected_strategy;
	};
	const StrategyCase cases[] = {{"0", STRATEGY_ETHERNET}, {"1", STRATEGY_IP_ADDRESS}, {"2", STRATEGY_DISK}};
	for (const StrategyCase& test_case : cases) {
		try {
			ScopedIdentificationStrategyEnv env(test_case.env_value);
			const string signature = HwIdentifierFacade::generate_user_pc_signature(STRATEGY_DEFAULT);
			const HwIdentifier id(signature);
			BOOST_CHECK_EQUAL(id.get_identification_strategy(), test_case.expected_strategy);
			BOOST_CHECK(id.uses_environment_var());
		} catch (const exception& ex) {
			BOOST_TEST_MESSAGE(string("Skipping env strategy ") + test_case.env_value + ": " + ex.what());
		}
	}
}

BOOST_AUTO_TEST_CASE(public_identify_pc_fails_closed_for_malformed_env_strategy) {
	const vector<string> invalid_values = {"1abc", "4", "+1", "999999999999999999999"};
	for (const string& value : invalid_values) {
		ScopedIdentificationStrategyEnv env(value.c_str());
		char identifier[LCC_API_PC_IDENTIFIER_SIZE + 1] = {};
		size_t buffer_size = sizeof(identifier);
		BOOST_CHECK(!identify_pc(STRATEGY_DEFAULT, identifier, &buffer_size, nullptr));
	}
}

BOOST_AUTO_TEST_CASE(default_strategy_skips_unsupported_configured_entries) {
	const DefaultStrategy strategy;
	BOOST_CHECK_NO_THROW(strategy.alternative_ids());

	const DefaultStrategy unsupported_only({STRATEGY_HOST_NAME, STRATEGY_NONE});
	HwIdentifier pc_id;
	BOOST_CHECK_EQUAL(unsupported_only.generate_pc_id(pc_id), FUNC_RET_NOT_AVAIL);
	BOOST_CHECK(unsupported_only.alternative_ids().empty());
}

BOOST_AUTO_TEST_CASE(host_name_strategy_is_reserved_and_fails_closed) {
	BOOST_CHECK_THROW(IdentificationStrategy::get_strategy(STRATEGY_HOST_NAME), logic_error);
	BOOST_CHECK_THROW(HwIdentifierFacade::generate_user_pc_signature(STRATEGY_HOST_NAME), logic_error);

	char identifier[LCC_API_PC_IDENTIFIER_SIZE + 1] = {};
	size_t buffer_size = sizeof(identifier);
	BOOST_CHECK(!identify_pc(STRATEGY_HOST_NAME, identifier, &buffer_size, nullptr));
	BOOST_CHECK_EQUAL(identifier[0], '\0');
}

BOOST_AUTO_TEST_CASE(default_strategy_can_skip_sentinel_entries_before_supported_entries) {
	const DefaultStrategy strategy({STRATEGY_NONE, STRATEGY_HOST_NAME, STRATEGY_ETHERNET});
	BOOST_CHECK_NO_THROW(strategy.alternative_ids());
}

}  // namespace test
}  // namespace license
