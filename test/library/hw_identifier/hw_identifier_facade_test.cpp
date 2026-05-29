/*
 * hw_identifier_facade_test.cpp
 *
 *  Created on: Dec 26, 2019
 *      Author: devel
 */
#define BOOST_TEST_MODULE test_hw_identifier_facade

#include <array>
#include <string>
#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>
#include <licensecc/datatypes.h>
#include "../../../src/library/hw_identifier/hw_identifier_facade.hpp"
#include "../../../src/library/hw_identifier/hw_identifier.hpp"

namespace license {
namespace test {
using namespace std;
using namespace license::hw_identifier;

/**
 * A malformed signature must be rejected gracefully (the HwIdentifier
 * constructor throws on a bad size and the facade catches it), never crash.
 */
BOOST_AUTO_TEST_CASE(validate_malformed_signature) {
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature("not-a-valid-signature"), IDENTIFIERS_MISMATCH);
	BOOST_CHECK_EQUAL(HwIdentifierFacade::validate_pc_signature(""), IDENTIFIERS_MISMATCH);
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

}  // namespace test
}  // namespace license
