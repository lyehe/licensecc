# Signed Config Token — Core Verification (Plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the C++ `config_attestation` module that verifies a server-signed config token (`lcccfg1.<payload>.<sig>`) against the bytes of a config file, mirroring the proven `online_verification` module.

**Architecture:** A new CMake OBJECT library `config_attestation` linked into `licensecc_static`. It reuses the existing crypto substrate: `license::os::signature_sha256_hex` for the config hash, `license::os::verify_signature` + a `SignatureVerificationPolicy` for the RSA‑PKCS1‑SHA256 envelope signature, and `license::base64`/`unbase64`/`is_canonical_base64` for the envelope. Verification is offline; tests inject the trusted public key through a test seam exactly like `online_verification`.

**Tech Stack:** C++11, CMake OBJECT libraries, Boost.Test, the bundled `CryptoHelper` (from `extern/license-generator`) for signing test fixtures.

**Scope:** This is Plan 1 of 3. It delivers the verification core with unit tests. The public `lcc_verify_config` C API, the `config-sign` Node signer, project key generation, and the Cloudflare endpoint are Plans 2 and 3. See `docs/superpowers/specs/2026-06-14-signed-config-token-design.md`.

---

## File Structure

- Create: `src/library/config_attestation/ConfigAttestation.hpp` — public (in-library) types and function declarations for the module.
- Create: `src/library/config_attestation/ConfigAttestation.cpp` — envelope parse, signature verify, claim validation, config-hash check.
- Create: `src/library/config_attestation/CMakeLists.txt` — OBJECT library definition (mirrors `online_verification/CMakeLists.txt`).
- Modify: `src/library/CMakeLists.txt` — register the new OBJECT library (3 edits).
- Create: `test/library/config_attestation_test.cpp` — Boost.Test suite.
- Modify: `test/library/CMakeLists.txt` — add the test executable, `ADD_TEST`, and labels.

The module mirrors `src/library/online_verification/OnlineVerification.{hpp,cpp}`; read that file alongside this plan.

---

## Conventions used in every task

- **Configure (once):** `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug` (a mock `DEFAULT` project is auto-generated; Boost is required). Re-run this command after editing any `CMakeLists.txt`.
- **Build the test:** `cmake --build build --target test_config_attestation`
- **Run the test:** `ctest --test-dir build -R test_config_attestation --output-on-failure`
- **Run one case:** `ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=<case_name>` (or invoke the built binary under `build/test/library/` directly with `--run_test=<case_name>`).
- Commit after each task with the shown message.

---

### Task 1: Scaffold the module (header, CMake, linkable stub)

**Files:**
- Create: `src/library/config_attestation/ConfigAttestation.hpp`
- Create: `src/library/config_attestation/ConfigAttestation.cpp`
- Create: `src/library/config_attestation/CMakeLists.txt`
- Modify: `src/library/CMakeLists.txt`

- [ ] **Step 1: Create the header**

`src/library/config_attestation/ConfigAttestation.hpp`:

```cpp
#ifndef LICENSECC_CONFIG_ATTESTATION_HPP_
#define LICENSECC_CONFIG_ATTESTATION_HPP_

#include <stdint.h>
#include <string>
#include <vector>

namespace license {
namespace config_attestation {

enum class ConfigVerifyFailure {
	None,
	Envelope,
	Signature,
	Metadata,
	Binding,
	HashMismatch,
	Expired,
	Rollback
};

struct ConfigAttestationClaims {
	std::string purpose;
	std::string version;
	std::string algorithm;
	std::string key_id;
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	std::string config_id;
	uint64_t config_seq = 0;
	std::string config_hash;
	uint64_t issued_at = 0;
	uint64_t expires_at = 0;
};

struct ConfigAttestationPublicKey {
	std::string key_id;
	std::vector<uint8_t> public_key_der;
	unsigned int bits = 0;
};

struct ConfigAttestationExpected {
	std::string project;
	std::string feature;
	std::string license_fingerprint;
	std::string device_hash;
	std::vector<uint8_t> config_bytes;
	uint64_t now_epoch_seconds = 0;
	uint64_t min_config_seq = 0;
	std::vector<ConfigAttestationPublicKey> trusted_public_keys;
};

std::string build_canonical_config_payload(const ConfigAttestationClaims& claims);
std::string build_config_envelope(const std::string& payload, const std::string& signature_base64);
bool verify_config_envelope(const std::string& token, const ConfigAttestationExpected& expected,
							ConfigAttestationClaims* claims_out, std::string& error,
							ConfigVerifyFailure& failure);

void set_trusted_public_keys_for_tests(const std::vector<ConfigAttestationPublicKey>& public_keys);

}  // namespace config_attestation
}  // namespace license

#endif
```

