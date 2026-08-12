package io.licensecc.client;

/** Stable fail-closed token rejection codes shared with the C++, Python, and .NET verifiers. */
public enum RejectionCode {
    ENVELOPE_MALFORMED("envelope_malformed"),
    PREFIX_MISMATCH("prefix_mismatch"),
    BASE64_NOT_CANONICAL("base64_not_canonical"),
    EMPTY_PAYLOAD_OR_SIGNATURE("empty_payload_or_signature"),
    UNKNOWN_KEY_ID("unknown_key_id"),
    RETIRED_KEY_ID("retired_key_id"),
    SIGNATURE_INVALID("signature_invalid"),
    KEY_TOO_WEAK("key_too_weak"),
    MISSING_SIGNATURE_METADATA("missing_signature_metadata"),
    PAYLOAD_NOT_CANONICAL("payload_not_canonical"),
    FIELD_MISSING("field_missing"),
    FIELD_UNEXPECTED("field_unexpected"),
    TRAILING_FIELDS("trailing_fields"),
    INVALID_FIELD_VALUE("invalid_field_value"),
    INTEGER_FIELD_MALFORMED("integer_field_malformed"),
    METADATA_MISMATCH("metadata_mismatch"),
    STATUS_UNSUPPORTED("status_unsupported"),
    STATUS_DENIED("status_denied"),
    BINDING_MISMATCH("binding_mismatch"),
    HEX_FIELD_MALFORMED("hex_field_malformed"),
    TIME_WINDOW_MALFORMED("time_window_malformed"),
    CACHE_WINDOW_EXCEEDED("cache_window_exceeded"),
    EXPIRED("expired"),
    REVOCATION_BELOW_FLOOR("revocation_below_floor"),
    ROLLBACK_BELOW_FLOOR("rollback_below_floor"),
    CONFIG_HASH_MISMATCH("config_hash_mismatch"),
    NO_EXPIRY("no_expiry");

    private final String wireValue;

    RejectionCode(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }
}
