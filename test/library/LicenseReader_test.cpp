#define BOOST_TEST_MODULE "test_license_reader"
#define __STDC_WANT_LIB_EXT1__ 1

#include <string>

#include <boost/test/unit_test.hpp>
#include <fstream>
#include <iostream>
#include <vector>
#include <stdlib.h>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>
#include <licensecc/datatypes.h>

#include "../../src/library/base/EventRegistry.h"
#include "../../src/library/os/os.h"
#include "../../src/library/locate/LocatorFactory.hpp"
#include "../../src/library/LicenseReader.hpp"
namespace license {
namespace test {

using namespace license;
using namespace std;

static string write_reader_fixture(const string &name, const string &license_text) {
	const string path = string(PROJECT_TEST_TEMP_DIR) + "/" + name + ".ini";
	ofstream out(path.c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write reader fixture: " + path);
	out << license_text;
	return path;
}

static EventRegistry read_fixture_text(const string &name, const string &license_text,
									   vector<FullLicenseInfo> &licenseInfos,
									   const string &product = "PRODUCT") {
	const string location = write_reader_fixture(name, license_text);
	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(location.begin(), location.end(), licLocation.licenseData);
	LicenseReader licenseReader(&licLocation);
	return licenseReader.readLicenses(product, licenseInfos);
}

static void expect_malformed_fixture(const string &name, const string &license_text) {
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = read_fixture_text(name, license_text, licenseInfos);
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_MALFORMED, registry.getLastFailure()->event_type);
}

static string minimal_license_with(const string &line) {
	return string("[PRODUCT]\n") + line + "\nsig = QUJDRA==\n";
}

static string valid_minimal_section(const string &section) {
	return string("[") + section + "]\nlic_ver = 200\nsig = QUJDRA==\n";
}

static string v201_key_id() {
	return string("sha256:") + string(64, '0');
}

static string valid_minimal_v201_section(const string &section) {
	return string("[") + section + "]\n"
		   + "lic_ver = 201\n"
		   + "canonical-v = 1\n"
		   + "sig-v = 1\n"
		   + "sig-alg = rsa-pkcs1-sha256\n"
		   + "key-id = " + v201_key_id() + "\n"
		   + "sig = QUJDRA==\n";
}

static string minimal_v201_with(const string &body) {
	return string("[PRODUCT]\n") + body;
}

static string minimal_v201_with_signature(const string &signature) {
	return minimal_v201_with("lic_ver = 201\n"
							 "canonical-v = 1\n"
							 "sig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\n"
							 "key-id = " + v201_key_id() + "\n"
							 "sig = " + signature + "\n");
}

/**
 * Read license at application provided location
 */
BOOST_AUTO_TEST_CASE(read_single_file) {
	string location = PROJECT_TEST_SRC_DIR "/library/test_reader.ini";

	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(location.begin(), location.end(), licLocation.licenseData);
	LicenseReader licenseReader(&licLocation);
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = licenseReader.readLicenses("PrODUCT", licenseInfos);
	BOOST_CHECK(registry.isGood());
	BOOST_CHECK_EQUAL(1, licenseInfos.size());
}

/**
 * A license whose lic_ver does not match LCC_LICENSE_FORMAT_VERSION must be
 * rejected as malformed (regression: the accepted version used to be a bare
 * literal that contradicted the documented value).
 */
BOOST_AUTO_TEST_CASE(wrong_license_format_version_rejected) {
	string location = PROJECT_TEST_SRC_DIR "/library/test_reader_wrong_version.ini";
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(false);
	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(location.begin(), location.end(), licLocation.licenseData);
	LicenseReader licenseReader(&licLocation);
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = licenseReader.readLicenses("PRODUCT", licenseInfos);
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_ASSERT(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_MALFORMED, registry.getLastFailure()->event_type);
}

BOOST_AUTO_TEST_CASE(noncanonical_v200_license_version_rejected) {
	const vector<string> invalid_versions = {"lic_ver = 0200", "lic_ver = +200", "lic_ver = 200x", "lic_ver =  200",
											 "lic_ver = 200 "};
	for (size_t i = 0; i < invalid_versions.size(); ++i) {
		expect_malformed_fixture("reader_bad_lic_ver_" + to_string(i), minimal_license_with(invalid_versions[i]));
	}
}

BOOST_AUTO_TEST_CASE(canonical_v200_license_version_and_comments_are_accepted) {
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = read_fixture_text(
		"reader_valid_comments",
		"[PRODUCT]\n; leading comment\nlic_ver = 200\n# middle comment\nsig = QUJDRA==\n; trailing comment\n",
		licenseInfos);
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_VERSION], "200");
}