- [ ] **Step 2: Create the stub implementation**

`src/library/config_attestation/ConfigAttestation.cpp`:

```cpp
#include "ConfigAttestation.hpp"

#include <mutex>
#include <vector>

namespace license {
namespace config_attestation {
namespace {

std::vector<ConfigAttestationPublicKey>& trusted_public_keys_override() {
	static std::vector<ConfigAttestationPublicKey> public_keys;
	return public_keys;
}

std::mutex& trusted_public_keys_override_mutex() {
	static std::mutex mutex;
	return mutex;
}

}  // namespace

std::string build_canonical_config_payload(const ConfigAttestationClaims&) {
	return std::string();
}

std::string build_config_envelope(const std::string&, const std::string&) {
	return std::string();
}

bool verify_config_envelope(const std::string&, const ConfigAttestationExpected&, ConfigAttestationClaims*,
							std::string& error, ConfigVerifyFailure& failure) {
	failure = ConfigVerifyFailure::Envelope;
	error = "config attestation not implemented";
	return false;
}

void set_trusted_public_keys_for_tests(const std::vector<ConfigAttestationPublicKey>& public_keys) {
	std::lock_guard<std::mutex> lock(trusted_public_keys_override_mutex());
	trusted_public_keys_override() = public_keys;
}

}  // namespace config_attestation
}  // namespace license
```

- [ ] **Step 3: Create the module CMakeLists**

`src/library/config_attestation/CMakeLists.txt` (mirrors `online_verification/CMakeLists.txt`):

```cmake
ADD_LIBRARY(config_attestation OBJECT
    ConfigAttestation.cpp
)

target_include_directories(config_attestation PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../..
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../include
    ${LCC_INCLUDE_DIR}
    ${LCC_PROJECT_INCLUDE_ROOT}
)

target_compile_definitions(config_attestation
    PRIVATE
        "LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
        "LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\""
)
```

- [ ] **Step 4: Register the library in `src/library/CMakeLists.txt`**

Edit 1 — after the line `add_subdirectory("online_verification")` add:

```cmake
add_subdirectory("config_attestation")
```

Edit 2 — in the `foreach(_lcc_generated_metadata_target IN ITEMS ...)` line, add `config_attestation` to the list:

```cmake
foreach(_lcc_generated_metadata_target IN ITEMS base anti_tamper online_verification config_attestation os locate hw_identifier)
```

Edit 3 — in the `ADD_LIBRARY(licensecc_static STATIC ...)` block, after the line `    $<TARGET_OBJECTS:online_verification>` add:

```cmake
    $<TARGET_OBJECTS:config_attestation>
```

- [ ] **Step 5: Configure and build to verify it links**

Run: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build --target licensecc_static`
Expected: configure and build succeed (the new OBJECT library compiles and links into `licensecc_static`).

- [ ] **Step 6: Commit**

```bash
git add src/library/config_attestation/ src/library/CMakeLists.txt
git commit -m "feat(config-attestation): scaffold verification object library"
```

---

### Task 2: Canonical config payload builder

**Files:**
- Modify: `src/library/config_attestation/ConfigAttestation.cpp`
- Create: `test/library/config_attestation_test.cpp`
- Modify: `test/library/CMakeLists.txt`

- [ ] **Step 1: Write the failing test**

Create `test/library/config_attestation_test.cpp`:

```cpp
#define BOOST_TEST_MODULE config_attestation_test

#include <boost/test/unit_test.hpp>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>
#include "../../extern/license-generator/src/base_lib/crypto_helper.hpp"
#include "../../src/library/config_attestation/ConfigAttestation.hpp"
#include "../../src/library/os/os.h"
#include "../../src/library/os/signature_verifier.hpp"

