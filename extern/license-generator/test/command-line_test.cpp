#define BOOST_TEST_MODULE test_command_line

#include <algorithm>
#include <cstdint>
#include <ctime>
#include <string>
#include <fstream>
#include <iterator>
#include <vector>
#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>
#include <boost/version.hpp>
#if (BOOST_VERSION > 107000)
#include <boost/test/tools/output_test_stream.hpp>
#else
#include <boost/test/output_test_stream.hpp>
#endif
#include <iostream>

#include <build_properties.h>
#include "../src/license_generator/command_line-parser.hpp"
#include "../src/license_generator/file_publish.hpp"
#include "../src/ini/SimpleIni.h"
#include "../src/base_lib/base.h"
#include "../src/base_lib/base64.h"
#include "cout_redirect.hpp"
#ifdef _WIN32
#include "windows_acl_test.hpp"
#endif

namespace fs = boost::filesystem;
using namespace license;
using namespace std;

namespace license {
namespace test {

static string client_signature_for(vector<uint8_t> decoded) {
	string signature = base64(decoded.data(), decoded.size(), 5);
	replace(signature.begin(), signature.end(), '\n', '-');
	if (!signature.empty() && signature.back() == '-') {
		signature.pop_back();
	}
	return signature;
}

static string valid_client_signature() {
	return client_signature_for({0x00, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string ip_client_signature() {
	return client_signature_for({0x00, 0x20, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string env_selected_client_signature() {
	return client_signature_for({0x40, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string weak_disk_label_client_signature() {
	return client_signature_for({0x01, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string control_flag_client_signature(uint8_t control_flags) {
	return client_signature_for({control_flags, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static void create_project(const fs::path& projects_folder, const fs::path& expectedPrivateKey,
						   const fs::path& expected_public_key, const fs::path& mock_source_folder,
						   const string& project_name) {
	fs::remove_all(projects_folder);
	BOOST_CHECK_MESSAGE(!fs::exists(expectedPrivateKey),
						"Private key " + expectedPrivateKey.string() + " can't be deleted.");
	BOOST_CHECK_MESSAGE(!fs::exists(expected_public_key),
						"Public key " + expected_public_key.string() + " can't be deleted.");
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	int argc = 9;
	const char* argv1[] = {"lcc",
						   "project",
						   "init",
						   "-n",
						   project_name.c_str(),
						   "--projects-folder",
						   projects_str.c_str(),
						   "--templates",
						   mock_source.c_str()};
	// initialize_project
	int result = CommandLineParser::parseCommandLine(argc, argv1);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expectedPrivateKey), "Private key " + expectedPrivateKey.string() + " created.");
	BOOST_CHECK_MESSAGE(fs::exists(expected_public_key), "Public key " + expected_public_key.string() + " created.");
}

static string read_binary_file(const fs::path& path) {
	ifstream in(path.string().c_str(), ios::binary);
	return string((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
}

static string decode_base64_text(const string& encoded) {
	const vector<uint8_t> decoded = unbase64(encoded);
	if (decoded.empty()) {
		return "";
	}
	return string(reinterpret_cast<const char*>(decoded.data()), decoded.size());
}

static size_t public_key_len_from_header(const string& header) {
	const string marker = "#define PUBLIC_KEY_LEN ";
	const size_t pos = header.find(marker);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, "PUBLIC_KEY_LEN is present in generated public key header");
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find_first_of("\r\n", value_start);
	return static_cast<size_t>(stoul(header.substr(value_start, value_end - value_start)));
}

static size_t numeric_define_from_header(const string& header, const string& name) {
	const string marker = "#define " + name + " ";
	const size_t pos = header.find(marker);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, name + " is present in generated public key header");
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find_first_of("\r\n", value_start);
	return static_cast<size_t>(stoul(header.substr(value_start, value_end - value_start)));
}

static string string_define_from_header(const string& header, const string& name) {
	const string marker = "#define " + name + " \"";
	const size_t pos = header.find(marker);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, name + " is present in generated public key header");
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find('"', value_start);
	BOOST_REQUIRE_MESSAGE(value_end != string::npos, name + " is quoted");
	return header.substr(value_start, value_end - value_start);
}

static string public_key_id_from_header(const string& header) {
	return string_define_from_header(header, "LCC_PUBLIC_KEY_ID");
}

BOOST_AUTO_TEST_CASE(basic_help_lists_the_actual_project_init_command) {
	int argc = 1;
	const char* argv[] = {"lcc"};
	boost::test_tools::output_test_stream output;
	int result = 0;
	{
		cout_redirect guard(output.rdbuf());
		result = CommandLineParser::parseCommandLine(argc, argv);
	}
	const string stdout_str = output.str();
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_MESSAGE(stdout_str.find("project init") != string::npos,
						"basic help advertises the accepted project init command: " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("project initialize") == string::npos,
						"basic help does not advertise a non-existent project initialize command: " + stdout_str);
}

BOOST_AUTO_TEST_CASE(product_initialize_issue_license) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string public_key_header = read_binary_file(expected_public_key);
	BOOST_CHECK_GE(public_key_len_from_header(public_key_header), static_cast<size_t>(390));
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_PUBLIC_KEY_ALGORITHM"), "rsa");
	BOOST_CHECK_EQUAL(numeric_define_from_header(public_key_header, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(3072));
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_SIGNATURE_ALGORITHM"), "rsa-pkcs1-sha256");
	BOOST_CHECK_EQUAL(public_key_id_from_header(public_key_header).substr(0, 7), "sha256:");
	BOOST_CHECK_EQUAL(public_key_id_from_header(public_key_header),
					  "sha256:" + string_define_from_header(public_key_header, "LCC_PUBLIC_KEY_SHA256"));
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	// issue license in standard location
	fs::path expected_license("my_license.lic");
	fs::remove(expected_license);
	int argc = 9;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   "my_license.lic",
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str()};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_license), "License " + expected_license.string() + " created.");
	// load a license, check the project name corresponds and there are no extra elements.
	CSimpleIniA ini;
	ini.LoadFile(expected_license.c_str());
	BOOST_CHECK_MESSAGE(ini.GetSectionSize(project_name.c_str()) == 2, "Section [" + project_name + "] has 2 elements");
}

BOOST_AUTO_TEST_CASE(product_validate_keypair_and_v201_issue_reject_mismatch) {
	const string project_name("TEST_KEYPAIR");
	const string other_project_name("TEST_KEYPAIR_OTHER");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_keypair");
	const fs::path other_projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_keypair_other");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expected_private_key(expected_project_folder / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(expected_project_folder / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	const fs::path other_private_key(other_projects_folder / other_project_name / PRIVATE_KEY_FNAME);
	const fs::path other_public_key(other_projects_folder / other_project_name / "include" / "licensecc" /
									other_project_name / PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expected_private_key, expected_public_key, mock_source_folder, project_name);
	create_project(other_projects_folder, other_private_key, other_public_key, mock_source_folder, other_project_name);

	const string private_key_str = expected_private_key.string();
	const string public_key_str = expected_public_key.string();
	int validate_argc = 7;
	const char* validate_argv[] = {"lcc",
								   "project",
								   "validate-keypair",
								   "--private-key",
								   private_key_str.c_str(),
								   "--public-key",
								   public_key_str.c_str()};
	BOOST_CHECK_EQUAL(CommandLineParser::parseCommandLine(validate_argc, validate_argv), 0);

	const string other_private_key_str = other_private_key.string();
	const char* mismatch_validate_argv[] = {"lcc",
											"project",
											"validate-keypair",
											"--private-key",
											other_private_key_str.c_str(),
											"--public-key",
											public_key_str.c_str()};
	BOOST_CHECK_EQUAL(CommandLineParser::parseCommandLine(validate_argc, mismatch_validate_argv), 1);

	const fs::path mismatched_license("mismatched_v201_license.lic");
	fs::remove(mismatched_license);
	const string mismatched_license_str = mismatched_license.string();
	const string project_folder_str = expected_project_folder.string();
	int issue_argc = 13;
	const char* issue_argv[] = {"lcc",
								"license",
								"issue",
								"--" PARAM_PRIMARY_KEY,
								other_private_key_str.c_str(),
								"--" PARAM_LICENSE_OUTPUT,
								mismatched_license_str.c_str(),
								"--" PARAM_PROJECT_FOLDER,
								project_folder_str.c_str(),
								"--" PARAM_LICENSE_FORMAT_VERSION,
								"201",
								"--" PARAM_TARGET_LICENSE_FORMAT_MAX,
								"201"};
	BOOST_CHECK_EQUAL(CommandLineParser::parseCommandLine(issue_argc, issue_argv), 1);
	BOOST_CHECK_MESSAGE(!fs::exists(mismatched_license), "mismatched v201 issuance must not create a license file");
}

BOOST_AUTO_TEST_CASE(product_validate_keypair_warns_on_insecure_key) {
	const string project_name("TEST_VALIDATE_WEAK");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_validate_weak");
	const fs::path project_folder(projects_folder / project_name);
	const fs::path private_key(project_folder / PRIVATE_KEY_FNAME);
	const fs::path public_key(project_folder / "include" / "licensecc" / project_name / PUBLIC_KEY_INC_FNAME);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();

	// Create a deliberately-weak (2048-bit) project via the explicit override.
	int init_argc = 12;
	const char* init_argv[] = {"lcc",
							   "project",
							   "init",
							   "-n",
							   project_name.c_str(),
							   "--projects-folder",
							   projects_str.c_str(),
							   "--templates",
							   mock_source.c_str(),
							   "--key-bits",
							   "2048",
							   "--allow-insecure-key-size"};
	BOOST_REQUIRE_EQUAL(CommandLineParser::parseCommandLine(init_argc, init_argv), 0);

	// validate-keypair on the weak project succeeds but must warn about the runtime floor.
	const string private_key_str = private_key.string();
	const string public_key_str = public_key.string();
	int validate_argc = 7;
	const char* validate_argv[] = {"lcc",
								   "project",
								   "validate-keypair",
								   "--private-key",
								   private_key_str.c_str(),
								   "--public-key",
								   public_key_str.c_str()};
	boost::test_tools::output_test_stream captured;
	std::streambuf* old_cerr = std::cerr.rdbuf(captured.rdbuf());
	int result = 1;
	try {
		result = CommandLineParser::parseCommandLine(validate_argc, validate_argv);
	} catch (...) {
		std::cerr.rdbuf(old_cerr);
		throw;
	}
	std::cerr.rdbuf(old_cerr);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_CHECK_MESSAGE(captured.str().find("NOT verify") != string::npos,
						"validate-keypair insecure-key warning printed to stderr: " + captured.str());
}

BOOST_AUTO_TEST_CASE(v201_issue_derives_client_signature_source_strength_metadata) {
	const string project_name("TEST_V201_HW_SOURCE");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_v201_hw_source");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expected_private_key(expected_project_folder / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(expected_project_folder / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	create_project(projects_folder, expected_private_key, expected_public_key, mock_source_folder, project_name);

	const string project_folder_str = expected_project_folder.string();
	const string private_key_str = expected_private_key.string();
	const string weak_signature = weak_disk_label_client_signature();
	const fs::path rejected_license("v201_weak_disk_label_rejected.lic");
	fs::remove(rejected_license);
	const string rejected_license_str = rejected_license.string();
	int rejected_argc = 15;
	const char* rejected_argv[] = {"lcc",
								   "license",
								   "issue",
								   "--" PARAM_PRIMARY_KEY,
								   private_key_str.c_str(),
								   "--" PARAM_LICENSE_OUTPUT,
								   rejected_license_str.c_str(),
								   "--" PARAM_PROJECT_FOLDER,
								   project_folder_str.c_str(),
								   "--" PARAM_LICENSE_FORMAT_VERSION,
								   "201",
								   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
								   "201",
								   "--" PARAM_CLIENT_SIGNATURE,
								   weak_signature.c_str()};
	BOOST_CHECK_EQUAL(CommandLineParser::parseCommandLine(rejected_argc, rejected_argv), 1);
	BOOST_CHECK_MESSAGE(!fs::exists(rejected_license), "weak disk-label v201 issuance requires explicit opt-in");

	const fs::path allowed_license("v201_weak_disk_label_allowed.lic");
	fs::remove(allowed_license);
	const string allowed_license_str = allowed_license.string();
	int allowed_argc = 16;
	const char* allowed_argv[] = {"lcc",
								  "license",
								  "issue",
								  "--" PARAM_PRIMARY_KEY,
								  private_key_str.c_str(),
								  "--" PARAM_LICENSE_OUTPUT,
								  allowed_license_str.c_str(),
								  "--" PARAM_PROJECT_FOLDER,
								  project_folder_str.c_str(),
								  "--" PARAM_LICENSE_FORMAT_VERSION,
								  "201",
								  "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
								  "201",
								  "--" PARAM_CLIENT_SIGNATURE,
								  weak_signature.c_str(),
								  "--allow-weak-disk-label-binding"};
	BOOST_CHECK_EQUAL(CommandLineParser::parseCommandLine(allowed_argc, allowed_argv), 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(allowed_license), "weak disk-label v201 license created with opt-in");
	CSimpleIniA ini;
	BOOST_REQUIRE_EQUAL(ini.LoadFile(allowed_license.c_str()), SI_Error::SI_OK);
	BOOST_CHECK_EQUAL(string(ini.GetValue(project_name.c_str(), PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH, "")),
					  "weak-disk-label");
}

BOOST_AUTO_TEST_CASE(product_initialize_legacy_rsa1024_requires_explicit_cli_flag) {
	const string project_name("TEST_LEGACY_RSA1024");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_legacy_rsa1024");
	const fs::path expected_private_key(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	int argc = 11;
	const char* argv[] = {"lcc",
						  "project",
						  "init",
						  "-n",
						  project_name.c_str(),
						  "--projects-folder",
						  projects_str.c_str(),
						  "--templates",
						  mock_source.c_str(),
						  "--legacy-rsa1024",
						  "--allow-insecure-key-size"};
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_private_key), "Private key created.");
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_public_key), "Public key created.");
	const string public_key_header = read_binary_file(expected_public_key);
	BOOST_CHECK_LT(public_key_len_from_header(public_key_header), static_cast<size_t>(200));
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_PUBLIC_KEY_ALGORITHM"), "rsa");
	BOOST_CHECK_EQUAL(numeric_define_from_header(public_key_header, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(1024));
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_SIGNATURE_ALGORITHM"), "rsa-pkcs1-sha256");
	BOOST_CHECK_EQUAL(public_key_id_from_header(public_key_header).substr(0, 7), "sha256:");
}

static void write_binary_file(const fs::path& path, const string& contents) {
	ofstream output(path.string().c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(output.is_open(), "can write " + path.string());
	output << contents;
	BOOST_REQUIRE_MESSAGE(output.good(), "wrote " + path.string());
}

static void fail_file_publish_before_commit(const fs::path&) {
	throw runtime_error("forced test-sign publication failure");
}

struct cerr_redirect {
	explicit cerr_redirect(std::streambuf* new_buffer) : old(std::cerr.rdbuf(new_buffer)) {}
	~cerr_redirect() { std::cerr.rdbuf(old); }

private:
	std::streambuf* old;
};

struct FileSnapshot {
	string bytes;
	uintmax_t size;
	time_t write_time;
	uintmax_t hard_link_count;
	unsigned int permissions;
};

static FileSnapshot snapshot_file(const fs::path& path) {
	BOOST_REQUIRE_MESSAGE(fs::exists(path), "snapshot source exists: " + path.string());
	return {read_binary_file(path), fs::file_size(path), fs::last_write_time(path), fs::hard_link_count(path),
			static_cast<unsigned int>(fs::status(path).permissions())};
}

static void check_file_snapshot(const fs::path& path, const FileSnapshot& before, const string& label) {
	BOOST_REQUIRE_MESSAGE(fs::exists(path), label + " still exists: " + path.string());
	BOOST_CHECK_EQUAL(read_binary_file(path), before.bytes);
	BOOST_CHECK_EQUAL(fs::file_size(path), before.size);
	BOOST_CHECK_EQUAL(fs::last_write_time(path), before.write_time);
	BOOST_CHECK_EQUAL(fs::hard_link_count(path), before.hard_link_count);
	BOOST_CHECK_EQUAL(static_cast<unsigned int>(fs::status(path).permissions()), before.permissions);
}

static int issue_license_with_custom_key(const fs::path& primary_key, const fs::path& output,
										 const fs::path& project_folder, string* diagnostic = nullptr) {
	const string primary_key_str = primary_key.string();
	const string output_str = output.string();
	const string project_folder_str = project_folder.string();
	int argc = 9;
	const char* argv[] = {"lcc",
					  "license",
					  "issue",
					  "--" PARAM_PRIMARY_KEY,
					  primary_key_str.c_str(),
					  "--" PARAM_LICENSE_OUTPUT,
					  output_str.c_str(),
					  "--" PARAM_PROJECT_FOLDER,
					  project_folder_str.c_str()};
	boost::test_tools::output_test_stream errors;
	cerr_redirect guard(errors.rdbuf());
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	if (diagnostic != nullptr) {
		*diagnostic = errors.str();
	}
	return result;
}

static void check_active_key_output_is_rejected(const fs::path& primary_key, const fs::path& output,
											 const fs::path& project_folder, const FileSnapshot& key_before,
											 const string& label) {
	string diagnostic;
	BOOST_CHECK_EQUAL(issue_license_with_custom_key(primary_key, output, project_folder, &diagnostic), 1);
	BOOST_CHECK_MESSAGE(diagnostic.find("active private key") != string::npos,
						label + " is rejected before output parsing/publication: " + diagnostic);
	check_file_snapshot(primary_key, key_before, label + " primary key");
}

BOOST_AUTO_TEST_CASE(license_issue_rejects_active_custom_key_output_aliases_without_mutation) {
	const string project_name("TEST_CUSTOM_KEY_OUTPUT_GUARD");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path sandbox(fs::path(PROJECT_TEST_TEMP_DIR) / "custom_key_output_guard");
	const fs::path projects_folder(sandbox / "projects");
	const fs::path project_folder(projects_folder / project_name);
	const fs::path default_private_key(project_folder / PRIVATE_KEY_FNAME);
	const fs::path public_key(project_folder / "include" / "licensecc" / project_name / PUBLIC_KEY_INC_FNAME);

	fs::remove_all(sandbox);
	fs::create_directories(sandbox);
#ifdef _WIN32
	test_windows_acl::make_directory_permissive_for_test(sandbox);
#endif
	create_project(projects_folder, default_private_key, public_key, mock_source_folder, project_name);
	const auto copy_disposable_custom_key = [&](const string& name) {
		const fs::path custom_private_key(sandbox / name);
		fs::copy_file(default_private_key, custom_private_key);
		return custom_private_key;
	};

	// A custom --primary-key must be protected even though it is not named
	// private_key.rsa and is outside the project folder.
	const fs::path exact_custom_key = copy_disposable_custom_key("custom-exact-key.pem");
	const FileSnapshot exact_before = snapshot_file(exact_custom_key);
	check_active_key_output_is_rejected(exact_custom_key, exact_custom_key, project_folder, exact_before,
										 "exact custom-key output");

	// Absolute lexical normalization must catch a dot-segment alias.  Windows
	// also folds case in the same comparison key, so the case-only alias below
	// exercises that platform-specific spelling independently.
	const fs::path lexical_custom_key = copy_disposable_custom_key("custom-lexical-key.pem");
	const FileSnapshot lexical_before = snapshot_file(lexical_custom_key);
	const fs::path lexical_alias(lexical_custom_key.parent_path() / "." / lexical_custom_key.filename());
	check_active_key_output_is_rejected(lexical_custom_key, lexical_alias, project_folder, lexical_before,
										 "lexical custom-key alias");
#ifdef _WIN32
	const fs::path case_custom_key = copy_disposable_custom_key("custom-case-key.pem");
	const FileSnapshot case_before = snapshot_file(case_custom_key);
	const fs::path case_alias(case_custom_key.parent_path() / "CUSTOM-CASE-KEY.PEM");
	BOOST_REQUIRE_MESSAGE(fs::exists(case_alias), "Windows case alias resolves to the disposable custom key");
	check_active_key_output_is_rejected(case_custom_key, case_alias, project_folder, case_before,
										 "case-normalized custom-key alias");
#endif

	// Filesystem identity is checked only when both entries exist.  Prefer a
	// hardlink (available on normal Windows/POSIX volumes); try a symlink only
	// if hardlinks are unavailable, and retain a safe no-alias fallback for
	// filesystems that prohibit both link kinds.
	const fs::path filesystem_custom_key = copy_disposable_custom_key("custom-filesystem-key.pem");
	const fs::path filesystem_alias(sandbox / "custom-key-filesystem-alias.lic");
	boost::system::error_code link_error;
	fs::create_hard_link(filesystem_custom_key, filesystem_alias, link_error);
	if (link_error) {
		link_error.clear();
		fs::create_symlink(filesystem_custom_key, filesystem_alias, link_error);
	}
	if (!link_error) {
		BOOST_REQUIRE_MESSAGE(fs::equivalent(filesystem_custom_key, filesystem_alias),
							  "filesystem alias resolves to the disposable custom key");
		const FileSnapshot alias_before = snapshot_file(filesystem_alias);
		const FileSnapshot linked_key_before = snapshot_file(filesystem_custom_key);
		check_active_key_output_is_rejected(filesystem_custom_key, filesystem_alias, project_folder, linked_key_before,
											  "filesystem-equivalent custom-key alias");
		check_file_snapshot(filesystem_alias, alias_before, "filesystem-equivalent custom-key alias");
		BOOST_CHECK_MESSAGE(fs::equivalent(filesystem_custom_key, filesystem_alias),
							"filesystem alias remains equivalent after rejection");
	} else {
		BOOST_TEST_MESSAGE("filesystem alias test skipped: hardlink/symlink unavailable: " + link_error.message());
	}

	// The default project key remains protected by the legacy default-key rule.
	const FileSnapshot default_before = snapshot_file(default_private_key);
	check_active_key_output_is_rejected(default_private_key, default_private_key, project_folder, default_before,
										 "default-key output");

	// Normal v200 issuance with a custom active key still succeeds when the
	// output is distinct from every protected input artifact.
	const fs::path ordinary_custom_key = copy_disposable_custom_key("custom-ordinary-key.pem");
	const FileSnapshot ordinary_key_before = snapshot_file(ordinary_custom_key);
	const fs::path ordinary_output(sandbox / "ordinary-custom-key-output.lic");
	string ordinary_diagnostic;
	BOOST_CHECK_MESSAGE(issue_license_with_custom_key(ordinary_custom_key, ordinary_output, project_folder, &ordinary_diagnostic) == 0,
						"ordinary custom-key output succeeds: " + ordinary_diagnostic);
	BOOST_CHECK_MESSAGE(fs::exists(ordinary_output), "ordinary custom-key output is created");
	check_file_snapshot(ordinary_custom_key, ordinary_key_before, "ordinary custom-key issuance");
#ifdef _WIN32
	const test_windows_acl::AclSnapshot ordinary_output_acl = test_windows_acl::inspect_file_acl(ordinary_output);
	BOOST_CHECK_MESSAGE(ordinary_output_acl.has_inherited_world_read,
						"ordinary license output retains normal parent ACL inheritance");
	BOOST_CHECK_MESSAGE(!ordinary_output_acl.temporary_attribute,
						"ordinary license output does not retain FILE_ATTRIBUTE_TEMPORARY");
#endif
}

BOOST_AUTO_TEST_CASE(legacy_v200_issue_preserves_safe_hyphenated_project_name) {
	const string project_name("my-product");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_hyphenated_v200");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expected_private_key(expected_project_folder / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(expected_project_folder / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	create_project(projects_folder, expected_private_key, expected_public_key, mock_source_folder, project_name);
	const fs::path output_file("hyphenated_v200.lic");
	fs::remove(output_file);
	const string private_key_str = expected_private_key.string();
	const string project_folder_str = expected_project_folder.string();
	const string output_file_str = output_file.string();
	int argc = 9;
	const char* argv[] = {"lcc",
					  "license",
					  "issue",
					  "--" PARAM_PRIMARY_KEY,
					  private_key_str.c_str(),
					  "--" PARAM_LICENSE_OUTPUT,
					  output_file_str.c_str(),
					  "--" PARAM_PROJECT_FOLDER,
					  project_folder_str.c_str()};
	BOOST_CHECK_EQUAL(CommandLineParser::parseCommandLine(argc, argv), 0);
	CSimpleIniA ini;
	BOOST_REQUIRE_EQUAL(ini.LoadFile(output_file.c_str()), SI_Error::SI_OK);
	BOOST_CHECK_EQUAL(string(ini.GetValue("MY-PRODUCT", LICENSE_VERSION, "")), "200");
}

BOOST_AUTO_TEST_CASE(test_sign_does_not_truncate_existing_output_before_safe_publication) {
	const fs::path private_key = fs::path(PROJECT_TEST_SRC_DIR) / "data" / PRIVATE_KEY_FNAME;
	const fs::path output = fs::path(PROJECT_TEST_TEMP_DIR) / "test_sign_preserves_output.sig";
	write_binary_file(output, "previous-signature");
	const string private_key_str = private_key.string();
	const string output_str = output.string();
	int argc = 9;
	const char* argv[] = {"lcc", "test", "sign", "--data", "payload", "--primary-key", private_key_str.c_str(),
					  "--output", output_str.c_str()};
	file_publish::set_before_publish_test_hook(&fail_file_publish_before_commit);
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	file_publish::set_before_publish_test_hook(nullptr);
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_EQUAL(read_binary_file(output), "previous-signature");
}

static int test_sign_with_key(const fs::path& primary_key, const fs::path& output, string* diagnostic = nullptr) {
	const string primary_key_str = primary_key.string();
	const string output_str = output.string();
	const char* argv[] = {"lcc", "test", "sign", "--data", "payload", "--primary-key", primary_key_str.c_str(),
					  "--output", output_str.c_str()};
	boost::test_tools::output_test_stream messages;
	int result = 0;
	{
		cout_redirect guard(messages.rdbuf());
		result = CommandLineParser::parseCommandLine(9, argv);
	}
	if (diagnostic != nullptr) {
		*diagnostic = messages.str();
	}
	return result;
}

static void check_test_sign_active_key_output_is_rejected(const fs::path& primary_key, const fs::path& output,
																  const FileSnapshot& key_before, const string& label) {
	string diagnostic;
	BOOST_CHECK_EQUAL(test_sign_with_key(primary_key, output, &diagnostic), 1);
	BOOST_CHECK_MESSAGE(diagnostic.find("active private key") != string::npos,
						label + " is rejected before private-key load/sign/publication: " + diagnostic);
	check_file_snapshot(primary_key, key_before, label + " primary key");
}

BOOST_AUTO_TEST_CASE(test_sign_rejects_active_private_key_output_aliases_without_mutation) {
	const fs::path sandbox(fs::path(PROJECT_TEST_TEMP_DIR) / "test_sign_active_key_output_guard");
	const fs::path source_key(fs::path(PROJECT_TEST_SRC_DIR) / "data" / PRIVATE_KEY_FNAME);
	fs::remove_all(sandbox);
	fs::create_directories(sandbox);
#ifdef _WIN32
	// The ordinary test-sign output must retain a normal inherited ACL even
	// when the private-key publisher becomes explicitly restricted.
	test_windows_acl::make_directory_permissive_for_test(sandbox);
#endif
	const auto copy_disposable_key = [&](const string& name) {
		const fs::path key(sandbox / name);
		fs::copy_file(source_key, key);
		return key;
	};

	const fs::path exact_key = copy_disposable_key("test-sign-exact-key.pem");
	const FileSnapshot exact_before = snapshot_file(exact_key);
	check_test_sign_active_key_output_is_rejected(exact_key, exact_key, exact_before, "exact test-sign key output");

	const fs::path lexical_key = copy_disposable_key("test-sign-lexical-key.pem");
	const FileSnapshot lexical_before = snapshot_file(lexical_key);
	const fs::path lexical_alias(lexical_key.parent_path() / "." / lexical_key.filename());
	check_test_sign_active_key_output_is_rejected(lexical_key, lexical_alias, lexical_before,
														 "lexical test-sign key alias");
#ifdef _WIN32
	const fs::path case_key = copy_disposable_key("test-sign-case-key.pem");
	const FileSnapshot case_before = snapshot_file(case_key);
	const fs::path case_alias(case_key.parent_path() / "TEST-SIGN-CASE-KEY.PEM");
	BOOST_REQUIRE_MESSAGE(fs::exists(case_alias), "Windows case alias resolves to the disposable test-sign key");
	check_test_sign_active_key_output_is_rejected(case_key, case_alias, case_before, "case-normalized test-sign key alias");
#endif

	const fs::path filesystem_key = copy_disposable_key("test-sign-filesystem-key.pem");
	const fs::path filesystem_alias(sandbox / "test-sign-filesystem-key-alias.sig");
	boost::system::error_code link_error;
	fs::create_hard_link(filesystem_key, filesystem_alias, link_error);
	if (link_error) {
		link_error.clear();
		fs::create_symlink(filesystem_key, filesystem_alias, link_error);
	}
	if (!link_error) {
		BOOST_REQUIRE_MESSAGE(fs::equivalent(filesystem_key, filesystem_alias),
							  "filesystem alias resolves to the disposable test-sign key");
		const FileSnapshot key_before = snapshot_file(filesystem_key);
		const FileSnapshot alias_before = snapshot_file(filesystem_alias);
		check_test_sign_active_key_output_is_rejected(filesystem_key, filesystem_alias, key_before,
														 "filesystem-equivalent test-sign key alias");
		check_file_snapshot(filesystem_alias, alias_before, "filesystem-equivalent test-sign key alias");
		BOOST_CHECK_MESSAGE(fs::equivalent(filesystem_key, filesystem_alias),
							"filesystem alias remains equivalent after rejection");
	} else {
		BOOST_TEST_MESSAGE("test-sign filesystem alias test skipped: hardlink/symlink unavailable: " + link_error.message());
	}

	const fs::path ordinary_key = copy_disposable_key("test-sign-ordinary-key.pem");
	const FileSnapshot ordinary_before = snapshot_file(ordinary_key);
	const fs::path ordinary_output(sandbox / "test-sign-ordinary-output.sig");
	string ordinary_diagnostic;
	BOOST_CHECK_MESSAGE(test_sign_with_key(ordinary_key, ordinary_output, &ordinary_diagnostic) == 0,
						"ordinary test-sign output succeeds: " + ordinary_diagnostic);
	BOOST_CHECK_MESSAGE(fs::exists(ordinary_output), "ordinary test-sign output is created");
	check_file_snapshot(ordinary_key, ordinary_before, "ordinary test-sign output");
#ifdef _WIN32
	const test_windows_acl::AclSnapshot ordinary_output_acl = test_windows_acl::inspect_file_acl(ordinary_output);
	BOOST_CHECK_MESSAGE(ordinary_output_acl.has_inherited_world_read,
						"ordinary test-sign output retains normal parent ACL inheritance");
	BOOST_CHECK_MESSAGE(!ordinary_output_acl.temporary_attribute,
						"ordinary test-sign output does not retain FILE_ATTRIBUTE_TEMPORARY");
#endif
}

BOOST_AUTO_TEST_CASE(project_migrate_weak_key_is_explicit_fail_closed_and_preserves_the_private_key) {
	const string project_name("TEST_MIGRATE_WEAK_KEY");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_migrate_weak_key");
	const fs::path project_folder(projects_folder / project_name);
	const fs::path private_key(project_folder / PRIVATE_KEY_FNAME);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	int init_argc = 11;
	const char* init_argv[] = {"lcc",
							   "project",
							   "init",
							   "-n",
							   project_name.c_str(),
							   "--projects-folder",
							   projects_str.c_str(),
							   "--templates",
							   mock_source.c_str(),
							   "--legacy-rsa1024",
							   "--allow-insecure-key-size"};
	BOOST_REQUIRE_EQUAL(CommandLineParser::parseCommandLine(init_argc, init_argv), 0);
	const string private_before = read_binary_file(private_key);
	const string project_folder_str = project_folder.string();
	int migrate_argc = 5;
	const char* migrate_argv[] = {"lcc", "project", "migrate-weak-key", "--project-folder", project_folder_str.c_str()};
	boost::test_tools::output_test_stream captured;
	std::streambuf* old_cerr = std::cerr.rdbuf(captured.rdbuf());
	int result = 0;
	try {
		result = CommandLineParser::parseCommandLine(migrate_argc, migrate_argv);
	} catch (...) {
		std::cerr.rdbuf(old_cerr);
		throw;
	}
	std::cerr.rdbuf(old_cerr);
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_MESSAGE(captured.str().find("Refusing automatic rotation") != string::npos,
						"migration explains its fail-closed behavior: " + captured.str());
	BOOST_CHECK_MESSAGE(captured.str().find("Back up") != string::npos,
						"migration gives a restorable backup procedure: " + captured.str());
	BOOST_CHECK_EQUAL(read_binary_file(private_key), private_before);
}

BOOST_AUTO_TEST_CASE(product_initialize_refuses_insecure_key_size_without_override) {
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_insecure_refused");
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();

	// --legacy-rsa1024 (1024 bits) is refused without the explicit override.
	{
		const string project_name("TEST_REFUSE_LEGACY");
		const fs::path expected_project_folder(projects_folder / project_name);
		int argc = 10;
		const char* argv[] = {"lcc",
							  "project",
							  "init",
							  "-n",
							  project_name.c_str(),
							  "--projects-folder",
							  projects_str.c_str(),
							  "--templates",
							  mock_source.c_str(),
							  "--legacy-rsa1024"};
		const int result = CommandLineParser::parseCommandLine(argc, argv);
		BOOST_CHECK_EQUAL(result, 1);
		BOOST_CHECK_MESSAGE(!fs::exists(expected_project_folder),
							"Insecure --legacy-rsa1024 must not initialize " + expected_project_folder.string());
	}

	// --key-bits 2048 (below the 3072 runtime floor) is refused without the explicit override.
	{
		const string project_name("TEST_REFUSE_2048");
		const fs::path expected_project_folder(projects_folder / project_name);
		int argc = 11;
		const char* argv[] = {"lcc",
							  "project",
							  "init",
							  "-n",
							  project_name.c_str(),
							  "--projects-folder",
							  projects_str.c_str(),
							  "--templates",
							  mock_source.c_str(),
							  "--key-bits",
							  "2048"};
		const int result = CommandLineParser::parseCommandLine(argc, argv);
		BOOST_CHECK_EQUAL(result, 1);
		BOOST_CHECK_MESSAGE(!fs::exists(expected_project_folder),
							"Insecure --key-bits 2048 must not initialize " + expected_project_folder.string());
	}
}

BOOST_AUTO_TEST_CASE(product_initialize_accepts_insecure_key_size_with_override) {
	const string project_name("TEST_INSECURE_OVERRIDE");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_insecure_override");
	const fs::path expected_private_key(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	int argc = 12;
	const char* argv[] = {"lcc",
						  "project",
						  "init",
						  "-n",
						  project_name.c_str(),
						  "--projects-folder",
						  projects_str.c_str(),
						  "--templates",
						  mock_source.c_str(),
						  "--key-bits",
						  "2048",
						  "--allow-insecure-key-size"};
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_private_key), "Private key created.");
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_public_key), "Public key created.");
	const string public_key_header = read_binary_file(expected_public_key);
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_PUBLIC_KEY_ALGORITHM"), "rsa");
	BOOST_CHECK_EQUAL(numeric_define_from_header(public_key_header, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(2048));
}

BOOST_AUTO_TEST_CASE(product_initialize_accepts_key_bits_at_3072_floor) {
	// Pins the floor boundary: exactly 3072 bits must be accepted WITHOUT the insecure override.
	const string project_name("TEST_KEY_BITS_3072");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_key_bits_3072");
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	int argc = 11;
	const char* argv[] = {"lcc",
						  "project",
						  "init",
						  "-n",
						  project_name.c_str(),
						  "--projects-folder",
						  projects_str.c_str(),
						  "--templates",
						  mock_source.c_str(),
						  "--key-bits",
						  "3072"};
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_public_key), "Public key created.");
	const string public_key_header = read_binary_file(expected_public_key);
	BOOST_CHECK_EQUAL(numeric_define_from_header(public_key_header, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(3072));
}

BOOST_AUTO_TEST_CASE(product_initialize_warns_on_insecure_key_size) {
	// The override path must emit a runtime-rejection warning to stderr.
	const string project_name("TEST_KEY_BITS_WARN");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_key_bits_warn");
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	int argc = 12;
	const char* argv[] = {"lcc",
						  "project",
						  "init",
						  "-n",
						  project_name.c_str(),
						  "--projects-folder",
						  projects_str.c_str(),
						  "--templates",
						  mock_source.c_str(),
						  "--key-bits",
						  "2048",
						  "--allow-insecure-key-size"};
	boost::test_tools::output_test_stream captured;
	std::streambuf* old_cerr = std::cerr.rdbuf(captured.rdbuf());
	int result = 1;
	try {
		result = CommandLineParser::parseCommandLine(argc, argv);
	} catch (...) {
		std::cerr.rdbuf(old_cerr);
		throw;
	}
	std::cerr.rdbuf(old_cerr);
	const string stderr_str = captured.str();
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_CHECK_MESSAGE(stderr_str.find("NOT verify") != string::npos,
						"insecure key-size warning printed to stderr: " + stderr_str);
}

BOOST_AUTO_TEST_CASE(product_initialize_accepts_explicit_key_bits) {
	const string project_name("TEST_EXPLICIT_KEY_BITS");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_explicit_key_bits");
	const fs::path expected_private_key(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	const string key_bits("4096");
	int argc = 11;
	const char* argv[] = {"lcc",
						  "project",
						  "init",
						  "-n",
						  project_name.c_str(),
						  "--projects-folder",
						  projects_str.c_str(),
						  "--templates",
						  mock_source.c_str(),
						  "--key-bits",
						  key_bits.c_str()};
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_private_key), "Private key created.");
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_public_key), "Public key created.");
	const string public_key_header = read_binary_file(expected_public_key);
	BOOST_CHECK_GT(public_key_len_from_header(public_key_header), static_cast<size_t>(500));
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_PUBLIC_KEY_ALGORITHM"), "rsa");
	BOOST_CHECK_EQUAL(numeric_define_from_header(public_key_header, "LCC_PUBLIC_KEY_BITS"), static_cast<size_t>(4096));
	BOOST_CHECK_EQUAL(string_define_from_header(public_key_header, "LCC_SIGNATURE_ALGORITHM"), "rsa-pkcs1-sha256");
	BOOST_CHECK_EQUAL(public_key_id_from_header(public_key_header),
					  "sha256:" + string_define_from_header(public_key_header, "LCC_PUBLIC_KEY_SHA256"));
}

BOOST_AUTO_TEST_CASE(product_initialize_rejects_invalid_key_bits) {
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_invalid_key_bits");
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	const vector<string> invalid_key_bits = {"1024", "512", "1536", "4097", "3072x", "+3072", "03072", "2048 "};

	for (size_t i = 0; i < invalid_key_bits.size(); ++i) {
		const string project_name = "TEST_INVALID_KEY_BITS_" + to_string(i);
		const fs::path expected_project_folder(projects_folder / project_name);
		int argc = 11;
		const char* argv[] = {"lcc",
							  "project",
							  "init",
							  "-n",
							  project_name.c_str(),
							  "--projects-folder",
							  projects_str.c_str(),
							  "--templates",
							  mock_source.c_str(),
							  "--key-bits",
							  invalid_key_bits[i].c_str()};
		const int result = CommandLineParser::parseCommandLine(argc, argv);
		BOOST_CHECK_EQUAL(result, 1);
		BOOST_CHECK_MESSAGE(!fs::exists(expected_project_folder),
							"Invalid --key-bits must not initialize " + expected_project_folder.string());
	}
}

BOOST_AUTO_TEST_CASE(product_initialize_rejects_ambiguous_key_size_options) {
	const string project_name("TEST_AMBIGUOUS_KEY_BITS");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_ambiguous_key_bits");
	const fs::path expected_project_folder(projects_folder / project_name);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();
	const string key_bits("3072");
	int argc = 12;
	const char* argv[] = {"lcc",
						  "project",
						  "init",
						  "-n",
						  project_name.c_str(),
						  "--projects-folder",
						  projects_str.c_str(),
						  "--templates",
						  mock_source.c_str(),
						  "--legacy-rsa1024",
						  "--key-bits",
						  key_bits.c_str()};
	const int result = CommandLineParser::parseCommandLine(argc, argv);
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(expected_project_folder),
						"Ambiguous key-size options must not initialize a project.");
}

BOOST_AUTO_TEST_CASE(product_issue_license_base64_output) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_base64");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();

	const fs::path encoded_license("base64_license.lic");
	fs::remove(encoded_license);
	const string encoded_license_str = encoded_license.string();
	int argc = 10;
	const char* argv[] = {"lcc",
						  "license",
						  "issue",
						  "--" PARAM_PRIMARY_KEY,
						  private_key_str.c_str(),
						  "--" PARAM_LICENSE_OUTPUT,
						  encoded_license_str.c_str(),
						  "--" PARAM_PROJECT_FOLDER,
						  project_folder_str.c_str(),
						  "--" PARAM_BASE64};
	int result = CommandLineParser::parseCommandLine(argc, argv);
	BOOST_CHECK_EQUAL(result, 0);
	const string encoded = read_binary_file(encoded_license);
	BOOST_CHECK_MESSAGE(encoded.find("[TEST]") == string::npos, "Encoded output must not contain plain INI data.");
	const string decoded = decode_base64_text(encoded);
	BOOST_REQUIRE_MESSAGE(!decoded.empty(), "Encoded output decodes to license data.");
	CSimpleIniA ini;
	BOOST_REQUIRE_EQUAL(ini.LoadData(decoded), SI_Error::SI_OK);
	BOOST_CHECK_MESSAGE(ini.GetSectionSize(project_name.c_str()) == 2, "Decoded section [TEST] has 2 elements");

	int append_argc = 12;
	const char* append_argv[] = {"lcc",
								 "license",
								 "issue",
								 "--" PARAM_PRIMARY_KEY,
								 private_key_str.c_str(),
								 "--" PARAM_LICENSE_OUTPUT,
								 encoded_license_str.c_str(),
								 "--" PARAM_PROJECT_FOLDER,
								 project_folder_str.c_str(),
								 "--" PARAM_BASE64,
								 "--" PARAM_FEATURE_NAMES,
								 "EXTRA"};
	int append_result = CommandLineParser::parseCommandLine(append_argc, append_argv);
	BOOST_CHECK_EQUAL(append_result, 0);
	const string appended_decoded = decode_base64_text(read_binary_file(encoded_license));
	BOOST_REQUIRE_MESSAGE(!appended_decoded.empty(), "Appended encoded output decodes to license data.");
	ini.Reset();
	BOOST_REQUIRE_EQUAL(ini.LoadData(appended_decoded), SI_Error::SI_OK);
	BOOST_CHECK_MESSAGE(ini.GetSectionSize(project_name.c_str()) == 2, "Original section [TEST] is preserved");
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("EXTRA") == 2, "New section [EXTRA] is appended");