BOOST_AUTO_TEST_CASE(v200_raw_format_acceptance_matrix_matches_documentation) {
	const vector<string> valid_licenses = {
		"[PRODUCT]\r\nlic_ver=200\r\nsig=QUJDRA==\r\n",
		"[PRODUCT]\nlic_ver= 200\nsig= QUJDRA==\n",
		"[PRODUCT]\nlic_ver =200\nsig =QUJDRA==\n",
		"[product]\n# comment\nlic_ver = 200\n; comment\nsig = QUJDRA==\n",
	};
	for (size_t i = 0; i < valid_licenses.size(); ++i) {
		vector<FullLicenseInfo> licenseInfos;
		const EventRegistry registry =
			read_fixture_text("reader_raw_format_accept_" + to_string(i), valid_licenses[i], licenseInfos, "PRODUCT");
		BOOST_TEST_CONTEXT("accepted raw format row " << i) {
			BOOST_CHECK(registry.isGood());
			BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
			BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_VERSION], "200");
			BOOST_CHECK_EQUAL(licenseInfos[0].license_signature, "QUJDRA==");
		}
	}
}

BOOST_AUTO_TEST_CASE(v201_raw_format_acceptance_matrix_matches_documentation) {
	const vector<string> valid_licenses = {
		string("[PRODUCT]\r\n")
			+ "lic_ver=201\r\n"
			+ "canonical-v=1\r\n"
			+ "sig-v=1\r\n"
			+ "sig-alg=rsa-pkcs1-sha256\r\n"
			+ "key-id=" + v201_key_id() + "\r\n"
			+ "sig=QUJDRA==\r\n",
		string("[product]\n")
			+ "lic_ver= 201\n"
			+ "canonical-v= 1\n"
			+ "sig-v= 1\n"
			+ "sig-alg= rsa-pkcs1-sha256\n"
			+ "key-id= " + v201_key_id() + "\n"
			+ "sig= QUJDRA==\n",
		string("[PRODUCT]\n")
			+ "# comment\n"
			+ "lic_ver =201\n"
			+ "canonical-v =1\n"
			+ "sig-v =1\n"
			+ "sig-alg =rsa-pkcs1-sha256\n"
			+ "key-id =" + v201_key_id() + "\n"
			+ "; comment\n"
			+ "sig =QUJDRA==\n",
		valid_minimal_v201_section("PRODUCT"),
		string("[PRODUCT]\n")
			+ "lic_ver = 201\n"
			+ "canonical-v = 1\n"
			+ "sig-v = 1\n"
			+ "sig-alg = rsa-pkcs1-sha256\n"
			+ "key-id = " + v201_key_id() + "\n"
			+ "client-signature = AEBC-Q0RF-Rkc=\n"
			+ "client-signature-source-strength = strong-disk-serial-or-uuid\n"
			+ "sig = QUJDRA==\n",
	};
	for (size_t i = 0; i < valid_licenses.size(); ++i) {
		vector<FullLicenseInfo> licenseInfos;
		const EventRegistry registry =
			read_fixture_text("reader_v201_raw_format_accept_" + to_string(i), valid_licenses[i], licenseInfos,
							  "PRODUCT");
		BOOST_TEST_CONTEXT("accepted v201 raw format row " << i) {
			BOOST_CHECK(registry.isGood());
			BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
			BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_VERSION], "201");
			BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_CANONICAL_VERSION], "1");
			BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_SIGNATURE_VERSION], "1");
			BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_SIGNATURE_ALGORITHM], "rsa-pkcs1-sha256");
			BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[LICENSE_KEY_ID], v201_key_id());
			if (licenseInfos[0].m_limits.find(PARAM_CLIENT_SIGNATURE) != licenseInfos[0].m_limits.end()) {
				BOOST_CHECK_EQUAL(licenseInfos[0].m_limits[PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH],
								  "strong-disk-serial-or-uuid");
			}
			BOOST_CHECK_EQUAL(licenseInfos[0].license_signature, "QUJDRA==");
		}
	}
}

