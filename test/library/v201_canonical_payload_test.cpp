#define BOOST_TEST_MODULE test_v201_canonical_payload

#include <boost/test/unit_test.hpp>
#include <licensecc_properties_test.h>

#include "../../src/library/base/v201_canonical_payload.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using license::v201::CanonicalField;
using license::v201::CanonicalPayloadResult;
using license::v201::build_canonical_payload;
using license::v201::canonical_payload_hex;
using namespace std;

static const char* kGoldenKeyId = "sha256:9d1797cf21f0341f364b7af016a745580fd36b78b17cd1630d1049879fe9ecf2";

static vector<CanonicalField> minimal_fields() {
	return {
		{"feature", "DEFAULT"},
		{"key-id", "sha256:0000000000000000000000000000000000000000000000000000000000000000"},
		{"sig-alg", "rsa-pkcs1-sha256"},
		{"project", "MY_PRODUCT"},
		{"sig-v", "1"},
		{"lic_ver", "201"},
		{"canonical-v", "1"},
	};
}

static string payload_string(const CanonicalPayloadResult& result) {
	return string(result.bytes.begin(), result.bytes.end());
}

static string read_fixture(const string& name) {
	const string path = string(PROJECT_TEST_SRC_DIR) + "/vectors/v201/" + name;
	ifstream input(path.c_str(), ios::binary);
	BOOST_REQUIRE_MESSAGE(input.is_open(), "can open v201 fixture " + path);
	return string((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
}

static string compact_ascii_whitespace(const string& value) {
	string out;
	for (const unsigned char ch : value) {
		if (!isspace(ch)) {
			out.push_back(static_cast<char>(ch));
		}
	}
	return out;
}

static vector<CanonicalField> golden_minimal_fields() {
	return {
		{"lic_ver", "201"},
		{"canonical-v", "1"},
		{"sig-v", "1"},
		{"sig-alg", "rsa-pkcs1-sha256"},
		{"key-id", kGoldenKeyId},
		{"project", "MY_PRODUCT"},
		{"feature", "MY_PRODUCT"},
	};
}

static vector<CanonicalField> golden_full_fields() {
	vector<CanonicalField> fields = golden_minimal_fields();
	fields.push_back({"valid-from", "2024-01-02"});
	fields.push_back({"valid-to", "2035-12-31"});
	fields.push_back({"start-version", "1.2.3"});
	fields.push_back({"end-version", "9.9.9"});
	fields.push_back({"client-signature", "AEBC-Q0RF-Rkc="});
	fields.push_back({"client-signature-source-strength", "strong-disk-serial-or-uuid"});
	fields.push_back({"extra-data", "alpha"});
	return fields;
}

BOOST_AUTO_TEST_CASE(v201_minimal_payload_is_length_framed_and_byte_stable) {
	const CanonicalPayloadResult result = build_canonical_payload(minimal_fields());
	BOOST_REQUIRE_MESSAGE(result.ok, result.error);

	const string expected =
		"licensecc:v201\n"
		"k00000007:lic_verv00000003:201\n"
		"k0000000b:canonical-vv00000001:1\n"
		"k00000005:sig-vv00000001:1\n"
		"k00000007:sig-algv00000010:rsa-pkcs1-sha256\n"
		"k00000006:key-idv00000047:sha256:0000000000000000000000000000000000000000000000000000000000000000\n"
		"k00000007:projectv0000000a:MY_PRODUCT\n"
		"k00000007:featurev00000007:DEFAULT\n";
	BOOST_CHECK_EQUAL(payload_string(result), expected);

	vector<CanonicalField> shuffled = minimal_fields();
	reverse(shuffled.begin(), shuffled.end());
	const CanonicalPayloadResult shuffled_result = build_canonical_payload(shuffled);
	BOOST_REQUIRE_MESSAGE(shuffled_result.ok, shuffled_result.error);
	BOOST_CHECK_EQUAL(payload_string(shuffled_result), expected);
}

BOOST_AUTO_TEST_CASE(v201_full_payload_uses_fixed_field_order) {
	vector<CanonicalField> fields = minimal_fields();
	fields.push_back({"extra-data", "alpha"});
	fields.push_back({"client-signature-source-strength", "strong-disk-serial-or-uuid"});
	fields.push_back({"client-signature", "AEBC-Q0RF-Rkc="});
	fields.push_back({"end-version", "1.10"});
	fields.push_back({"start-version", "1.2"});
	fields.push_back({"valid-to", "2050-12-31"});
	fields.push_back({"valid-from", "2020-01-01"});

	const CanonicalPayloadResult result = build_canonical_payload(fields);
	BOOST_REQUIRE_MESSAGE(result.ok, result.error);
	const string payload = payload_string(result);

	BOOST_CHECK_LT(payload.find("feature"), payload.find("valid-from"));
	BOOST_CHECK_LT(payload.find("valid-from"), payload.find("valid-to"));
	BOOST_CHECK_LT(payload.find("valid-to"), payload.find("start-version"));
	BOOST_CHECK_LT(payload.find("start-version"), payload.find("end-version"));
	BOOST_CHECK_LT(payload.find("end-version"), payload.find("client-signature"));
	BOOST_CHECK_LT(payload.find("client-signature"), payload.find("client-signature-source-strength"));
	BOOST_CHECK_LT(payload.find("client-signature-source-strength"), payload.find("extra-data"));
}

BOOST_AUTO_TEST_CASE(v201_golden_payload_files_are_byte_exact) {
	const pair<string, vector<CanonicalField>> cases[] = {
		{"minimal", golden_minimal_fields()},
		{"full", golden_full_fields()},
	};
	for (const auto& test_case : cases) {
		BOOST_TEST_CONTEXT(test_case.first) {
			const CanonicalPayloadResult result = build_canonical_payload(test_case.second);
			BOOST_REQUIRE_MESSAGE(result.ok, result.error);
			BOOST_CHECK_EQUAL(canonical_payload_hex(result.bytes),
							  compact_ascii_whitespace(read_fixture(test_case.first + ".payload.hex")));

			const string license_text = read_fixture(test_case.first + ".license");
			BOOST_CHECK_NE(license_text.find(string("sig-alg = rsa-pkcs1-sha256")), string::npos);
			BOOST_CHECK_NE(license_text.find(string("key-id = ") + kGoldenKeyId), string::npos);
			BOOST_CHECK_NE(license_text.find(string("sig = ") + read_fixture(test_case.first + ".signature.b64")),
						   string::npos);
			BOOST_CHECK_EQUAL(compact_ascii_whitespace(read_fixture(test_case.first + ".expected-result")),
							  "FUNC_RET_OK");
		}
	}
}

BOOST_AUTO_TEST_CASE(v201_payload_rejects_noncanonical_metadata) {
	vector<pair<string, vector<CanonicalField>>> cases;

	vector<CanonicalField> wrong_version = minimal_fields();
	wrong_version[5].value = "200";
	cases.push_back({"wrong lic_ver", wrong_version});

	vector<CanonicalField> alias_algorithm = minimal_fields();
	alias_algorithm[2].value = "RSA-PKCS1-SHA256";
	cases.push_back({"algorithm alias", alias_algorithm});

	vector<CanonicalField> bad_key_id = minimal_fields();
	bad_key_id[1].value = "sha256:ABC0000000000000000000000000000000000000000000000000000000000000";
	cases.push_back({"bad key-id", bad_key_id});

	vector<CanonicalField> lowercase_feature = minimal_fields();
	lowercase_feature[0].value = "default";
	cases.push_back({"noncanonical feature", lowercase_feature});

	vector<CanonicalField> with_sig = minimal_fields();
	with_sig.push_back({"sig", "QUJDRA=="});
	cases.push_back({"sig included", with_sig});

	vector<CanonicalField> unknown = minimal_fields();
	unknown.push_back({"critical-new-field", "value"});
	cases.push_back({"unknown field", unknown});

	vector<CanonicalField> high_bit_key = minimal_fields();
	high_bit_key.push_back({string("extra-") + static_cast<char>(0x80), "value"});
	cases.push_back({"high-bit key", high_bit_key});

	vector<CanonicalField> duplicate = minimal_fields();
	duplicate.push_back({"feature", "OTHER"});
	cases.push_back({"duplicate field", duplicate});

	vector<CanonicalField> control_value = minimal_fields();
	control_value[3].value = string("MY\nPRODUCT");
	cases.push_back({"control value", control_value});

	vector<CanonicalField> del_value = minimal_fields();
	del_value.push_back({"extra-data", string("alpha") + static_cast<char>(0x7f)});
	cases.push_back({"DEL value", del_value});

	vector<CanonicalField> high_bit_value = minimal_fields();
	high_bit_value.push_back({"extra-data", string("caf") + static_cast<char>(0xe9)});
	cases.push_back({"high-bit value", high_bit_value});

	vector<CanonicalField> bad_date = minimal_fields();
	bad_date.push_back({"valid-to", "2050-02-30"});
	cases.push_back({"bad date", bad_date});

	vector<CanonicalField> inverted_date = minimal_fields();
	inverted_date.push_back({"valid-from", "2050-01-01"});
	inverted_date.push_back({"valid-to", "2020-01-01"});
	cases.push_back({"inverted date", inverted_date});

	vector<CanonicalField> bad_version = minimal_fields();
	bad_version.push_back({"start-version", "1..2"});
	cases.push_back({"bad version", bad_version});

	vector<CanonicalField> bad_source_strength = minimal_fields();
	bad_source_strength.push_back({"client-signature", "AEBC-Q0RF-Rkc="});
	bad_source_strength.push_back({"client-signature-source-strength", "disk"});
	cases.push_back({"bad client-signature-source-strength", bad_source_strength});

	vector<CanonicalField> missing_source_strength = minimal_fields();
	missing_source_strength.push_back({"client-signature", "AEBC-Q0RF-Rkc="});
	cases.push_back({"client signature without source strength", missing_source_strength});

	vector<CanonicalField> source_strength_without_client_signature = minimal_fields();
	source_strength_without_client_signature.push_back({"client-signature-source-strength",
													   "strong-disk-serial-or-uuid"});
	cases.push_back({"source strength without client signature", source_strength_without_client_signature});

	vector<CanonicalField> inverted_version = minimal_fields();
	inverted_version.push_back({"start-version", "2.0"});
	inverted_version.push_back({"end-version", "1.10"});
	cases.push_back({"inverted version", inverted_version});

	vector<CanonicalField> missing = minimal_fields();
	missing.erase(missing.begin() + 1);
	cases.push_back({"missing required", missing});

	for (const auto& test_case : cases) {
		BOOST_TEST_CONTEXT(test_case.first) {
			const CanonicalPayloadResult result = build_canonical_payload(test_case.second);
			BOOST_CHECK_MESSAGE(!result.ok, "unexpectedly accepted payload");
			BOOST_CHECK_MESSAGE(!result.error.empty(), "failure includes a diagnostic");
			BOOST_CHECK_MESSAGE(result.bytes.empty(), "failed payload does not return signed bytes");
		}
	}
}