	int stdout_argc = 8;
	const char* stdout_argv[] = {"lcc",
								 "license",
								 "issue",
								 "--" PARAM_PRIMARY_KEY,
								 private_key_str.c_str(),
								 "--" PARAM_PROJECT_FOLDER,
								 project_folder_str.c_str(),
								 "--" PARAM_BASE64};
	boost::test_tools::output_test_stream output;
	int stdout_result = 1;
	{
		cout_redirect guard(output.rdbuf());
		stdout_result = CommandLineParser::parseCommandLine(stdout_argc, stdout_argv);
	}
	BOOST_CHECK_EQUAL(stdout_result, 0);
	const string stdout_decoded = decode_base64_text(output.str());
	BOOST_REQUIRE_MESSAGE(!stdout_decoded.empty(), "stdout contains only decodable base64 license data");
	BOOST_CHECK_MESSAGE(stdout_decoded.find("[TEST]") != string::npos, "decoded stdout contains the license section");
}

BOOST_AUTO_TEST_CASE(product_issue_license_rejects_invalid_client_signature) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_bad_client_signature");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	const fs::path expected_license("bad_client_signature.lic");
	fs::remove(expected_license);
	const string expected_license_str = expected_license.string();

	int argc = 15;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   expected_license_str.c_str(),
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str(),
						   "--" PARAM_CLIENT_SIGNATURE,
						   "XXX-XXX-XXX",
						   "--" PARAM_LICENSE_FORMAT_VERSION,
						   "201",
						   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
						   "201"};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(expected_license), "Invalid client signature must not create a license file.");

	const vector<uint8_t> invalid_control_flags = {0x01, 0x3f, 0x80, 0xc0};
	for (size_t i = 0; i < invalid_control_flags.size(); ++i) {
		const string invalid_signature = control_flag_client_signature(invalid_control_flags[i]);
		const fs::path reserved_license(string("bad_client_signature_reserved_") + to_string(i) + ".lic");
		fs::remove(reserved_license);
		const string reserved_license_str = reserved_license.string();
		int reserved_argc = 15;
		const char* reserved_argv[] = {"lcc",
									   "license",
									   "issue",
									   "--" PARAM_PRIMARY_KEY,
									   private_key_str.c_str(),
									   "--" PARAM_LICENSE_OUTPUT,
									   reserved_license_str.c_str(),
									   "--" PARAM_PROJECT_FOLDER,
									   project_folder_str.c_str(),
									   "--" PARAM_CLIENT_SIGNATURE,
									   invalid_signature.c_str(),
									   "--" PARAM_LICENSE_FORMAT_VERSION,
									   "201",
									   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
									   "201"};
		const int reserved_result = CommandLineParser::parseCommandLine(reserved_argc, reserved_argv);
		BOOST_CHECK_EQUAL(reserved_result, 1);
		BOOST_CHECK_MESSAGE(!fs::exists(reserved_license),
							"Reserved control flags must not create a license file.");
	}
}