BOOST_AUTO_TEST_CASE(v201_noncanonical_delimiter_spacing_rejected) {
	expect_malformed_fixture("reader_v201_key_leading_space",
							 "[PRODUCT]\n lic_ver = 201\ncanonical-v = 1\nsig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\nkey-id = " + v201_key_id() + "\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_v201_key_extra_space",
							 "[PRODUCT]\nlic_ver  = 201\ncanonical-v = 1\nsig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\nkey-id = " + v201_key_id() + "\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_v201_key_tab_spacing",
							 "[PRODUCT]\nlic_ver\t= 201\ncanonical-v = 1\nsig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\nkey-id = " + v201_key_id() + "\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_v201_uppercase_key",
							 "[PRODUCT]\nLic_ver = 201\ncanonical-v = 1\nsig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\nkey-id = " + v201_key_id() + "\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_v201_value_extra_space",
							 "[PRODUCT]\nlic_ver =  201\ncanonical-v = 1\nsig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\nkey-id = " + v201_key_id() + "\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_v201_value_trailing_space",
							 "[PRODUCT]\nlic_ver = 201 \ncanonical-v = 1\nsig-v = 1\n"
							 "sig-alg = rsa-pkcs1-sha256\nkey-id = " + v201_key_id() + "\nsig = QUJDRA==\n");
}

BOOST_AUTO_TEST_CASE(v201_missing_required_metadata_rejected) {
	const vector<pair<string, string>> cases = {
		{"canonical_v",
		 minimal_v201_with("lic_ver = 201\n"
						   "sig-v = 1\n"
						   "sig-alg = rsa-pkcs1-sha256\n"
						   "key-id = " + v201_key_id() + "\n"
						   "sig = QUJDRA==\n")},
		{"sig_v",
		 minimal_v201_with("lic_ver = 201\n"
						   "canonical-v = 1\n"
						   "sig-alg = rsa-pkcs1-sha256\n"
						   "key-id = " + v201_key_id() + "\n"
						   "sig = QUJDRA==\n")},
		{"sig_alg",
		 minimal_v201_with("lic_ver = 201\n"
						   "canonical-v = 1\n"
						   "sig-v = 1\n"
						   "key-id = " + v201_key_id() + "\n"
						   "sig = QUJDRA==\n")},
		{"key_id",
		 minimal_v201_with("lic_ver = 201\n"
						   "canonical-v = 1\n"
						   "sig-v = 1\n"
						   "sig-alg = rsa-pkcs1-sha256\n"
						   "sig = QUJDRA==\n")},
		{"sig",
		 minimal_v201_with("lic_ver = 201\n"
						   "canonical-v = 1\n"
						   "sig-v = 1\n"
						   "sig-alg = rsa-pkcs1-sha256\n"
						   "key-id = " + v201_key_id() + "\n")},
	};
	for (size_t i = 0; i < cases.size(); ++i) {
		BOOST_TEST_CONTEXT("missing v201 metadata " << cases[i].first) {
			expect_malformed_fixture("reader_v201_missing_" + cases[i].first, cases[i].second);
		}
	}
}

