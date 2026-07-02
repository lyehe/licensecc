#ifndef LICENSECC_ACTIVATION_REQUEST_HPP_
#define LICENSECC_ACTIVATION_REQUEST_HPP_

#include <cstdint>
#include <string>

namespace license {
namespace activation {

// Offline (air-gapped) activation request codec.
//
// An air-gapped machine cannot reach the online verifier, but it CAN print a short,
// copy-pasteable string describing itself. An operator carries that string to a connected
// machine, issues a hardware-bound v201 `.lic` for the reported hardware id (using the
// existing license generator + project private key), and carries the `.lic` back. The
// machine installs it and the EXISTING offline verifier validates it -- there is no new
// crypto path: the request is UNSIGNED (the machine holds no signing key) and its integrity
// comes entirely from the signed, hardware-bound `.lic` the operator issues in response.
//
// Envelope: `lccareq1.<base64(payload)>` where payload is canonical `key=value\n` lines:
//   project=<name>\nfeature=<name>\nhwid=<XXXX-XXXX-XXXX=>\nnonce=<uint>\nissued-at=<uint>\n
// The framing tolerates '=' inside a value (the canonical hwid ends in base64 padding) by
// splitting each line on its FIRST '='; only line breaks are rejected.

struct ActivationRequestFields {
	std::string project;
	std::string feature;
	std::string hwid;  // canonical PC signature (e.g. AABQ-6/bO-ATs=) exactly as identify_pc() prints it
	uint64_t nonce = 0;
	uint64_t issued_at = 0;
};

// Envelope prefix (without the trailing dot). Version 1 of the activation-request format.
extern const char kActivationRequestPrefix[];

// Build the canonical activation-request string. Returns an empty string if any field value
// contains a line break (which would break the `key=value\n` framing).
std::string build_activation_request(const ActivationRequestFields& fields);

// Parse an activation-request string. Returns false (and sets `error`) on a wrong prefix,
// non-canonical outer base64, a truncated/mis-ordered/trailing-garbage payload, or a
// non-numeric nonce/issued-at.
bool parse_activation_request(const std::string& token, ActivationRequestFields& out, std::string& error);

}  // namespace activation
}  // namespace license

#endif