BOOST_AUTO_TEST_CASE(product_issue_license_accepts_valid_client_signature) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_valid_client_signature");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	const string client_signature = valid_client_signature();
	const fs::path expected_license("valid_client_signature.lic");
	fs::remove(expected_license);
	const string expected_license_str = expected_license.string();

	int argc = 11;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   expected_license_str.c_str(),
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str(),
						   "--" PARAM_CLIENT_SIGNATURE,
						   client_signature.c_str()};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_license), "License " + expected_license.string() + " created.");

	CSimpleIniA ini;
	ini.LoadFile(expected_license.c_str());
	BOOST_CHECK_MESSAGE(ini.GetValue(project_name.c_str(), PARAM_CLIENT_SIGNATURE) == client_signature,
						"client signature was written unchanged");
}

BOOST_AUTO_TEST_CASE(product_issue_license_rejects_ip_client_signature_by_default) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_ip_client_signature");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	const string client_signature = ip_client_signature();
	const fs::path expected_license("ip_client_signature.lic");
	fs::remove(expected_license);
	const string expected_license_str = expected_license.string();

	int argc = 15;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   expected_license_str.c_str(),
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str(),
						   "--" PARAM_CLIENT_SIGNATURE,
						   client_signature.c_str(),
						   "--" PARAM_LICENSE_FORMAT_VERSION,
						   "201",
						   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
						   "201"};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(expected_license), "IP client signature requires explicit opt-in.");
}

