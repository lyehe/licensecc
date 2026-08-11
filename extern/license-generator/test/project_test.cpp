#define BOOST_TEST_MODULE test_project

#include <fstream>
#include <vector>
#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>
#include <build_properties.h>
#ifdef __unix__
#include <sys/stat.h>
#endif

#include "../src/license_generator/project.hpp"
#include "../src/ini/SimpleIni.h"
#include "../src/base_lib/base.h"
#ifdef _WIN32
#include "../src/base_lib/crypto_helper.hpp"
#include "windows_acl_test.hpp"
#endif

namespace fs = boost::filesystem;
using namespace license;
using namespace std;

static string read_file(const fs::path &path) {
	ifstream in(path.string().c_str(), ios::binary);
	BOOST_REQUIRE_MESSAGE(in.good(), "Can read " + path.string());
	return string((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
}

static void write_file(const fs::path &path, const string &contents) {
	ofstream out(path.string().c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write " + path.string());
	out << contents;
	BOOST_REQUIRE_MESSAGE(out.good(), "Wrote " + path.string());
}

static size_t public_key_len_from_header(const string &header) {
	const string marker = "#define PUBLIC_KEY_LEN ";
	const size_t pos = header.find(marker);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, "PUBLIC_KEY_LEN is present in generated public key header");
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find_first_of("\r\n", value_start);
	return static_cast<size_t>(stoul(header.substr(value_start, value_end - value_start)));
}

static size_t numeric_define_from_header(const string &header, const string &name) {
	const string marker = "#define " + name + " ";
	const size_t pos = header.find(marker);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, name + " is present in generated public key header");
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find_first_of("\r\n", value_start);
	return static_cast<size_t>(stoul(header.substr(value_start, value_end - value_start)));
}

static string string_define_from_header(const string &header, const string &name) {
	const string marker = "#define " + name + " \"";
	const size_t pos = header.find(marker);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, name + " is present in generated public key header");
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find('"', value_start);
	BOOST_REQUIRE_MESSAGE(value_end != string::npos, name + " is quoted");
	return header.substr(value_start, value_end - value_start);
}

static string public_key_id_from_header(const string &header) {
	return string_define_from_header(header, "LCC_PUBLIC_KEY_ID");
}

BOOST_AUTO_TEST_CASE(project_initialize) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path project_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "product_initialize");
	const fs::path expectedPrivateKey(project_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(project_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	fs::remove_all(project_folder);
	BOOST_CHECK_MESSAGE(!fs::exists(expectedPrivateKey),
						"Private key " + expectedPrivateKey.string() + " can't be deleted.");
	BOOST_CHECK_MESSAGE(!fs::exists(expected_public_key),
						"Public key " + expected_public_key.string() + " can't be deleted.");

	Project prj(project_name, project_folder.string(), mock_source_folder.string(), false);
	prj.initialize();

	BOOST_CHECK_MESSAGE(fs::exists(expectedPrivateKey), "Private key " + expectedPrivateKey.string() + " created.");
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_public_key), "Public key " + expected_public_key.string() + " created.");

	// read the public key file
	std::string pub_key = read_file(expected_public_key);
	BOOST_CHECK_MESSAGE(pub_key.find("TEST") != std::string::npos, "Project defined");
	BOOST_CHECK_GE(public_key_len_from_header(pub_key), static_cast<size_t>(390));
	BOOST_CHECK_EQUAL(string_define_from_header(pub_key, "LCC_PUBLIC_KEY_ALGORITHM"), "rsa");
	BOOST_CHECK_EQUAL(numeric_define_from_header(pub_key, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(3072));
	BOOST_CHECK_EQUAL(string_define_from_header(pub_key, "LCC_SIGNATURE_ALGORITHM"), "rsa-pkcs1-sha256");
	BOOST_CHECK_EQUAL(public_key_id_from_header(pub_key).size(), static_cast<size_t>(71));
	BOOST_CHECK_EQUAL(public_key_id_from_header(pub_key).substr(0, 7), "sha256:");
	BOOST_CHECK_EQUAL(public_key_id_from_header(pub_key),
					  "sha256:" + string_define_from_header(pub_key, "LCC_PUBLIC_KEY_SHA256"));

#ifdef __unix__
	struct stat private_key_stat;
	BOOST_REQUIRE_EQUAL(stat(expectedPrivateKey.string().c_str(), &private_key_stat), 0);
	BOOST_CHECK_EQUAL(private_key_stat.st_mode & (S_IRWXG | S_IRWXO), 0);
#endif
}

