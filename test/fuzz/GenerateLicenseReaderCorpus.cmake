if(NOT DEFINED LCC_FUZZ_LCCGEN OR LCC_FUZZ_LCCGEN STREQUAL "")
	message(FATAL_ERROR "LCC_FUZZ_LCCGEN is required")
endif()
if(NOT DEFINED LCC_FUZZ_PROJECT_DIR OR LCC_FUZZ_PROJECT_DIR STREQUAL "")
	message(FATAL_ERROR "LCC_FUZZ_PROJECT_DIR is required")
endif()
if(NOT DEFINED LCC_FUZZ_PROJECT_NAME OR LCC_FUZZ_PROJECT_NAME STREQUAL "")
	message(FATAL_ERROR "LCC_FUZZ_PROJECT_NAME is required")
endif()
if(NOT DEFINED LCC_FUZZ_OUTPUT_DIR OR LCC_FUZZ_OUTPUT_DIR STREQUAL "")
	message(FATAL_ERROR "LCC_FUZZ_OUTPUT_DIR is required")
endif()

set(_private_key "${LCC_FUZZ_PROJECT_DIR}/private_key.rsa")
if(NOT EXISTS "${_private_key}")
	message(FATAL_ERROR "Fuzz corpus private key is missing: ${_private_key}")
endif()

file(REMOVE_RECURSE "${LCC_FUZZ_OUTPUT_DIR}")
file(MAKE_DIRECTORY "${LCC_FUZZ_OUTPUT_DIR}")

function(lcc_fuzz_issue output_name)
	set(_output "${LCC_FUZZ_OUTPUT_DIR}/${output_name}.lic")
	execute_process(
		COMMAND "${LCC_FUZZ_LCCGEN}" license issue
			--primary-key "${_private_key}"
			--output-file-name "${_output}"
			--project-folder "${LCC_FUZZ_PROJECT_DIR}"
			${ARGN}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR "lccgen failed while creating ${output_name}: ${_stdout}\n${_stderr}")
	endif()
	if(NOT EXISTS "${_output}")
		message(FATAL_ERROR "lccgen did not create expected corpus file: ${_output}")
	endif()
	set(${output_name} "${_output}" PARENT_SCOPE)
endfunction()

function(lcc_fuzz_read path out_var)
	file(READ "${path}" _content)
	set(${out_var} "${_content}" PARENT_SCOPE)
endfunction()

function(lcc_fuzz_write output_name content)
	file(WRITE "${LCC_FUZZ_OUTPUT_DIR}/${output_name}.lic" "${content}")
endfunction()

function(lcc_fuzz_write_raw output_name content)
	file(WRITE "${LCC_FUZZ_OUTPUT_DIR}/${output_name}" "${content}")
endfunction()

function(lcc_fuzz_replace_text content from to out_var)
	string(REPLACE "${from}" "${to}" _result "${content}")
	set(${out_var} "${_result}" PARENT_SCOPE)
endfunction()

function(lcc_fuzz_replace_line content prefix replacement out_var)
	string(REGEX REPLACE "(^|\n)${prefix}[^\n]*" "\\1${replacement}" _result "${content}")
	set(${out_var} "${_result}" PARENT_SCOPE)
endfunction()

function(lcc_fuzz_sign out_var data)
	set(_signature_file "${LCC_FUZZ_OUTPUT_DIR}/${out_var}.sig")
	execute_process(
		COMMAND "${LCC_FUZZ_LCCGEN}" test sign
			--primary-key "${_private_key}"
			-d "${data}"
			-o "${_signature_file}"
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR "lccgen test sign failed for ${out_var}: ${_stdout}\n${_stderr}")
	endif()
	file(READ "${_signature_file}" _signature)
	string(STRIP "${_signature}" _signature)
	file(REMOVE "${_signature_file}")
	set(${out_var} "${_signature}" PARENT_SCOPE)
endfunction()

function(lcc_fuzz_write_signed_extra_data output_name extra_data)
	set(_license_version "200")
	set(_payload "${LCC_FUZZ_PROJECT_NAME}extra-data${extra_data}lic_ver${_license_version}")
	lcc_fuzz_sign(_signature "${_payload}")
	lcc_fuzz_write("${output_name}"
		"[${LCC_FUZZ_PROJECT_NAME}]\nlic_ver = ${_license_version}\nextra-data = ${extra_data}\nsig = ${_signature}\n")
endfunction()

function(lcc_fuzz_write_signed_client_signature output_name client_signature)
	set(_license_version "200")
	set(_payload "${LCC_FUZZ_PROJECT_NAME}client-signature${client_signature}lic_ver${_license_version}")
	lcc_fuzz_sign(_signature "${_payload}")
	lcc_fuzz_write("${output_name}"
		"[${LCC_FUZZ_PROJECT_NAME}]\nlic_ver = ${_license_version}\nclient-signature = ${client_signature}\nsig = ${_signature}\n")
endfunction()