BOOST_AUTO_TEST_CASE(product_issue_license_accepts_ip_client_signature_with_opt_in) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_ip_client_signature_opt_in");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	const string client_signature = ip_client_signature();
	const fs::path expected_license("ip_client_signature_opt_in.lic");
	fs::remove(expected_license);
	const string expected_license_str = expected_license.string();

	int argc = 16;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   expected_license_str.c_str(),
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str(),
						   "--" PARAM_CLIENT_SIGNATURE,
						   client_signature.c_str(),
						   "--allow-ip-binding",
						   "--" PARAM_LICENSE_FORMAT_VERSION,
						   "201",
						   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
						   "201"};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_license), "License " + expected_license.string() + " created.");

	CSimpleIniA ini;
	ini.LoadFile(expected_license.c_str());
	BOOST_CHECK_MESSAGE(ini.GetValue(project_name.c_str(), PARAM_CLIENT_SIGNATURE) == client_signature,
						"IP client signature was written only with opt-in");
}

BOOST_AUTO_TEST_CASE(product_issue_license_accepts_env_selected_signature_with_opt_in) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_env_client_signature_opt_in");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	const string client_signature = env_selected_client_signature();
	const fs::path expected_license("env_client_signature_opt_in.lic");
	fs::remove(expected_license);
	const string expected_license_str = expected_license.string();

	int argc = 16;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   expected_license_str.c_str(),
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str(),
						   "--" PARAM_CLIENT_SIGNATURE,
						   client_signature.c_str(),
						   "--allow-env-selected-binding",
						   "--" PARAM_LICENSE_FORMAT_VERSION,
						   "201",
						   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
						   "201"};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_license), "License " + expected_license.string() + " created.");

	CSimpleIniA ini;
	ini.LoadFile(expected_license.c_str());
	BOOST_CHECK_MESSAGE(ini.GetValue(project_name.c_str(), PARAM_CLIENT_SIGNATURE) == client_signature,
						"Environment-selected client signature was written only with opt-in");
}