#ifdef _WIN32
BOOST_AUTO_TEST_CASE(project_initialize_private_key_is_restricted_before_atomic_publication_from_a_permissive_directory) {
	const string project_name("TEST_PRIVATE_KEY_ACL");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "project_initialize_private_key_acl");
	const fs::path project_path(projects_folder / project_name);
	const fs::path private_key(project_path / PRIVATE_KEY_FNAME);
	const fs::path baseline_key(project_path / "baseline-private-key.rsa");

	fs::remove_all(projects_folder);
	fs::create_directories(project_path);
	test_windows_acl::make_directory_permissive_for_test(project_path);
	write_file(baseline_key, "baseline-private-key");
	BOOST_REQUIRE_MESSAGE(test_windows_acl::inspect_file_acl(baseline_key).has_inherited_world_read,
						  "baseline private key inherits broad access from the deliberately permissive project directory");

	Project project(project_name, projects_folder.string(), mock_source_folder.string(), false);
	BOOST_REQUIRE_NO_THROW(project.initialize());
	BOOST_REQUIRE_MESSAGE(fs::exists(private_key), "project initialization published a private key");
	const test_windows_acl::AclSnapshot private_acl = test_windows_acl::inspect_file_acl(private_key);
	BOOST_CHECK_MESSAGE(private_acl.dacl_protected, "project private key has a protected DACL");
	BOOST_CHECK_MESSAGE(private_acl.owner_is_current_user, "project private key is owned by the current process user");
	BOOST_CHECK_EQUAL(private_acl.entries, static_cast<size_t>(1));
	BOOST_CHECK_MESSAGE(private_acl.only_current_user_allow_ace,
						"project private key has no inherited or non-owner allow ACE");
	BOOST_CHECK_MESSAGE(private_acl.current_user_can_read, "current owner retains private-key read access");
	BOOST_CHECK_MESSAGE(!private_acl.has_inherited_world_read,
						"project private key does not retain broad inherited read access after publication");

	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	BOOST_REQUIRE_NO_THROW(crypto->loadPrivateKey_file(private_key.string()));
	BOOST_CHECK_MESSAGE(!crypto->signString("private-key-acl-project-init").empty(),
						"current owner can load and sign with the atomically published private key");
}
#endif

BOOST_AUTO_TEST_CASE(project_initialize_legacy_rsa1024_requires_explicit_key_size) {
	const string project_name("TEST_LEGACY_RSA1024");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path project_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "product_initialize_legacy_rsa1024");
	const fs::path expected_public_key(project_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	fs::remove_all(project_folder);
	Project prj(project_name, project_folder.string(), mock_source_folder.string(), false, 1024);
	prj.initialize();

	const string pub_key = read_file(expected_public_key);
	BOOST_CHECK_LT(public_key_len_from_header(pub_key), static_cast<size_t>(200));
	BOOST_CHECK_EQUAL(string_define_from_header(pub_key, "LCC_PUBLIC_KEY_ALGORITHM"), "rsa");
	BOOST_CHECK_EQUAL(numeric_define_from_header(pub_key, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(1024));
	BOOST_CHECK_EQUAL(string_define_from_header(pub_key, "LCC_SIGNATURE_ALGORITHM"), "rsa-pkcs1-sha256");
	BOOST_CHECK_EQUAL(public_key_id_from_header(pub_key).substr(0, 7), "sha256:");
}

BOOST_AUTO_TEST_CASE(project_initialize_rejects_invalid_project_names) {
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path project_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "product_initialize_invalid_names");
	const vector<string> invalid_names = {"", ".", "..", "1TEST", "TEST.", "TEST/NAME", "TEST\\NAME",
										  "TEST[NAME]", "TEST NAME", "TEST:NAME", "TEST*NAME", "TEST?NAME",
										  "TEST<NAME", "TEST>NAME", "TEST|NAME", "TEST\"NAME", "CON", "nul.h",
										  "COM1", "lpt9.generated", string("TEST\nNAME")};

	for (const string &project_name : invalid_names) {
		BOOST_CHECK_THROW(Project(project_name, project_folder.string(), mock_source_folder.string(), false),
						  invalid_argument);
	}

	BOOST_CHECK_NO_THROW(Project("TEST_NAME_1", project_folder.string(), mock_source_folder.string(), false));
	BOOST_CHECK_NO_THROW(Project("my-product", project_folder.string(), mock_source_folder.string(), false));
	BOOST_CHECK_NO_THROW(Project("legacy.product-1", project_folder.string(), mock_source_folder.string(), false));
}