namespace license {
namespace test {
using namespace std;
using config_attestation::ConfigVerifyFailure;

static string sign_payload(const string& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(LCC_PROJECT_PRIVATE_KEY);
	return crypto->signString(payload);
}

static string sha256_hex(const vector<uint8_t>& bytes) {
	return license::os::signature_sha256_hex(bytes);
}

static vector<config_attestation::ConfigAttestationPublicKey> project_public_keys_for_tests() {
	config_attestation::ConfigAttestationPublicKey key;
	key.key_id = license::os::embedded_public_key_id();
	key.public_key_der = license::os::embedded_public_key_der();
	key.bits = license::os::embedded_public_key_bits();
	return vector<config_attestation::ConfigAttestationPublicKey>(1, key);
}

struct ConfigAttestationFixture {
	ConfigAttestationFixture() {
		config_attestation::set_trusted_public_keys_for_tests(project_public_keys_for_tests());
	}
	~ConfigAttestationFixture() {
		config_attestation::set_trusted_public_keys_for_tests(
			vector<config_attestation::ConfigAttestationPublicKey>());
	}
};
BOOST_TEST_GLOBAL_FIXTURE(ConfigAttestationFixture);

static config_attestation::ConfigAttestationExpected base_expected(uint64_t now = 1000) {
	config_attestation::ConfigAttestationExpected e;
	e.project = LCC_PROJECT_NAME;
	e.feature = "CONFIG";
	e.license_fingerprint = string(64, 'a');
	e.device_hash = "";
	const string body = "{\"flag\":true}";
	e.config_bytes.assign(body.begin(), body.end());
	e.now_epoch_seconds = now;
	return e;
}

static config_attestation::ConfigAttestationClaims make_claims(const config_attestation::ConfigAttestationExpected& e,
															   const string& config_id = "app-config",
															   uint64_t config_seq = 5, uint64_t issued_at = 900,
															   uint64_t expires_at = 1100) {
	config_attestation::ConfigAttestationClaims c;
	c.purpose = "licensecc-config-attestation";
	c.version = "1";
	c.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	c.key_id = license::os::embedded_public_key_id();
	c.project = e.project;
	c.feature = e.feature;
	c.license_fingerprint = e.license_fingerprint;
	c.device_hash = e.device_hash;
	c.config_id = config_id;
	c.config_seq = config_seq;
	c.config_hash = string("sha256:") + sha256_hex(e.config_bytes);
	c.issued_at = issued_at;
	c.expires_at = expires_at;
	return c;
}

static string token_for(const config_attestation::ConfigAttestationClaims& c) {
	const string payload = config_attestation::build_canonical_config_payload(c);
	BOOST_REQUIRE(!payload.empty());
	return config_attestation::build_config_envelope(payload, sign_payload(payload));
}

BOOST_AUTO_TEST_CASE(canonical_config_payload_is_byte_exact) {
	config_attestation::ConfigAttestationClaims c;
	c.purpose = "licensecc-config-attestation";
	c.version = "1";
	c.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	c.key_id = "sha256:test-key";
	c.project = "DEFAULT";
	c.feature = "CONFIG";
	c.license_fingerprint = string(64, 'a');
	c.device_hash = string(64, 'b');
	c.config_id = "app-config";
	c.config_seq = 42;
	c.config_hash = string("sha256:") + string(64, 'c');
	c.issued_at = 1000;
	c.expires_at = 1300;

	const string expected = "purpose=licensecc-config-attestation\n"
							"version=1\n"
							"alg=rsa-pkcs1-sha256\n"
							"key-id=sha256:test-key\n"
							"project=DEFAULT\n"
							"feature=CONFIG\n"
							"license-fingerprint=" +
							string(64, 'a') + "\n" + "device-hash=" + string(64, 'b') + "\n" +
							"config-id=app-config\n"
							"config-seq=42\n"
							"config-hash=sha256:" +
							string(64, 'c') + "\n" + "issued-at=1000\n" + "expires-at=1300\n";

	BOOST_CHECK_EQUAL(config_attestation::build_canonical_config_payload(c), expected);
}

}  // namespace test
}  // namespace license
```

- [ ] **Step 2: Register the test in `test/library/CMakeLists.txt`**

Edit 1 — after the `test_online_callback_failover` `target_link_libraries(...)` block (just before the run of `ADD_TEST(...)` lines), add:

```cmake
### Config attestation verification tests
add_executable(
 test_config_attestation
 config_attestation_test.cpp
)