BOOST_AUTO_TEST_CASE(v201_duplicate_keys_sections_and_unknown_keys_rejected) {
	const string common_tail = "canonical-v = 1\n"
							   "sig-v = 1\n"
							   "sig-alg = rsa-pkcs1-sha256\n"
							   "key-id = " + v201_key_id() + "\n"
							   "sig = QUJDRA==\n";
	expect_malformed_fixture("reader_v201_duplicate_lic_ver",
							 minimal_v201_with("lic_ver = 201\nlic_ver = 201\n" + common_tail));
	expect_malformed_fixture("reader_v201_duplicate_sig",
							 minimal_v201_with("lic_ver = 201\n" + common_tail + "sig = QUJDRA==\n"));
	expect_malformed_fixture("reader_v201_duplicate_product_section",
							 valid_minimal_v201_section("PRODUCT") + "\n[PRODUCT]\n" + common_tail);
	expect_malformed_fixture("reader_v201_unknown_key",
							 minimal_v201_with("lic_ver = 201\nunknown-key = value\n" + common_tail));
	expect_malformed_fixture("reader_v201_empty_key",
							 minimal_v201_with("lic_ver = 201\n = value\n" + common_tail));
}

BOOST_AUTO_TEST_CASE(v201_noncanonical_license_version_rejected) {
	const vector<string> invalid_versions = {"lic_ver = 0201", "lic_ver = +201", "lic_ver = 201x",
											 "lic_ver =  201", "lic_ver = 201 "};
	for (size_t i = 0; i < invalid_versions.size(); ++i) {
		expect_malformed_fixture(
			"reader_v201_bad_lic_ver_" + to_string(i),
			minimal_v201_with(invalid_versions[i] + "\n"
							  "canonical-v = 1\n"
							  "sig-v = 1\n"
							  "sig-alg = rsa-pkcs1-sha256\n"
							  "key-id = " + v201_key_id() + "\n"
							  "sig = QUJDRA==\n"));
	}
	expect_malformed_fixture(
		"reader_v201_duplicate_license_version",
		minimal_v201_with("lic_ver = 201\nlic_ver = 201\n"
						  "canonical-v = 1\n"
						  "sig-v = 1\n"
						  "sig-alg = rsa-pkcs1-sha256\n"
						  "key-id = " + v201_key_id() + "\n"
						  "sig = QUJDRA==\n"));
}

BOOST_AUTO_TEST_CASE(v201_invalid_signature_base64_rejected) {
	const vector<pair<string, string>> invalid_signatures = {
		{"empty", ""},
		{"bad_padding", "AAAA===="},
		{"bad_character", "!!!!"},
		{"truncated", "A"},
		{"nonzero_one_byte_pad_bits", "QR=="},
		{"nonzero_two_byte_pad_bits", "QUF="},
	};
	for (size_t i = 0; i < invalid_signatures.size(); ++i) {
		BOOST_TEST_CONTEXT("invalid v201 signature " << invalid_signatures[i].first) {
			expect_malformed_fixture("reader_v201_bad_sig_" + invalid_signatures[i].first,
									 minimal_v201_with_signature(invalid_signatures[i].second));
		}
	}
	string high_bit_signature = "QUJD";
	high_bit_signature.push_back(static_cast<char>(0x80));
	expect_malformed_fixture("reader_v201_bad_sig_high_bit", minimal_v201_with_signature(high_bit_signature));

	string embedded_nul_signature = "QUJD";
	embedded_nul_signature.push_back('\0');
	embedded_nul_signature += "RA==";
	expect_malformed_fixture("reader_v201_bad_sig_embedded_nul", minimal_v201_with_signature(embedded_nul_signature));
}