BOOST_AUTO_TEST_CASE(project_initialize_does_not_overwrite_existing_private_key_without_force) {
	const string project_name("TEST_NO_OVERWRITE");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path project_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "product_initialize_no_overwrite");
	const fs::path expected_private_key(project_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(project_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	fs::remove_all(project_folder);
	Project initial(project_name, project_folder.string(), mock_source_folder.string(), false);
	initial.initialize();
	const string private_key_before = read_file(expected_private_key);
	fs::remove(expected_public_key);

	Project second(project_name, project_folder.string(), mock_source_folder.string(), false);
	second.initialize();

	BOOST_CHECK_EQUAL(read_file(expected_private_key), private_key_before);
	BOOST_CHECK_MESSAGE(fs::exists(expected_public_key), "Public key regenerated from existing private key.");
}

BOOST_AUTO_TEST_CASE(project_initialize_force_is_fail_closed_and_preserves_existing_private_key) {
	const string project_name("TEST_FORCE");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path project_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "product_initialize_force");
	const fs::path expected_private_key(project_folder / project_name / PRIVATE_KEY_FNAME);

	fs::remove_all(project_folder);
	Project initial(project_name, project_folder.string(), mock_source_folder.string(), false);
	initial.initialize();
	const string private_key_before = read_file(expected_private_key);
	const fs::path generated_include_folder = expected_private_key.parent_path() / "include";
	fs::remove_all(generated_include_folder);
	BOOST_REQUIRE(!fs::exists(generated_include_folder));

	Project replacement(project_name, project_folder.string(), mock_source_folder.string(), true);
	BOOST_CHECK_THROW(replacement.initialize(), logic_error);

	BOOST_CHECK_EQUAL(read_file(expected_private_key), private_key_before);
	BOOST_CHECK_MESSAGE(!fs::exists(generated_include_folder),
						"forced weak-key migration failure must not create adjacent project output");
}

BOOST_AUTO_TEST_CASE(project_initialize_repairs_stale_metadata_but_rejects_tampered_or_mismatched_public_key) {
	const string project_name("TEST_HEADER_VALIDATION");
	const string other_project_name("TEST_HEADER_OTHER");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path project_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "product_header_validation");
	const fs::path project_path(project_folder / project_name);
	const fs::path public_key(project_path / "include" / "licensecc" / project_name / PUBLIC_KEY_INC_FNAME);
	const fs::path private_key(project_path / PRIVATE_KEY_FNAME);
	const fs::path other_public_key(project_folder / other_project_name / "include" / "licensecc" / other_project_name /
									  PUBLIC_KEY_INC_FNAME);

	fs::remove_all(project_folder);
	Project initial(project_name, project_folder.string(), mock_source_folder.string(), false, 1024);
	initial.initialize();
	Project other(other_project_name, project_folder.string(), mock_source_folder.string(), false, 1024);
	other.initialize();

	const string private_before = read_file(private_key);
	const string canonical_header = read_file(public_key);
	string stale_header = canonical_header;
	const string stale_sha = "#define LCC_PUBLIC_KEY_SHA256 \"stale\"";
	const size_t sha_pos = stale_header.find("#define LCC_PUBLIC_KEY_SHA256 ");
	BOOST_REQUIRE(sha_pos != string::npos);
	const size_t sha_end = stale_header.find_first_of("\r\n", sha_pos);
	stale_header.replace(sha_pos, sha_end - sha_pos, stale_sha);
	write_file(public_key, stale_header);

	Project repair(project_name, project_folder.string(), mock_source_folder.string(), false, 1024);
	try {
		repair.initialize();
	} catch (const exception& ex) {
		BOOST_FAIL(string("stale metadata repair must be safe: ") + ex.what());
	}
	BOOST_CHECK_EQUAL(read_file(private_key), private_before);
	BOOST_CHECK_EQUAL(read_file(public_key), canonical_header);

	string tampered_header = canonical_header;
	const size_t array_open = tampered_header.find('{', tampered_header.find("#define PUBLIC_KEY"));
	BOOST_REQUIRE(array_open != string::npos);
	const size_t first_digit = tampered_header.find_first_of("0123456789", array_open);
	BOOST_REQUIRE(first_digit != string::npos);
	tampered_header[first_digit] = tampered_header[first_digit] == '0' ? '1' : '0';
	write_file(public_key, tampered_header);
	Project tampered(project_name, project_folder.string(), mock_source_folder.string(), false, 1024);
	BOOST_CHECK_THROW(tampered.initialize(), runtime_error);
	BOOST_CHECK_EQUAL(read_file(private_key), private_before);
	BOOST_CHECK_EQUAL(read_file(public_key), tampered_header);

	const string mismatched_header = read_file(other_public_key);
	write_file(public_key, mismatched_header);
	Project mismatched(project_name, project_folder.string(), mock_source_folder.string(), false, 1024);
	BOOST_CHECK_THROW(mismatched.initialize(), runtime_error);
	BOOST_CHECK_EQUAL(read_file(private_key), private_before);
	BOOST_CHECK_EQUAL(read_file(public_key), mismatched_header);
}