BOOST_AUTO_TEST_CASE(product_issue_license_rejects_invalid_version_bounds) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_invalid_version_bounds");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();

	const fs::path malformed_license("invalid_version_bound.lic");
	fs::remove(malformed_license);
	const string malformed_license_str = malformed_license.string();
	int malformed_argc = 15;
	const char* malformed_argv[] = {"lcc",
									"license",
									"issue",
									"--" PARAM_PRIMARY_KEY,
									private_key_str.c_str(),
									"--" PARAM_LICENSE_OUTPUT,
									malformed_license_str.c_str(),
									"--" PARAM_PROJECT_FOLDER,
									project_folder_str.c_str(),
									"--" PARAM_VERSION_FROM,
									"1..2",
									"--" PARAM_LICENSE_FORMAT_VERSION,
									"201",
									"--" PARAM_TARGET_LICENSE_FORMAT_MAX,
									"201"};
	int malformed_result = CommandLineParser::parseCommandLine(malformed_argc, malformed_argv);
	BOOST_CHECK_EQUAL(malformed_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(malformed_license), "Malformed version bound must not create a license file.");

	const fs::path inverted_license("inverted_version_bound.lic");
	fs::remove(inverted_license);
	const string inverted_license_str = inverted_license.string();
	int inverted_argc = 17;
	const char* inverted_argv[] = {"lcc",
								   "license",
								   "issue",
								   "--" PARAM_PRIMARY_KEY,
								   private_key_str.c_str(),
								   "--" PARAM_LICENSE_OUTPUT,
								   inverted_license_str.c_str(),
								   "--" PARAM_PROJECT_FOLDER,
								   project_folder_str.c_str(),
								   "--" PARAM_VERSION_FROM,
								   "2.0",
								   "--" PARAM_VERSION_TO,
								   "1.9",
								   "--" PARAM_LICENSE_FORMAT_VERSION,
								   "201",
								   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
								   "201"};
	int inverted_result = CommandLineParser::parseCommandLine(inverted_argc, inverted_argv);
	BOOST_CHECK_EQUAL(inverted_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(inverted_license), "Inverted version bounds must not create a license file.");
}