BOOST_AUTO_TEST_CASE(v201_malformed_requested_section_does_not_grant_through_unrelated_valid_section) {
	const string valid_product_with_bad_other =
		valid_minimal_v201_section("PRODUCT") + "\n[OTHER]\nunknown-key = value\n";
	vector<FullLicenseInfo> productInfos;
	EventRegistry registry = read_fixture_text("reader_v201_bad_other_valid_product",
											   valid_product_with_bad_other, productInfos, "PRODUCT");
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, productInfos.size());
	BOOST_CHECK_EQUAL(productInfos[0].m_project, "PRODUCT");

	vector<FullLicenseInfo> otherInfos;
	registry = read_fixture_text("reader_v201_bad_other_requested", valid_product_with_bad_other, otherInfos, "OTHER");
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, otherInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_MALFORMED, registry.getLastFailure()->event_type);

	const string bad_product_with_valid_other =
		"[PRODUCT]\nlic_ver = 201\nunknown-key = value\nsig = QUJDRA==\n\n"
		+ valid_minimal_v201_section("OTHER");
	vector<FullLicenseInfo> badProductInfos;
	registry = read_fixture_text("reader_v201_bad_product_requested", bad_product_with_valid_other, badProductInfos,
								 "PRODUCT");
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, badProductInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_MALFORMED, registry.getLastFailure()->event_type);

	vector<FullLicenseInfo> validOtherInfos;
	registry = read_fixture_text("reader_v201_bad_product_valid_other", bad_product_with_valid_other, validOtherInfos,
								 "OTHER");
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, validOtherInfos.size());
	BOOST_CHECK_EQUAL(validOtherInfos[0].m_project, "OTHER");
}

BOOST_AUTO_TEST_CASE(duplicate_v200_values_rejected) {
	expect_malformed_fixture("reader_duplicate_lic_ver",
							 "[PRODUCT]\nlic_ver = 200\nlic_ver = 200\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_duplicate_sig",
							 "[PRODUCT]\nlic_ver = 200\nsig = QUJDRA==\nsig = QUJDRA==\n");
	expect_malformed_fixture(
		"reader_duplicate_valid_to_conflict",
		"[PRODUCT]\nlic_ver = 200\nvalid-to = 2050-10-10\nvalid-to = 2050-10-11\nsig = QUJDRA==\n");
}

BOOST_AUTO_TEST_CASE(noncanonical_or_impossible_v200_dates_rejected) {
	const vector<string> invalid_dates = {"valid-to = 20501010", "valid-to = 2050/10/10",
										  "valid-to = 2050-02-30", "valid-to = 2021-02-29",
										  "valid-to = 2050-00-01", "valid-to = 2050-01-00",
										  "valid-to = 2050-13-01", "valid-to = 2050-10-10x",
										  "valid-to =  2050-10-10", "valid-to = 2050-10-10 "};
	for (size_t i = 0; i < invalid_dates.size(); ++i) {
		expect_malformed_fixture("reader_bad_date_" + to_string(i),
								 minimal_license_with(string("lic_ver = 200\n") + invalid_dates[i]));
	}
}

BOOST_AUTO_TEST_CASE(noncanonical_v200_signature_spacing_rejected) {
	expect_malformed_fixture("reader_bad_sig_leading_space", "[PRODUCT]\nlic_ver = 200\nsig =  QUJDRA==\n");
	expect_malformed_fixture("reader_bad_sig_trailing_space", "[PRODUCT]\nlic_ver = 200\nsig = QUJDRA== \n");
}

BOOST_AUTO_TEST_CASE(noncanonical_v200_signature_pad_bits_rejected) {
	expect_malformed_fixture("reader_bad_sig_one_byte_pad_bits", "[PRODUCT]\nlic_ver = 200\nsig = QR==\n");
	expect_malformed_fixture("reader_bad_sig_two_byte_pad_bits", "[PRODUCT]\nlic_ver = 200\nsig = QUF=\n");
}

BOOST_AUTO_TEST_CASE(v200_section_and_key_shape_attacks_rejected) {
	expect_malformed_fixture("reader_duplicate_product_section",
							 "[PRODUCT]\nlic_ver = 200\n[PRODUCT]\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_empty_key", "[PRODUCT]\nlic_ver = 200\n = value\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_key_leading_space",
							 "[PRODUCT]\n lic_ver = 200\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_key_extra_space",
							 "[PRODUCT]\nlic_ver  = 200\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_key_tab_spacing",
							 "[PRODUCT]\nlic_ver\t= 200\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_unknown_key",
							 "[PRODUCT]\nlic_ver = 200\nunknown-key = value\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_split_license_key",
							 "[PRODUCT]\nlic = _ver200\nsig = QUJDRA==\n");
	expect_malformed_fixture("reader_inline_comment_value",
							 "[PRODUCT]\nlic_ver = 200 ; comment\nsig = QUJDRA==\n");
}

