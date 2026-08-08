# LeaseRing.cmake
#
# Populate the project verification ring (LCC_ADDITIONAL_PUBLIC_KEY_RECORDS /
# LCC_RETIRED_PUBLIC_KEY_IDS) from a checked-in ring manifest, so the hot/cold
# key split the lease platform depends on is a *regeneration-durable* generated
# artifact rather than a hand-edited public_key.h that a rebuild clobbers.
#
# The records flow into the build via the target_compile_definitions wiring in
# src/library/CMakeLists.txt, exactly like the online-assertion and
# config-attestation rings. See scripts/build_lease_ring.py for the manifest
# format and record shape.

function(lcc_apply_lease_ring_manifest manifest_path)
	if(NOT EXISTS "${manifest_path}")
		message(FATAL_ERROR "LCC_LEASE_RING_MANIFEST does not exist: ${manifest_path}")
	endif()
	find_package(Python3 COMPONENTS Interpreter REQUIRED)
	set(_generated "${CMAKE_BINARY_DIR}/lease_ring_records.cmake")
	execute_process(
		COMMAND "${Python3_EXECUTABLE}"
			"${CMAKE_SOURCE_DIR}/scripts/build_lease_ring.py"
			--manifest "${manifest_path}"
			--out "${_generated}"
		RESULT_VARIABLE _lcc_lease_ring_rc
		OUTPUT_VARIABLE _lcc_lease_ring_out
		ERROR_VARIABLE _lcc_lease_ring_err
	)
	if(NOT _lcc_lease_ring_rc EQUAL 0)
		message(FATAL_ERROR "build_lease_ring.py failed for ${manifest_path}:\n${_lcc_lease_ring_err}")
	endif()
	string(STRIP "${_lcc_lease_ring_out}" _lcc_lease_ring_out)
	message(STATUS "Lease ring: ${_lcc_lease_ring_out}")
	# The generated file uses set(... CACHE STRING ... FORCE), so the records become
	# global cache variables consumed by src/library/CMakeLists.txt.
	include("${_generated}")
endfunction()

# Generate an EPHEMERAL hot lease keypair into the build tree (never committed) and
# wire it into the ring for the golden test. Exposes, in the caller's scope:
#   LCC_LEASE_TEST_HOT_KEY_PATH  - PKCS#1 private key the test signs leases with
#   LCC_LEASE_TEST_HOT_KEY_ID    - sha256:<hex> key id (matches public_key_id_from_der)
function(lcc_generate_test_lease_ring)
	find_program(LCC_OPENSSL_EXE NAMES openssl)
	if(NOT LCC_OPENSSL_EXE)
		message(FATAL_ERROR "LCC_BUILD_LEASE_RING_TEST requires openssl on PATH to generate the test hot key")
	endif()
	find_package(Python3 COMPONENTS Interpreter REQUIRED)

	set(_dir "${CMAKE_BINARY_DIR}/lease_test_ring")
	file(MAKE_DIRECTORY "${_dir}")
	set(_priv "${_dir}/hot_key.private.rsa")
	set(_der "${_dir}/hot_key.pkcs1.der")

	if(NOT EXISTS "${_priv}" OR NOT EXISTS "${_der}")
		# -traditional => PKCS#1 "RSA PRIVATE KEY" (LEGACY_RSAPRIVATE_BLOB), matching lccgen
		# and the Windows CryptoHelper importer; openssl 3.x defaults to PKCS#8 otherwise.
		execute_process(
			COMMAND "${LCC_OPENSSL_EXE}" genrsa -traditional -out "${_priv}" 3072
			RESULT_VARIABLE _rc OUTPUT_QUIET ERROR_VARIABLE _err)
		if(NOT _rc EQUAL 0)
			message(FATAL_ERROR "openssl genrsa failed: ${_err}")
		endif()
		execute_process(
			COMMAND "${LCC_OPENSSL_EXE}" rsa -in "${_priv}" -RSAPublicKey_out -outform DER -out "${_der}"
			RESULT_VARIABLE _rc OUTPUT_QUIET ERROR_VARIABLE _err)
		if(NOT _rc EQUAL 0)
			message(FATAL_ERROR "openssl rsa public export failed: ${_err}")
		endif()
	endif()

	# Records: feed the generated public DER through the same manifest pipeline.
	file(WRITE "${_dir}/ring.json" "{\"additional\":[{\"der\":\"hot_key.pkcs1.der\"}],\"retired\":[]}")
	lcc_apply_lease_ring_manifest("${_dir}/ring.json")

	# Key id == "sha256:" + sha256(PKCS#1 DER), identical to public_key_id_from_der().
	file(SHA256 "${_der}" _hot_sha)
	set(LCC_LEASE_TEST_HOT_KEY_ID "sha256:${_hot_sha}" PARENT_SCOPE)
	set(LCC_LEASE_TEST_HOT_KEY_PATH "${_priv}" PARENT_SCOPE)

	# Cross-language e2e (#8): if node is available, sign a lease in JS with the SAME hot key
	# (via the lease Worker's signer) and hand the file to the C++ test, which verifies a
	# JS-produced lease through the real acquire_license path. node-gated so the C++-only CI
	# job (no node) simply skips the case.
	find_program(LCC_NODE_EXE NAMES node)
	set(_js_license "")
	if(LCC_NODE_EXE)
		set(_pkcs8 "${_dir}/hot_key.pkcs8.pem")
		execute_process(
			COMMAND "${LCC_OPENSSL_EXE}" pkcs8 -topk8 -nocrypt -in "${_priv}" -out "${_pkcs8}"
			RESULT_VARIABLE _rc OUTPUT_QUIET ERROR_VARIABLE _err)
		if(NOT _rc EQUAL 0)
			message(FATAL_ERROR "openssl pkcs8 conversion failed: ${_err}")
		endif()
		string(TOUPPER "${LCC_PROJECT_NAME}" _lease_feature)
		set(_js_license "${_dir}/js_signed_lease.lic")
		execute_process(
			COMMAND "${LCC_NODE_EXE}"
				"${CMAKE_SOURCE_DIR}/services/cloudflare-licensing-backend/scripts/lease-sign.mjs"
				--private-key "${_pkcs8}"
				--key-id "sha256:${_hot_sha}"
				--project "${LCC_PROJECT_NAME}"
				--feature "${_lease_feature}"
				--valid-from "2024-01-02"
				--valid-to "2035-12-31"
				--out "${_js_license}"
			RESULT_VARIABLE _rc OUTPUT_QUIET ERROR_VARIABLE _err)
		if(NOT _rc EQUAL 0)
			message(WARNING "JS lease signer failed; cross-language case skipped: ${_err}")
			set(_js_license "")
		else()
			message(STATUS "Lease cross-language fixture: ${_js_license}")
		endif()
	else()
		message(STATUS "node not found; lease cross-language C++ case will be skipped")
	endif()
	set(LCC_LEASE_TEST_JS_LICENSE "${_js_license}" PARENT_SCOPE)
endfunction()