function(lcc_fuzz_write_oversized_append output_name content tamper)
	string(LENGTH "${content}" _content_length)
	string(LENGTH "${tamper}" _tamper_length)
	math(EXPR _padding_length "4097 - ${_content_length} - ${_tamper_length}")
	if(_padding_length LESS 0)
		message(FATAL_ERROR "Cannot create oversized corpus ${output_name}: content and tamper exceed target")
	endif()
	string(REPEAT "A" ${_padding_length} _padding)
	lcc_fuzz_write("${output_name}" "${content}${tamper}${_padding}")
endfunction()

lcc_fuzz_issue(valid_v200)
lcc_fuzz_issue(valid_v200_base64 --base64)
lcc_fuzz_issue(valid_v200_full
	--valid-from 2020-01-01
	--valid-to 2050-10-10
	--start-version 1.2.0
	--end-version 1.4.0
	--client-signature AEBC-Q0RF-Rkc=
	--extra-data alpha
)
lcc_fuzz_issue(valid_v201 --license-version 201 --target-license-format-max 201)
lcc_fuzz_issue(valid_v201_full
	--license-version 201
	--target-license-format-max 201
	--valid-from 2020-01-01
	--valid-to 2050-10-10
	--start-version 1.2.0
	--end-version 1.4.0
	--client-signature AEBC-Q0RF-Rkc=
	--extra-data alpha
)

lcc_fuzz_read("${valid_v200}" _v200)
lcc_fuzz_read("${valid_v200_base64}" _v200_base64)
lcc_fuzz_read("${valid_v200_full}" _v200_full)
lcc_fuzz_read("${valid_v201}" _v201)
lcc_fuzz_read("${valid_v201_full}" _v201_full)

lcc_fuzz_write(encoded_valid_v200 "${_v200_base64}")
lcc_fuzz_replace_text("${_v200_full}" "valid-to = 2050-10-10" "valid = -to2050-10-10" _split_expiry)
lcc_fuzz_write(v200_split_expiry_key "${_split_expiry}")
lcc_fuzz_write(v200_unknown_key "${_v200}\nunknown-key = value\n")
lcc_fuzz_replace_line("${_v200}" "sig = " "" _missing_sig)
lcc_fuzz_write(v200_missing_sig "${_missing_sig}")
lcc_fuzz_replace_line("${_v200}" "sig = " "sig = " _empty_sig)
lcc_fuzz_write(v200_empty_sig "${_empty_sig}")
string(REGEX MATCH "sig = [^\n]*" _sig_line "${_v200}")
lcc_fuzz_write(v200_duplicate_sig "${_v200}\n${_sig_line}\n")
lcc_fuzz_replace_line("${_v200}" "sig = " "sig = !!!!" _bad_sig_base64)
lcc_fuzz_write(v200_invalid_signature_base64 "${_bad_sig_base64}")
lcc_fuzz_replace_line("${_v200}" "sig = " "sig = AAAA" _short_sig_1)
lcc_fuzz_write(v200_signature_short_aaaa "${_short_sig_1}")
lcc_fuzz_replace_line("${_v200}" "sig = " "sig = QUFBQUFBQUFB" _short_sig_2)
lcc_fuzz_write(v200_signature_short_qufb "${_short_sig_2}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver = not-a-version" _malformed_lic_ver)
lcc_fuzz_write(v200_malformed_license_version "${_malformed_lic_ver}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver = 0200" _lic_ver_octal)
lcc_fuzz_write(v200_noncanonical_license_version_octal "${_lic_ver_octal}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver = +200" _lic_ver_plus)
lcc_fuzz_write(v200_noncanonical_license_version_plus "${_lic_ver_plus}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver = 200x" _lic_ver_suffix)
lcc_fuzz_write(v200_noncanonical_license_version_suffix "${_lic_ver_suffix}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver =  200" _lic_ver_leading_space)
lcc_fuzz_write(v200_noncanonical_license_version_leading_space "${_lic_ver_leading_space}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver = 200 " _lic_ver_trailing_space)
lcc_fuzz_write(v200_noncanonical_license_version_trailing_space "${_lic_ver_trailing_space}")
lcc_fuzz_replace_line("${_v200}" "lic_ver = " "lic_ver = 201" _unsupported_lic_ver)
lcc_fuzz_write(v200_unsupported_license_version "${_unsupported_lic_ver}")
lcc_fuzz_write(v200_duplicate_lic_ver "${_v200}\nlic_ver = 200\n")