BOOST_AUTO_TEST_CASE(unrelated_sections_do_not_grant_or_break_requested_feature) {
	const string valid_product_with_bad_other =
		valid_minimal_section("PRODUCT") + "\n[OTHER]\nunknown-key = value\n";
	vector<FullLicenseInfo> productInfos;
	EventRegistry registry = read_fixture_text("reader_bad_other_valid_product", valid_product_with_bad_other,
											   productInfos, "PRODUCT");
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, productInfos.size());
	BOOST_CHECK_EQUAL(productInfos[0].m_project, "PRODUCT");

	vector<FullLicenseInfo> otherInfos;
	registry = read_fixture_text("reader_bad_other_requested", valid_product_with_bad_other, otherInfos, "OTHER");
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, otherInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_MALFORMED, registry.getLastFailure()->event_type);

	const string bad_product_with_valid_other =
		"[PRODUCT]\nlic_ver = 200\nunknown-key = value\nsig = QUJDRA==\n\n" + valid_minimal_section("OTHER");
	vector<FullLicenseInfo> badProductInfos;
	registry = read_fixture_text("reader_bad_product_requested", bad_product_with_valid_other, badProductInfos,
								 "PRODUCT");
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, badProductInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_MALFORMED, registry.getLastFailure()->event_type);

	vector<FullLicenseInfo> validOtherInfos;
	registry = read_fixture_text("reader_bad_product_valid_other", bad_product_with_valid_other, validOtherInfos,
								 "OTHER");
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, validOtherInfos.size());
	BOOST_CHECK_EQUAL(validOtherInfos[0].m_project, "OTHER");
}

/**
 * Test the error return if the product code is not found in the license
 */
BOOST_AUTO_TEST_CASE(product_not_licensed) {
	string location = PROJECT_TEST_SRC_DIR "/library/test_reader.ini";
	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(location.begin(), location.end(), licLocation.licenseData);
	LicenseReader licenseReader(&licLocation);
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = licenseReader.readLicenses("PRODUCT-NOT", licenseInfos);
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_ASSERT(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(PRODUCT_NOT_LICENSED, registry.getLastFailure()->event_type);
}

/**
 * Test the error code if the license file is specified but doesn't exists
 */
BOOST_AUTO_TEST_CASE(file_not_found) {
	string licLocation = PROJECT_TEST_SRC_DIR "/library/not_found.ini";

	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(false);
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	LicenseReader licenseReader(&location);
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = licenseReader.readLicenses("PRODUCT", licenseInfos);
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_ASSERT(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_FILE_NOT_FOUND, registry.getLastFailure()->event_type);
}

/**
 * Test the error code if the license default environment variable isn't specified
 */
BOOST_AUTO_TEST_CASE(env_var_not_defined) {
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	LicenseReader licenseReader(nullptr);
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = licenseReader.readLicenses("PRODUCT", licenseInfos);
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_ASSERT(registry.getLastFailure() != NULL);
	BOOST_CHECK_MESSAGE((ENVIRONMENT_VARIABLE_NOT_DEFINED == registry.getLastFailure()->event_type),
						"error as expected");
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

/**
 * Test the error code if the license default environment variable is
 * specified but points to a non existent file.
 */
BOOST_AUTO_TEST_CASE(env_var_point_to_wrong_file) {
	const char *environment_variable_value = PROJECT_TEST_SRC_DIR "/this/file/doesnt/exist";
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, environment_variable_value)
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);

	LicenseReader licenseReader(nullptr);
	vector<FullLicenseInfo> licenseInfos;
	const EventRegistry registry = licenseReader.readLicenses("PRODUCT", licenseInfos);
	cout << registry << endl;
	BOOST_CHECK(!registry.isGood());
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_ASSERT(registry.getLastFailure() != NULL);
	BOOST_CHECK_EQUAL(LICENSE_FILE_NOT_FOUND, registry.getLastFailure()->event_type);
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}
}  // namespace test
}  // namespace license