BOOST_AUTO_TEST_CASE(product_issue_license_version_option_is_guarded) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_license_version");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();

	const fs::path v200_license("license_version_200.lic");
	fs::remove(v200_license);
	const string v200_license_str = v200_license.string();
	int v200_argc = 11;
	const char* v200_argv[] = {"lcc",
							   "license",
							   "issue",
							   "--" PARAM_PRIMARY_KEY,
							   private_key_str.c_str(),
							   "--" PARAM_LICENSE_OUTPUT,
							   v200_license_str.c_str(),
							   "--" PARAM_PROJECT_FOLDER,
							   project_folder_str.c_str(),
							   "--" PARAM_LICENSE_FORMAT_VERSION,
							   "200"};
	int v200_result = CommandLineParser::parseCommandLine(v200_argc, v200_argv);
	BOOST_CHECK_EQUAL(v200_result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(v200_license), "v200 license should be created.");
	CSimpleIniA ini;
	ini.LoadFile(v200_license.c_str());
	BOOST_CHECK_MESSAGE(string(ini.GetValue(project_name.c_str(), LICENSE_VERSION, "")) == "200",
						"Explicit v200 option should emit lic_ver 200.");
	const vector<string> v201_only_fields = {LICENSE_CANONICAL_VERSION, LICENSE_SIGNATURE_VERSION,
											 LICENSE_SIGNATURE_ALGORITHM, LICENSE_KEY_ID};
	for (const string &field : v201_only_fields) {
		BOOST_CHECK_MESSAGE(ini.GetValue(project_name.c_str(), field.c_str(), nullptr) == nullptr,
							"v200 output must not contain v201-only field " + field);
	}

	const fs::path v201_license("license_version_201.lic");
	fs::remove(v201_license);
	const string v201_license_str = v201_license.string();
	int ungated_v201_argc = 11;
	const char* ungated_v201_argv[] = {"lcc",
									   "license",
									   "issue",
									   "--" PARAM_PRIMARY_KEY,
									   private_key_str.c_str(),
									   "--" PARAM_LICENSE_OUTPUT,
									   v201_license_str.c_str(),
									   "--" PARAM_PROJECT_FOLDER,
									   project_folder_str.c_str(),
									   "--" PARAM_LICENSE_FORMAT_VERSION,
									   "201"};
	int ungated_v201_result = CommandLineParser::parseCommandLine(ungated_v201_argc, ungated_v201_argv);
	BOOST_CHECK_EQUAL(ungated_v201_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(v201_license),
						"Explicit v201 must require a target-runtime compatibility signal.");

	int v201_argc = 13;
	const char* v201_argv[] = {"lcc",
							   "license",
							   "issue",
							   "--" PARAM_PRIMARY_KEY,
							   private_key_str.c_str(),
							   "--" PARAM_LICENSE_OUTPUT,
							   v201_license_str.c_str(),
							   "--" PARAM_PROJECT_FOLDER,
							   project_folder_str.c_str(),
							   "--" PARAM_LICENSE_FORMAT_VERSION,
							   "201",
							   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
							   "201"};
	int v201_result = CommandLineParser::parseCommandLine(v201_argc, v201_argv);
	BOOST_CHECK_EQUAL(v201_result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(v201_license), "Explicit v201 license should be created.");
	ini.Reset();
	BOOST_REQUIRE_EQUAL(ini.LoadFile(v201_license.c_str()), SI_Error::SI_OK);
	BOOST_CHECK_EQUAL(string(ini.GetValue(project_name.c_str(), LICENSE_VERSION, "")), "201");
	BOOST_CHECK_EQUAL(string(ini.GetValue(project_name.c_str(), LICENSE_CANONICAL_VERSION, "")), "1");
	BOOST_CHECK_EQUAL(string(ini.GetValue(project_name.c_str(), LICENSE_SIGNATURE_VERSION, "")), "1");
	BOOST_CHECK_EQUAL(string(ini.GetValue(project_name.c_str(), LICENSE_SIGNATURE_ALGORITHM, "")),
					  LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	const string key_id = ini.GetValue(project_name.c_str(), LICENSE_KEY_ID, "");
	BOOST_CHECK_EQUAL(key_id.substr(0, 7), "sha256:");
	BOOST_CHECK_EQUAL(key_id.size(), static_cast<size_t>(71));

	const fs::path invalid_license("license_version_invalid.lic");
	fs::remove(invalid_license);
	const string invalid_license_str = invalid_license.string();
	int invalid_argc = 11;
	const char* invalid_argv[] = {"lcc",
								  "license",
								  "issue",
								  "--" PARAM_PRIMARY_KEY,
								  private_key_str.c_str(),
								  "--" PARAM_LICENSE_OUTPUT,
								  invalid_license_str.c_str(),
								  "--" PARAM_PROJECT_FOLDER,
								  project_folder_str.c_str(),
								  "--" PARAM_LICENSE_FORMAT_VERSION,
								  "199"};
	int invalid_result = CommandLineParser::parseCommandLine(invalid_argc, invalid_argv);
	BOOST_CHECK_EQUAL(invalid_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(invalid_license), "Unsupported license versions must not create license files.");
}