string(REPLACE "valid-to = 2050-10-10" "Valid-to = 2050-10-10" _uppercase_key "${_v200_full}")
lcc_fuzz_write(v200_uppercase_key "${_uppercase_key}")
lcc_fuzz_write(v200_duplicate_expiry "${_v200_full}\nvalid-to = 2050-10-10\n")
string(REPLACE "valid-to = 2050-10-10" "valid-to = not-a-date" _malformed_date "${_v200_full}")
lcc_fuzz_write(v200_malformed_date "${_malformed_date}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 20501010" _compact_date "${_v200_full}")
lcc_fuzz_write(v200_noncanonical_date_compact "${_compact_date}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 2050/10/10" _slash_date "${_v200_full}")
lcc_fuzz_write(v200_noncanonical_date_slash "${_slash_date}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 2050-02-30" _bad_date "${_v200_full}")
lcc_fuzz_write(v200_bad_date "${_bad_date}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 2050-10-00" _zero_day "${_v200_full}")
lcc_fuzz_write(v200_impossible_date_zero_day "${_zero_day}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 2050-10-10x" _date_suffix "${_v200_full}")
lcc_fuzz_write(v200_malformed_date_suffix "${_date_suffix}")
string(REPLACE "valid-to = 2050-10-10" "valid-to =  2050-10-10" _date_leading_space "${_v200_full}")
lcc_fuzz_write(v200_noncanonical_date_leading_space "${_date_leading_space}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 2050-10-10 " _date_trailing_space "${_v200_full}")
lcc_fuzz_write(v200_noncanonical_date_trailing_space "${_date_trailing_space}")
string(REPLACE "valid-from = 2020-01-01" "valid-from = 2020-01-02" _valid_from_mutation "${_v200_full}")
lcc_fuzz_write(v200_valid_from_field_mutation "${_valid_from_mutation}")
string(REPLACE "valid-to = 2050-10-10" "valid-to = 2050-10-11" _date_mutation "${_v200_full}")
lcc_fuzz_write(v200_date_field_mutation "${_date_mutation}")
string(REPLACE "extra-data = alpha" "extra-data = bravo" _extra_mutation "${_v200_full}")
lcc_fuzz_write(v200_extra_data_mutation "${_extra_mutation}")
string(REPLACE "[${LCC_FUZZ_PROJECT_NAME}]" "[FEATURE1]" _feature_mutation "${_v200}")
lcc_fuzz_write(v200_feature_section_mutation "${_feature_mutation}")
string(REPLACE "start-version = 1.2.0" "start-version = 1.2.1" _start_version_mutation "${_v200_full}")
lcc_fuzz_write(v200_start_version_field_mutation "${_start_version_mutation}")
string(REPLACE "end-version = 1.4.0" "end-version = 1.4.1" _end_version_mutation "${_v200_full}")
lcc_fuzz_write(v200_end_version_field_mutation "${_end_version_mutation}")
string(REPLACE "start-version = 1.2.0" "start-version = 1.bad" _malformed_version_bound "${_v200_full}")
lcc_fuzz_write(v200_malformed_version_bound "${_malformed_version_bound}")
string(REPLACE "client-signature = AEBC-Q0RF-Rkc=" "client-signature = AENC-REVG-R0g=" _client_sig_mutation
	"${_v200_full}")
lcc_fuzz_write(v200_client_signature_mutation "${_client_sig_mutation}")
string(REPEAT "x" 16 _max_extra_data)
string(REPEAT "x" 17 _oversized_extra_data)
lcc_fuzz_write_signed_extra_data(v200_signed_max_extra_data "${_max_extra_data}")
lcc_fuzz_write_signed_extra_data(v200_signed_empty_extra_data "")
lcc_fuzz_write_signed_extra_data(v200_signed_oversized_extra_data "${_oversized_extra_data}")
lcc_fuzz_write_signed_client_signature(v200_signed_malformed_client_signature "XXX-XXX-XXX")
lcc_fuzz_write_oversized_append(v200_oversized_file_append "${_v200}" "\n[${LCC_FUZZ_PROJECT_NAME}]\nunknown-key = value\n")
set(_oversized_license "${LCC_FUZZ_OUTPUT_DIR}/v200_oversized_file_append.lic")

set(_path_malformed "${LCC_FUZZ_OUTPUT_DIR}/path_candidate_malformed.lic")
file(WRITE "${_path_malformed}" "${_v200}\nunknown-key = value\n")
lcc_fuzz_write_raw(path_malformed_then_valid.txt "${_path_malformed};${valid_v200}")
lcc_fuzz_write_raw(path_valid_then_malformed.txt "${valid_v200};${_path_malformed}")
lcc_fuzz_write_raw(path_oversized_file.txt "${_oversized_license}")

lcc_fuzz_write(v201_unknown_key "${_v201}\nunknown-key = value\n")
lcc_fuzz_replace_line("${_v201}" "sig-alg = " "sig-alg = rsa-sha256" _v201_bad_algorithm)
lcc_fuzz_write(v201_bad_algorithm_alias "${_v201_bad_algorithm}")
lcc_fuzz_replace_line("${_v201}" "key-id = " "key-id = sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	_v201_unknown_key_id)
lcc_fuzz_write(v201_unknown_key_id "${_v201_unknown_key_id}")
string(REPLACE "extra-data = alpha" "extra-data = bravo" _v201_extra_mutation "${_v201_full}")
lcc_fuzz_write(v201_extra_data_mutation "${_v201_extra_mutation}")