target_link_libraries(
 test_config_attestation
 licensecc_static
 license_generator_lib
 Boost::unit_test_framework
 Boost::system
)
```

Edit 2 — after the line `ADD_TEST(NAME test_online_callback_failover COMMAND test_online_callback_failover)` add:

```cmake
ADD_TEST(NAME test_config_attestation COMMAND test_config_attestation)
```

Edit 3 — after the `set_tests_properties(test_online_callback_failover ...)` block add:

```cmake
set_tests_properties(
 test_config_attestation
 PROPERTIES LABELS "security;config_attestation"
)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: `canonical_config_payload_is_byte_exact` FAILS (`build_canonical_config_payload` returns an empty string, so `token_for`/`BOOST_CHECK_EQUAL` mismatch; the suite fails).

- [ ] **Step 4: Implement the builder**

In `ConfigAttestation.cpp`, add these helpers inside the anonymous namespace (after the trusted-keys helpers):

```cpp
bool value_has_line_breaks_or_equals(const std::string& value) {
	return value.find('\n') != std::string::npos || value.find('\r') != std::string::npos ||
		   value.find('=') != std::string::npos;
}

bool append_claim_line(std::ostringstream& out, const char* key, const std::string& value) {
	if (value_has_line_breaks_or_equals(value)) {
		return false;
	}
	out << key << '=' << value << '\n';
	return true;
}

bool append_uint_claim_line(std::ostringstream& out, const char* key, const uint64_t value) {
	out << key << '=' << value << '\n';
	return true;
}
```

Add `#include <sstream>` to the top includes. Then replace the `build_canonical_config_payload` stub body with:

```cpp
std::string build_canonical_config_payload(const ConfigAttestationClaims& claims) {
	std::ostringstream out;
	if (!append_claim_line(out, "purpose", claims.purpose) || !append_claim_line(out, "version", claims.version) ||
		!append_claim_line(out, "alg", claims.algorithm) || !append_claim_line(out, "key-id", claims.key_id) ||
		!append_claim_line(out, "project", claims.project) || !append_claim_line(out, "feature", claims.feature) ||
		!append_claim_line(out, "license-fingerprint", claims.license_fingerprint) ||
		!append_claim_line(out, "device-hash", claims.device_hash) ||
		!append_claim_line(out, "config-id", claims.config_id) ||
		!append_uint_claim_line(out, "config-seq", claims.config_seq) ||
		!append_claim_line(out, "config-hash", claims.config_hash) ||
		!append_uint_claim_line(out, "issued-at", claims.issued_at) ||
		!append_uint_claim_line(out, "expires-at", claims.expires_at)) {
		return std::string();
	}
	return out.str();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=canonical_config_payload_is_byte_exact`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/library/config_attestation/ConfigAttestation.cpp test/library/config_attestation_test.cpp test/library/CMakeLists.txt
git commit -m "feat(config-attestation): canonical payload builder"
```

---

### Task 3: Envelope build + verify pipeline (signature + metadata)

**Files:**
- Modify: `src/library/config_attestation/ConfigAttestation.cpp`
- Modify: `test/library/config_attestation_test.cpp`

- [ ] **Step 1: Write the failing test**

Add to `config_attestation_test.cpp` before the closing `}  // namespace test`:

```cpp
BOOST_AUTO_TEST_CASE(verifier_accepts_valid_token_and_rejects_envelope_and_signature_tampering) {
	auto e = base_expected();
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;
	config_attestation::ConfigAttestationClaims out;

	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, &out, error, failure));
	BOOST_CHECK(error.empty());
	BOOST_CHECK_EQUAL(out.config_id, "app-config");

	BOOST_CHECK(!config_attestation::verify_config_envelope("bad." + token, e, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Envelope);

	string tampered = token;
	const size_t first = tampered.find('.');
	const size_t second = tampered.find('.', first + 1);
	BOOST_REQUIRE(second != string::npos);
	tampered[second + 1] = tampered[second + 1] == 'A' ? 'B' : 'A';
	BOOST_CHECK(!config_attestation::verify_config_envelope(tampered, e, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Signature);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=verifier_accepts_valid_token_and_rejects_envelope_and_signature_tampering`
Expected: FAIL (`verify_config_envelope` is still the stub returning false, so the first `BOOST_CHECK(verify...)` fails).

- [ ] **Step 3: Implement the envelope + verify pipeline**

In `ConfigAttestation.cpp`, update the top includes to:

```cpp
#include "ConfigAttestation.hpp"

#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "../base/base64.h"
#include "../os/os.h"
#include "../os/signature_verifier.hpp"
```