BOOST_AUTO_TEST_CASE(product_issue_license_rejects_invalid_cli_and_io_inputs) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_invalid_cli_inputs");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();

	const fs::path unknown_option_license("unknown_option.lic");
	fs::remove(unknown_option_license);
	const string unknown_option_license_str = unknown_option_license.string();
	int unknown_argc = 11;
	const char* unknown_argv[] = {"lcc",
								  "license",
								  "issue",
								  "--" PARAM_PRIMARY_KEY,
								  private_key_str.c_str(),
								  "--" PARAM_LICENSE_OUTPUT,
								  unknown_option_license_str.c_str(),
								  "--" PARAM_PROJECT_FOLDER,
								  project_folder_str.c_str(),
								  "--unknown-option",
								  "value"};
	int unknown_result = CommandLineParser::parseCommandLine(unknown_argc, unknown_argv);
	BOOST_CHECK_EQUAL(unknown_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(unknown_option_license), "Unknown options must not create a license file.");

	const fs::path invalid_date_license("invalid_date.lic");
	fs::remove(invalid_date_license);
	const string invalid_date_license_str = invalid_date_license.string();
	int invalid_date_argc = 15;
	const char* invalid_date_argv[] = {"lcc",
									   "license",
									   "issue",
									   "--" PARAM_PRIMARY_KEY,
									   private_key_str.c_str(),
									   "--" PARAM_LICENSE_OUTPUT,
									   invalid_date_license_str.c_str(),
									   "--" PARAM_PROJECT_FOLDER,
									   project_folder_str.c_str(),
									   "--" PARAM_EXPIRY_DATE,
									   "2020-02-30",
									   "--" PARAM_LICENSE_FORMAT_VERSION,
									   "201",
									   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
									   "201"};
	int invalid_date_result = CommandLineParser::parseCommandLine(invalid_date_argc, invalid_date_argv);
	BOOST_CHECK_EQUAL(invalid_date_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(invalid_date_license), "Invalid dates must not create a license file.");

	const fs::path inverted_date_license("inverted_date.lic");
	fs::remove(inverted_date_license);
	const string inverted_date_license_str = inverted_date_license.string();
	int inverted_date_argc = 17;
	const char* inverted_date_argv[] = {"lcc",
										"license",
										"issue",
										"--" PARAM_PRIMARY_KEY,
										private_key_str.c_str(),
										"--" PARAM_LICENSE_OUTPUT,
										inverted_date_license_str.c_str(),
										"--" PARAM_PROJECT_FOLDER,
										project_folder_str.c_str(),
										"--" PARAM_BEGIN_DATE,
										"2020-02-29",
										"--" PARAM_EXPIRY_DATE,
										"2020-02-28",
										"--" PARAM_LICENSE_FORMAT_VERSION,
										"201",
										"--" PARAM_TARGET_LICENSE_FORMAT_MAX,
										"201"};
	int inverted_date_result = CommandLineParser::parseCommandLine(inverted_date_argc, inverted_date_argv);
	BOOST_CHECK_EQUAL(inverted_date_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(inverted_date_license), "Inverted dates must not create a license file.");

	const fs::path invalid_feature_license("invalid_feature_name.lic");
	fs::remove(invalid_feature_license);
	const string invalid_feature_license_str = invalid_feature_license.string();
	int invalid_feature_argc = 15;
	const char* invalid_feature_argv[] = {"lcc",
										  "license",
										  "issue",
										  "--" PARAM_PRIMARY_KEY,
										  private_key_str.c_str(),
										  "--" PARAM_LICENSE_OUTPUT,
										  invalid_feature_license_str.c_str(),
										  "--" PARAM_PROJECT_FOLDER,
										  project_folder_str.c_str(),
										  "--" PARAM_FEATURE_NAMES,
										  "feature,FEATURE",
										  "--" PARAM_LICENSE_FORMAT_VERSION,
										  "201",
										  "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
										  "201"};
	int invalid_feature_result = CommandLineParser::parseCommandLine(invalid_feature_argc, invalid_feature_argv);
	BOOST_CHECK_EQUAL(invalid_feature_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(invalid_feature_license),
						"Invalid feature names must not create a license file.");

	const fs::path invalid_extra_data_license("invalid_extra_data.lic");
	fs::remove(invalid_extra_data_license);
	const string invalid_extra_data_license_str = invalid_extra_data_license.string();
	int invalid_extra_data_argc = 15;
	const char* invalid_extra_data_argv[] = {"lcc",
											 "license",
											 "issue",
											 "--" PARAM_PRIMARY_KEY,
											 private_key_str.c_str(),
											 "--" PARAM_LICENSE_OUTPUT,
											 invalid_extra_data_license_str.c_str(),
											 "--" PARAM_PROJECT_FOLDER,
											 project_folder_str.c_str(),
											 "--" PARAM_EXTRA_DATA,
											 " leading",
											 "--" PARAM_LICENSE_FORMAT_VERSION,
											 "201",
											 "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
											 "201"};
	int invalid_extra_data_result = CommandLineParser::parseCommandLine(invalid_extra_data_argc,
																		invalid_extra_data_argv);
	BOOST_CHECK_EQUAL(invalid_extra_data_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(invalid_extra_data_license),
						"Invalid extra-data must not create a license file.");

	const fs::path valid_existing_license("valid_existing_no_truncate.lic");
	fs::remove(valid_existing_license);
	const string valid_existing_license_str = valid_existing_license.string();
	int valid_existing_argc = 9;
	const char* valid_existing_argv[] = {"lcc",
										 "license",
										 "issue",
										 "--" PARAM_PRIMARY_KEY,
										 private_key_str.c_str(),
										 "--" PARAM_LICENSE_OUTPUT,
										 valid_existing_license_str.c_str(),
										 "--" PARAM_PROJECT_FOLDER,
										 project_folder_str.c_str()};
	int valid_existing_result = CommandLineParser::parseCommandLine(valid_existing_argc, valid_existing_argv);
	BOOST_REQUIRE_EQUAL(valid_existing_result, 0);
	ifstream valid_existing_in(valid_existing_license_str.c_str(), ios::binary);
	const string valid_existing_original((istreambuf_iterator<char>(valid_existing_in)), istreambuf_iterator<char>());
	BOOST_REQUIRE(!valid_existing_original.empty());

	int invalid_existing_argc = 15;
	const char* invalid_existing_argv[] = {"lcc",
										   "license",
										   "issue",
										   "--" PARAM_PRIMARY_KEY,
										   private_key_str.c_str(),
										   "--" PARAM_LICENSE_OUTPUT,
										   valid_existing_license_str.c_str(),
										   "--" PARAM_PROJECT_FOLDER,
										   project_folder_str.c_str(),
										   "--" PARAM_EXPIRY_DATE,
										   "2020-02-30",
										   "--" PARAM_LICENSE_FORMAT_VERSION,
										   "201",
										   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
										   "201"};
	int invalid_existing_result = CommandLineParser::parseCommandLine(invalid_existing_argc, invalid_existing_argv);
	BOOST_CHECK_EQUAL(invalid_existing_result, 1);
	ifstream valid_existing_after_in(valid_existing_license_str.c_str(), ios::binary);
	const string valid_existing_after((istreambuf_iterator<char>(valid_existing_after_in)),
									  istreambuf_iterator<char>());
	BOOST_CHECK_EQUAL(valid_existing_after, valid_existing_original);

	const fs::path valid_append_license("valid_existing_append.lic");
	fs::remove(valid_append_license);
	const string valid_append_license_str = valid_append_license.string();
	int valid_append_initial_argc = 9;
	const char* valid_append_initial_argv[] = {"lcc",
											   "license",
											   "issue",
											   "--" PARAM_PRIMARY_KEY,
											   private_key_str.c_str(),
											   "--" PARAM_LICENSE_OUTPUT,
											   valid_append_license_str.c_str(),
											   "--" PARAM_PROJECT_FOLDER,
											   project_folder_str.c_str()};
	int valid_append_initial_result =
		CommandLineParser::parseCommandLine(valid_append_initial_argc, valid_append_initial_argv);
	BOOST_REQUIRE_EQUAL(valid_append_initial_result, 0);
	const string valid_append_original = read_binary_file(valid_append_license);
	int valid_append_argc = 11;
	const char* valid_append_argv[] = {"lcc",
									   "license",
									   "issue",
									   "--" PARAM_PRIMARY_KEY,
									   private_key_str.c_str(),
									   "--" PARAM_LICENSE_OUTPUT,
									   valid_append_license_str.c_str(),
									   "--" PARAM_PROJECT_FOLDER,
									   project_folder_str.c_str(),
									   "--" PARAM_FEATURE_NAMES,
									   "EXTRA"};
	int valid_append_result = CommandLineParser::parseCommandLine(valid_append_argc, valid_append_argv);
	BOOST_CHECK_EQUAL(valid_append_result, 0);
	const string valid_append_after = read_binary_file(valid_append_license);
	BOOST_CHECK_MESSAGE(valid_append_after.find("[TEST]") != string::npos, "Original section must be preserved.");
	BOOST_CHECK_MESSAGE(valid_append_after.find("[EXTRA]") != string::npos, "New section must be appended.");
	BOOST_CHECK_MESSAGE(valid_append_after != valid_append_original, "Appending a feature must update the file.");

	const fs::path invalid_key_license("invalid_primary_key.lic");
	fs::remove(invalid_key_license);
	const string invalid_key_license_str = invalid_key_license.string();
	const string missing_private_key = (projects_folder / "missing_private_key.rsa").string();
	int invalid_key_argc = 9;
	const char* invalid_key_argv[] = {"lcc",
									  "license",
									  "issue",
									  "--" PARAM_PRIMARY_KEY,
									  missing_private_key.c_str(),
									  "--" PARAM_LICENSE_OUTPUT,
									  invalid_key_license_str.c_str(),
									  "--" PARAM_PROJECT_FOLDER,
									  project_folder_str.c_str()};
	int invalid_key_result = CommandLineParser::parseCommandLine(invalid_key_argc, invalid_key_argv);
	BOOST_CHECK_EQUAL(invalid_key_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(invalid_key_license), "Missing primary key must not create a license file.");

	const fs::path output_directory("output_directory.lic");
	fs::remove_all(output_directory);
	BOOST_REQUIRE(fs::create_directory(output_directory));
	const string output_directory_str = output_directory.string();
	int output_directory_argc = 9;
	const char* output_directory_argv[] = {"lcc",
										   "license",
										   "issue",
										   "--" PARAM_PRIMARY_KEY,
										   private_key_str.c_str(),
										   "--" PARAM_LICENSE_OUTPUT,
										   output_directory_str.c_str(),
										   "--" PARAM_PROJECT_FOLDER,
										   project_folder_str.c_str()};
	int output_directory_result = CommandLineParser::parseCommandLine(output_directory_argc, output_directory_argv);
	BOOST_CHECK_EQUAL(output_directory_result, 1);
	BOOST_CHECK_MESSAGE(fs::is_directory(output_directory), "Output directory must not be replaced by a file.");

	const string private_key_original = read_binary_file(expectedPrivateKey);
	const string protected_private_key_output = expectedPrivateKey.string();
	int protected_private_key_argc = 9;
	const char* protected_private_key_argv[] = {"lcc",
												"license",
												"issue",
												"--" PARAM_PRIMARY_KEY,
												private_key_str.c_str(),
												"--" PARAM_LICENSE_OUTPUT,
												protected_private_key_output.c_str(),
												"--" PARAM_PROJECT_FOLDER,
												project_folder_str.c_str()};
	int protected_private_key_result =
		CommandLineParser::parseCommandLine(protected_private_key_argc, protected_private_key_argv);
	BOOST_CHECK_EQUAL(protected_private_key_result, 1);
	BOOST_CHECK_EQUAL(read_binary_file(expectedPrivateKey), private_key_original);

	const string public_key_original = read_binary_file(expected_public_key);
	const string protected_public_key_output = expected_public_key.string();
	int protected_public_key_argc = 9;
	const char* protected_public_key_argv[] = {"lcc",
											   "license",
											   "issue",
											   "--" PARAM_PRIMARY_KEY,
											   private_key_str.c_str(),
											   "--" PARAM_LICENSE_OUTPUT,
											   protected_public_key_output.c_str(),
											   "--" PARAM_PROJECT_FOLDER,
											   project_folder_str.c_str()};
	int protected_public_key_result =
		CommandLineParser::parseCommandLine(protected_public_key_argc, protected_public_key_argv);
	BOOST_CHECK_EQUAL(protected_public_key_result, 1);
	BOOST_CHECK_EQUAL(read_binary_file(expected_public_key), public_key_original);

	const fs::path project_metadata(expected_public_key.parent_path() / "licensecc_properties.h");
	const string project_metadata_original = "#define TEST_METADATA 1\n";
	{
		ofstream out(project_metadata.string().c_str(), ios::binary | ios::trunc);
		out << project_metadata_original;
	}
	const string protected_project_metadata_output = project_metadata.string();
	int protected_project_metadata_argc = 9;
	const char* protected_project_metadata_argv[] = {"lcc",
													 "license",
													 "issue",
													 "--" PARAM_PRIMARY_KEY,
													 private_key_str.c_str(),
													 "--" PARAM_LICENSE_OUTPUT,
													 protected_project_metadata_output.c_str(),
													 "--" PARAM_PROJECT_FOLDER,
													 project_folder_str.c_str()};
	int protected_project_metadata_result =
		CommandLineParser::parseCommandLine(protected_project_metadata_argc, protected_project_metadata_argv);
	BOOST_CHECK_EQUAL(protected_project_metadata_result, 1);
	BOOST_CHECK_EQUAL(read_binary_file(project_metadata), project_metadata_original);

	const fs::path corrupt_license("corrupt_existing_license.lic");
	const string corrupt_license_str = corrupt_license.string();
	const string corrupt_original = "[NOT_A_LICENSE]\nfoo = bar\n";
	{
		ofstream out(corrupt_license_str.c_str(), ios::binary | ios::trunc);
		out << corrupt_original;
	}
	int corrupt_argc = 13;
	const char* corrupt_argv[] = {"lcc",
								  "license",
								  "issue",
								  "--" PARAM_PRIMARY_KEY,
								  private_key_str.c_str(),
								  "--" PARAM_LICENSE_OUTPUT,
								  corrupt_license_str.c_str(),
								  "--" PARAM_PROJECT_FOLDER,
								  project_folder_str.c_str(),
								  "--" PARAM_LICENSE_FORMAT_VERSION,
								  "201",
								  "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
								  "201"};
	int corrupt_result = CommandLineParser::parseCommandLine(corrupt_argc, corrupt_argv);
	BOOST_CHECK_EQUAL(corrupt_result, 1);
	ifstream corrupt_in(corrupt_license_str.c_str(), ios::binary);
	const string corrupt_after((istreambuf_iterator<char>(corrupt_in)), istreambuf_iterator<char>());
	BOOST_CHECK_EQUAL(corrupt_after, corrupt_original);

	const fs::path bad_signature_license("bad_signature_existing_license.lic");
	const string bad_signature_license_str = bad_signature_license.string();
	const string bad_signature_original = "[TEST]\nlic_ver = 200\nsig = QUJDRA==\n";
	{
		ofstream out(bad_signature_license_str.c_str(), ios::binary | ios::trunc);
		out << bad_signature_original;
	}
	int bad_signature_argc = 13;
	const char* bad_signature_argv[] = {"lcc",
										"license",
										"issue",
										"--" PARAM_PRIMARY_KEY,
										private_key_str.c_str(),
										"--" PARAM_LICENSE_OUTPUT,
										bad_signature_license_str.c_str(),
										"--" PARAM_PROJECT_FOLDER,
										project_folder_str.c_str(),
										"--" PARAM_LICENSE_FORMAT_VERSION,
										"201",
										"--" PARAM_TARGET_LICENSE_FORMAT_MAX,
										"201"};
	int bad_signature_result = CommandLineParser::parseCommandLine(bad_signature_argc, bad_signature_argv);
	BOOST_CHECK_EQUAL(bad_signature_result, 1);
	BOOST_CHECK_EQUAL(read_binary_file(bad_signature_license), bad_signature_original);

	const fs::path noncanonical_license("noncanonical_existing_license.lic");
	const string noncanonical_license_str = noncanonical_license.string();
	const string noncanonical_original = "[TEST]\nlic_ver = 200\nValid-to = 2050-10-10\nsig = QUJDRA==\n";
	{
		ofstream out(noncanonical_license_str.c_str(), ios::binary | ios::trunc);
		out << noncanonical_original;
	}
	int noncanonical_argc = 13;
	const char* noncanonical_argv[] = {"lcc",
									   "license",
									   "issue",
									   "--" PARAM_PRIMARY_KEY,
									   private_key_str.c_str(),
									   "--" PARAM_LICENSE_OUTPUT,
									   noncanonical_license_str.c_str(),
									   "--" PARAM_PROJECT_FOLDER,
									   project_folder_str.c_str(),
									   "--" PARAM_LICENSE_FORMAT_VERSION,
									   "201",
									   "--" PARAM_TARGET_LICENSE_FORMAT_MAX,
									   "201"};
	int noncanonical_result = CommandLineParser::parseCommandLine(noncanonical_argc, noncanonical_argv);
	BOOST_CHECK_EQUAL(noncanonical_result, 1);
	BOOST_CHECK_EQUAL(read_binary_file(noncanonical_license), noncanonical_original);
}

#if BOOST_VERSION > 106500
BOOST_AUTO_TEST_CASE(product_initialize_issue_license_multi_feature) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects");
	const fs::path expected_project_folder(projects_folder / project_name);
	const fs::path expectedPrivateKey(projects_folder / project_name / PRIVATE_KEY_FNAME);
	const fs::path expected_public_key(projects_folder / project_name / "include" / "licensecc" / project_name /
									   PUBLIC_KEY_INC_FNAME);

	create_project(projects_folder, expectedPrivateKey, expected_public_key, mock_source_folder, project_name);
	const string private_key_str = expectedPrivateKey.string();
	const string project_folder_str = expected_project_folder.string();
	// issue license in standard location
	fs::path expected_license("my_license_multi.lic");
	fs::remove(expected_license);
	int argc = 11;
	const char* argv2[] = {"lcc",
						   "license",
						   "issue",
						   "--" PARAM_PRIMARY_KEY,
						   private_key_str.c_str(),
						   "--" PARAM_LICENSE_OUTPUT,
						   "my_license_multi.lic",
						   "--" PARAM_PROJECT_FOLDER,
						   project_folder_str.c_str(),
						   "-f",
						   "TEST,feature1"};
	int result = CommandLineParser::parseCommandLine(argc, argv2);
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(expected_license), "License " + expected_license.string() + " created.");
	// load a license, check the project name corresponds and there are no extra elements.
	CSimpleIniA ini;
	ini.LoadFile(expected_license.c_str());
	BOOST_CHECK_MESSAGE(ini.GetSectionSize(project_name.c_str()) == 2, "Section [" + project_name + "] has 2 elements");
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("feature1") == 2, "Section [feature1] has 2 elements");
}
#endif

BOOST_AUTO_TEST_CASE(product_initialize_rejects_unsupported_key_import_options) {
	const string project_name("TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_reject_key_import");
	const fs::path expected_project_folder(projects_folder / project_name);
	fs::remove_all(projects_folder);
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();

	const fs::path private_key("imported_private_key.rsa");
	const string private_key_str = private_key.string();
	int primary_argc = 11;
	const char* primary_argv[] = {"lcc",
								  "project",
								  "init",
								  "-n",
								  project_name.c_str(),
								  "--projects-folder",
								  projects_str.c_str(),
								  "--templates",
								  mock_source.c_str(),
								  "--" PARAM_PRIMARY_KEY,
								  private_key_str.c_str()};
	int primary_result = CommandLineParser::parseCommandLine(primary_argc, primary_argv);
	BOOST_CHECK_EQUAL(primary_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(expected_project_folder),
						"Unsupported primary-key import must not initialize a project.");

	const fs::path public_key("imported_public_key.h");
	const string public_key_str = public_key.string();
	int public_argc = 11;
	const char* public_argv[] = {"lcc",
								 "project",
								 "init",
								 "-n",
								 project_name.c_str(),
								 "--projects-folder",
								 projects_str.c_str(),
								 "--templates",
								 mock_source.c_str(),
								 "--public-key",
								 public_key_str.c_str()};
	int public_result = CommandLineParser::parseCommandLine(public_argc, public_argv);
	BOOST_CHECK_EQUAL(public_result, 1);
	BOOST_CHECK_MESSAGE(!fs::exists(expected_project_folder),
						"Unsupported public-key import must not initialize a project.");
}

BOOST_AUTO_TEST_CASE(project_initialize_help_does_not_advertise_unsupported_key_import) {
	int argc = 4;
	const char* argv1[] = {"lcc", "project", "init", "--help"};
	boost::test_tools::output_test_stream output;
	int result = 1;
	{
		cout_redirect guard(output.rdbuf());
		result = CommandLineParser::parseCommandLine(argc, argv1);
	}
	const string stdout_str = output.str();
	BOOST_CHECK_EQUAL(result, 0);
	BOOST_CHECK_MESSAGE(stdout_str.find("projects-folder") != string::npos,
						"project init help was printed " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find(PARAM_PRIMARY_KEY) == string::npos,
						"unsupported primary-key import is not advertised " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("public-key") == string::npos,
						"unsupported public-key import is not advertised " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("key-bits") != string::npos,
						"explicit RSA key-size generation is advertised " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("legacy-rsa1024") != string::npos,
						"explicit legacy RSA-1024 opt-in is advertised " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("allow-insecure-key-size") != string::npos,
						"explicit insecure-key-size opt-in is advertised " + stdout_str);
}

BOOST_AUTO_TEST_CASE(issue_license_help) {
	int argc = 4;
	const char* argv1[] = {"lcc", "license", "issue", "-h"};
	// initialize_project
	boost::test_tools::output_test_stream output;
	{
		cout_redirect guard(output.rdbuf());
		int result = CommandLineParser::parseCommandLine(argc, argv1);
	}
	string stdout_str = output.str();
	BOOST_CHECK_MESSAGE(stdout_str.find(PARAM_CLIENT_SIGNATURE) != string::npos,
						"command help was print out " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("lcc license issue [options]") != string::npos,
						"subcommand help separates the executable and command name " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("allow-ip-binding") != string::npos,
						"weak binding opt-in is documented in help " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("allow-env-selected-binding") != string::npos,
						"environment-selected binding opt-in is documented in help " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find(PARAM_TARGET_LICENSE_FORMAT_MAX) != string::npos,
						"target runtime format gate is documented in help " + stdout_str);
	BOOST_CHECK_MESSAGE(stdout_str.find("Version 2.1.0.") != string::npos,
						"standalone CLI reports the configured generator release version " + stdout_str);
}

/**
 * The project name should not contain '\ / [ ]' charactoers
 */
BOOST_AUTO_TEST_CASE(init_project_name_wrong) {
	const string project_name("a/TEST");
	const fs::path mock_source_folder(fs::path(PROJECT_TEST_SRC_DIR) / "data" / "src");
	const fs::path projects_folder(fs::path(PROJECT_TEST_TEMP_DIR) / "lcc_projects_wa");
	const string mock_source = mock_source_folder.string();
	const string projects_str = projects_folder.string();

	int argc = 9;
	const char* argv1[] = {"lcc",
						   "project",
						   "init",
						   "-n",
						   project_name.c_str(),
						   "--projects-folder",
						   projects_str.c_str(),
						   "--templates",
						   mock_source.c_str()};
	int result;
	boost::test_tools::output_test_stream output;
	{
		cout_redirect guard(output.rdbuf());
		result = CommandLineParser::parseCommandLine(argc, argv1);
	}
	string stdout_str = output.str();
	BOOST_CHECK_EQUAL(result, 1);
	BOOST_CHECK_MESSAGE(stdout_str.find("rror") != string::npos && stdout_str.find("project name") != string::npos,
						"error was print out " + stdout_str);
}

}  // namespace test
}  // namespace license