Add these constants and helpers inside the anonymous namespace (after the builder helpers):

```cpp
const char kEnvelopePrefix[] = "lcccfg1";
const char kPurpose[] = "licensecc-config-attestation";
const char kVersion[] = "1";
const unsigned int kConfigSignatureVersion = 9002U;

std::vector<ConfigAttestationPublicKey> current_trusted_public_keys() {
	std::lock_guard<std::mutex> lock(trusted_public_keys_override_mutex());
	return trusted_public_keys_override();
}

bool parse_uint64(const std::string& value, uint64_t& out) {
	if (value.empty()) {
		return false;
	}
	uint64_t result = 0;
	for (const unsigned char ch : value) {
		if (ch < '0' || ch > '9') {
			return false;
		}
		const uint64_t digit = static_cast<uint64_t>(ch - '0');
		if (result > (UINT64_MAX - digit) / 10U) {
			return false;
		}
		result = result * 10U + digit;
	}
	out = result;
	return true;
}

bool extract_preverify_field(const std::string& payload, const char* key, std::string& out) {
	const std::string prefix = std::string(key) + "=";
	size_t pos = 0;
	while (pos < payload.size()) {
		const size_t next = payload.find('\n', pos);
		if (next == std::string::npos) {
			return false;
		}
		const std::string line = payload.substr(pos, next - pos);
		if (line.find(prefix) == 0) {
			out = line.substr(prefix.size());
			return !out.empty();
		}
		pos = next + 1;
	}
	return false;
}

license::os::SignatureVerificationPolicy config_signature_policy(const ConfigAttestationExpected& expected) {
	license::os::SignatureVerificationPolicy policy;
	policy.license_version = kConfigSignatureVersion;
	policy.allowed_algorithms.push_back(license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	policy.min_public_key_bits = 0;
	const std::vector<ConfigAttestationPublicKey> trusted =
		expected.trusted_public_keys.empty() ? current_trusted_public_keys() : expected.trusted_public_keys;
	for (const ConfigAttestationPublicKey& public_key : trusted) {
		policy.public_keys.push_back(
			license::os::SignaturePublicKey(public_key.key_id, public_key.public_key_der, public_key.bits));
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	return policy;
}

bool split_envelope(const std::string& token, std::string& payload_b64, std::string& signature_b64,
					std::string& error) {
	const size_t first_dot = token.find('.');
	if (first_dot == std::string::npos) {
		error = "config token missing payload";
		return false;
	}
	const size_t second_dot = token.find('.', first_dot + 1);
	if (second_dot == std::string::npos || token.find('.', second_dot + 1) != std::string::npos) {
		error = "config token envelope malformed";
		return false;
	}
	if (token.substr(0, first_dot) != kEnvelopePrefix) {
		error = "config token prefix mismatch";
		return false;
	}
	payload_b64 = token.substr(first_dot + 1, second_dot - first_dot - 1);
	signature_b64 = token.substr(second_dot + 1);
	if (!license::is_canonical_base64(payload_b64, false) || !license::is_canonical_base64(signature_b64, false)) {
		error = "config token base64 is not canonical";
		return false;
	}
	return true;
}

bool parse_canonical_payload(const std::string& payload, ConfigAttestationClaims& claims, std::string& error) {
	if (payload.empty() || payload[payload.size() - 1] != '\n' || payload.find('\r') != std::string::npos) {
		error = "config token payload is not canonical";
		return false;
	}
	std::string config_seq;
	std::string issued_at;
	std::string expires_at;
	const struct {
		const char* key;
		std::string* value;
	} fields[] = {
		{"purpose", &claims.purpose},
		{"version", &claims.version},
		{"alg", &claims.algorithm},
		{"key-id", &claims.key_id},
		{"project", &claims.project},
		{"feature", &claims.feature},
		{"license-fingerprint", &claims.license_fingerprint},
		{"device-hash", &claims.device_hash},
		{"config-id", &claims.config_id},
		{"config-seq", &config_seq},
		{"config-hash", &claims.config_hash},
		{"issued-at", &issued_at},
		{"expires-at", &expires_at},
	};
	size_t pos = 0;
	for (const auto& field : fields) {
		const size_t next = payload.find('\n', pos);
		if (next == std::string::npos) {
			error = std::string("config token missing field ") + field.key;
			return false;
		}
		const std::string line = payload.substr(pos, next - pos);
		const std::string prefix = std::string(field.key) + "=";
		if (line.find(prefix) != 0) {
			error = std::string("config token expected field ") + field.key;
			return false;
		}
		*field.value = line.substr(prefix.size());
		pos = next + 1;
	}
	if (pos != payload.size()) {
		error = "config token has unknown trailing fields";
		return false;
	}
	if (!parse_uint64(config_seq, claims.config_seq) || !parse_uint64(issued_at, claims.issued_at) ||
		!parse_uint64(expires_at, claims.expires_at)) {
		error = "config token integer field malformed";
		return false;
	}
	return true;
}

bool verify_payload_signature(const std::vector<uint8_t>& payload, const std::vector<uint8_t>& signature,
							  const std::string& payload_text, const ConfigAttestationExpected& expected,
							  std::string& error) {
	std::string algorithm;
	std::string key_id;
	if (!extract_preverify_field(payload_text, "alg", algorithm) ||
		!extract_preverify_field(payload_text, "key-id", key_id)) {
		error = "config token missing signature metadata";
		return false;
	}
	license::os::SignatureVerificationRequest request;
	request.payload = payload;
	request.signature = signature;
	request.declared_algorithm = algorithm;
	request.key_id = key_id;
	request.license_version = kConfigSignatureVersion;
	request.policy = config_signature_policy(expected);
	if (license::os::verify_signature(request) != FUNC_RET_OK) {
		error = "config token signature verification failed";
		return false;
	}
	return true;
}

bool validate_claims(const ConfigAttestationClaims& claims, const ConfigAttestationExpected& expected,
					 std::string& error, ConfigVerifyFailure& failure) {
	(void)expected;
	if (claims.purpose != kPurpose || claims.version != kVersion ||
		claims.algorithm != license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256) {
		failure = ConfigVerifyFailure::Metadata;
		error = "config token metadata mismatch";
		return false;
	}
	return true;
}
```

Replace the `build_config_envelope` and `verify_config_envelope` stub bodies with:

```cpp
std::string build_config_envelope(const std::string& payload, const std::string& signature_base64) {
	const std::string payload_b64 = license::base64(payload.data(), payload.size(), 0);
	return std::string(kEnvelopePrefix) + "." + payload_b64 + "." + signature_base64;
}

bool verify_config_envelope(const std::string& token, const ConfigAttestationExpected& expected,
							ConfigAttestationClaims* claims_out, std::string& error, ConfigVerifyFailure& failure) {
	failure = ConfigVerifyFailure::None;
	std::string payload_b64;
	std::string signature_b64;
	if (!split_envelope(token, payload_b64, signature_b64, error)) {
		failure = ConfigVerifyFailure::Envelope;
		return false;
	}
	const std::vector<uint8_t> payload = license::unbase64(payload_b64);
	const std::vector<uint8_t> signature = license::unbase64(signature_b64);
	if (payload.empty() || signature.empty()) {
		failure = ConfigVerifyFailure::Envelope;
		error = "config token decoded payload or signature is empty";
		return false;
	}
	const std::string payload_text(payload.begin(), payload.end());
	if (!verify_payload_signature(payload, signature, payload_text, expected, error)) {
		failure = ConfigVerifyFailure::Signature;
		return false;
	}
	ConfigAttestationClaims claims;
	if (!parse_canonical_payload(payload_text, claims, error)) {
		failure = ConfigVerifyFailure::Envelope;
		return false;
	}
	if (!validate_claims(claims, expected, error, failure)) {
		return false;
	}
	if (claims_out != nullptr) {
		*claims_out = claims;
	}
	return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: PASS (all cases so far).

- [ ] **Step 5: Commit**

```bash
git add src/library/config_attestation/ConfigAttestation.cpp test/library/config_attestation_test.cpp
git commit -m "feat(config-attestation): envelope build and signature/metadata verify"
```

---

### Task 4: Request binding check

**Files:**
- Modify: `src/library/config_attestation/ConfigAttestation.cpp`
- Modify: `test/library/config_attestation_test.cpp`

- [ ] **Step 1: Write the failing test**

Add before the closing `}  // namespace test`:

```cpp
BOOST_AUTO_TEST_CASE(verifier_rejects_binding_mismatch) {
	auto e = base_expected();
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	auto expect_binding_denied = [&](config_attestation::ConfigAttestationExpected bad) {
		BOOST_CHECK(!config_attestation::verify_config_envelope(token, bad, nullptr, error, failure));
		BOOST_CHECK(failure == ConfigVerifyFailure::Binding);
	};
	{ auto bad = e; bad.project = "OTHER"; expect_binding_denied(bad); }
	{ auto bad = e; bad.feature = "OTHER"; expect_binding_denied(bad); }
	{ auto bad = e; bad.license_fingerprint = string(64, 'b'); expect_binding_denied(bad); }
	{ auto bad = e; bad.device_hash = string(64, 'c'); expect_binding_denied(bad); }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=verifier_rejects_binding_mismatch`
Expected: FAIL (no binding check yet, so `verify_config_envelope` returns true and the `BOOST_CHECK(!...)` fails).

- [ ] **Step 3: Add the binding block**

In `validate_claims`, immediately before the final `return true;`, add:

```cpp
	if (claims.project != expected.project || claims.feature != expected.feature ||
		claims.license_fingerprint != expected.license_fingerprint || claims.device_hash != expected.device_hash) {
		failure = ConfigVerifyFailure::Binding;
		error = "config token request binding mismatch";
		return false;
	}
```

Remove the now-unneeded `(void)expected;` line at the top of `validate_claims`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/config_attestation/ConfigAttestation.cpp test/library/config_attestation_test.cpp
git commit -m "feat(config-attestation): enforce request binding"
```

---

### Task 5: Config-hash check (tamper detection)

**Files:**
- Modify: `src/library/config_attestation/ConfigAttestation.cpp`
- Modify: `test/library/config_attestation_test.cpp`

- [ ] **Step 1: Write the failing test**

Add before the closing `}  // namespace test`:

```cpp
BOOST_AUTO_TEST_CASE(verifier_rejects_config_byte_tamper) {
	auto e = base_expected();
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	auto tampered = e;
	tampered.config_bytes[0] = static_cast<uint8_t>(tampered.config_bytes[0] ^ 0x01);
	BOOST_CHECK(!config_attestation::verify_config_envelope(token, tampered, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::HashMismatch);

	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, nullptr, error, failure));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=verifier_rejects_config_byte_tamper`
Expected: FAIL (no hash check yet; tampered config still verifies).

- [ ] **Step 3: Add the hash block**

In `validate_claims`, immediately before the final `return true;` (after the binding block), add:

```cpp
	const std::string expected_config_hash =
		std::string("sha256:") + license::os::signature_sha256_hex(expected.config_bytes);
	if (claims.config_hash != expected_config_hash) {
		failure = ConfigVerifyFailure::HashMismatch;
		error = "config token hash does not match config bytes";
		return false;
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/config_attestation/ConfigAttestation.cpp test/library/config_attestation_test.cpp
git commit -m "feat(config-attestation): verify config bytes against signed hash"
```

---

### Task 6: Expiry window

**Files:**
- Modify: `src/library/config_attestation/ConfigAttestation.cpp`
- Modify: `test/library/config_attestation_test.cpp`

- [ ] **Step 1: Write the failing test**

Add before the closing `}  // namespace test`:

```cpp
BOOST_AUTO_TEST_CASE(verifier_enforces_expiry_window) {
	auto e = base_expected(1000);
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	{
		const string t = token_for(make_claims(e, "app-config", 5, 900, 950));
		BOOST_CHECK(!config_attestation::verify_config_envelope(t, e, nullptr, error, failure));
		BOOST_CHECK(failure == ConfigVerifyFailure::Expired);
	}
	{
		const string t = token_for(make_claims(e, "app-config", 5, 900, 0));
		BOOST_CHECK(config_attestation::verify_config_envelope(t, e, nullptr, error, failure));
	}
	{
		const string t = token_for(make_claims(e, "app-config", 5, 1000 + 301, 0));
		BOOST_CHECK(!config_attestation::verify_config_envelope(t, e, nullptr, error, failure));
		BOOST_CHECK(failure == ConfigVerifyFailure::Expired);
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=verifier_enforces_expiry_window`
Expected: FAIL (no time check yet; the expired token verifies).

- [ ] **Step 3: Add the time helper and block**

In `ConfigAttestation.cpp`, add `#include <ctime>` to the includes. Add this helper inside the anonymous namespace (near the other helpers):

```cpp
const uint64_t kIssuedAtFutureSkewSeconds = 300;

uint64_t now_epoch_seconds() {
	return static_cast<uint64_t>(time(nullptr));
}
```

In `validate_claims`, immediately before the final `return true;` (after the hash block), add:

```cpp
	const uint64_t now = expected.now_epoch_seconds == 0 ? now_epoch_seconds() : expected.now_epoch_seconds;
	if (claims.issued_at > now + kIssuedAtFutureSkewSeconds) {
		failure = ConfigVerifyFailure::Expired;
		error = "config token issued in the future";
		return false;
	}
	if (claims.expires_at != 0 && (claims.expires_at < claims.issued_at || claims.expires_at < now)) {
		failure = ConfigVerifyFailure::Expired;
		error = "config token expired";
		return false;
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/config_attestation/ConfigAttestation.cpp test/library/config_attestation_test.cpp
git commit -m "feat(config-attestation): enforce issued/expires window"
```

---

### Task 7: Config-seq rollback floor

**Files:**
- Modify: `src/library/config_attestation/ConfigAttestation.cpp`
- Modify: `test/library/config_attestation_test.cpp`

- [ ] **Step 1: Write the failing test**

Add before the closing `}  // namespace test`:

```cpp
BOOST_AUTO_TEST_CASE(verifier_enforces_config_seq_floor) {
	auto e = base_expected();
	const string token = token_for(make_claims(e, "app-config", 5, 900, 1100));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	auto below = e;
	below.min_config_seq = 6;
	BOOST_CHECK(!config_attestation::verify_config_envelope(token, below, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Rollback);

	auto at = e;
	at.min_config_seq = 5;
	BOOST_CHECK(config_attestation::verify_config_envelope(token, at, nullptr, error, failure));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure -- --run_test=verifier_enforces_config_seq_floor`
Expected: FAIL (no seq check yet; the below-floor token verifies).

- [ ] **Step 3: Add the rollback block**

In `validate_claims`, immediately before the final `return true;` (after the time block), add:

```cpp
	if (claims.config_seq < expected.min_config_seq) {
		failure = ConfigVerifyFailure::Rollback;
		error = "config token sequence is below the minimum";
		return false;
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/config_attestation/ConfigAttestation.cpp test/library/config_attestation_test.cpp
git commit -m "feat(config-attestation): enforce config-seq rollback floor"
```

---

### Task 8: Large-config scale guard

**Files:**
- Modify: `test/library/config_attestation_test.cpp`

- [ ] **Step 1: Write the test**

Add before the closing `}  // namespace test`:

```cpp
BOOST_AUTO_TEST_CASE(verifier_accepts_large_config) {
	auto e = base_expected();
	e.config_bytes.assign(static_cast<size_t>(1024) * 1024, 0x5A);
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, nullptr, error, failure));
	BOOST_CHECK(error.empty());
}
```

- [ ] **Step 2: Run the test**

Run: `cmake --build build --target test_config_attestation && ctest --test-dir build -R test_config_attestation --output-on-failure`
Expected: PASS (a 1 MB config hashes and verifies; this is a scale/regression guard, so it passes immediately on the finished verifier).

- [ ] **Step 3: Commit**

```bash
git add test/library/config_attestation_test.cpp
git commit -m "test(config-attestation): large config scale guard"
```

---

## Final verification

- [ ] Run the full module suite: `ctest --test-dir build -R test_config_attestation --output-on-failure`. Expected: all 8 cases PASS.
- [ ] Run the label group: `ctest --test-dir build -L config_attestation --output-on-failure`. Expected: PASS.
- [ ] Confirm no regression in the neighbouring suite: `ctest --test-dir build -R "test_online_verification|test_public_api" --output-on-failure`. Expected: PASS.

---

## Out of scope (next plans)

- **Plan 2 (productization):** `lcc_verify_config` public C API + `LccConfig*` structs + `LCC_CONFIG_*` event codes in `include/licensecc/`; the `config-sign` Node signer + cross-language golden fixtures; project config-signing key generation (`lccgen` + `licensecc_properties.h.in` + `LCC_API_CONFIG_ATTESTATION`); example host; docs.
- **Plan 3 (floor + online issuance):** persistent `config-seq` floor callbacks keyed per `config-id`; Cloudflare `POST /v1/config/attest` endpoint with the authorization policy hook.
