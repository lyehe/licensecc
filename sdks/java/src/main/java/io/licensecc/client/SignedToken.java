package io.licensecc.client;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Signature;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class SignedToken {
    static final String ALGORITHM = "rsa-pkcs1-sha256";
    static final BigInteger MAX_UINT64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);

    private SignedToken() {}

    record Envelope(byte[] payloadBytes, byte[] signatureBytes, String payloadText) {}

    static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        private final RejectionCode code;

        Failure(RejectionCode code, String message) {
            super(message);
            this.code = code;
        }

        RejectionCode code() {
            return code;
        }
    }

    static Envelope split(String token, String expectedPrefix) throws Failure {
        if (token == null) {
            throw fail(RejectionCode.ENVELOPE_MALFORMED, "token is required");
        }
        int first = token.indexOf('.');
        int second = first < 0 ? -1 : token.indexOf('.', first + 1);
        if (first < 0 || second < 0 || token.indexOf('.', second + 1) >= 0) {
            throw fail(RejectionCode.ENVELOPE_MALFORMED, "envelope malformed");
        }
        if (!token.substring(0, first).equals(expectedPrefix)) {
            throw fail(RejectionCode.PREFIX_MISMATCH, "prefix mismatch");
        }
        byte[] payload = decodeCanonicalBase64(token.substring(first + 1, second));
        byte[] signature = decodeCanonicalBase64(token.substring(second + 1));
        if (payload.length == 0 || signature.length == 0) {
            throw fail(RejectionCode.EMPTY_PAYLOAD_OR_SIGNATURE, "decoded payload or signature is empty");
        }
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(payload)).toString();
        } catch (CharacterCodingException exception) {
            throw fail(RejectionCode.PAYLOAD_NOT_CANONICAL, "payload is not valid UTF-8");
        }
        return new Envelope(payload, signature, text);
    }

    static void verifySignature(Envelope envelope, List<TrustedPublicKey> trustedKeys, int minBits,
                                Set<String> retiredKeyIds) throws Failure {
        String algorithm = extractPreverifyField(envelope.payloadText(), "alg");
        String keyId = extractPreverifyField(envelope.payloadText(), "key-id");
        if (algorithm == null || keyId == null) {
            throw fail(RejectionCode.MISSING_SIGNATURE_METADATA, "missing signature metadata");
        }
        if (!ALGORITHM.equals(algorithm)) {
            throw fail(RejectionCode.METADATA_MISMATCH, "unsupported signature algorithm");
        }
        if (retiredKeyIds != null && retiredKeyIds.contains(keyId)) {
            throw fail(RejectionCode.RETIRED_KEY_ID, "key id is retired");
        }
        TrustedPublicKey selected = null;
        if (trustedKeys != null) {
            for (TrustedPublicKey candidate : trustedKeys) {
                if (candidate != null && candidate.keyId().equals(keyId)) {
                    selected = candidate;
                    break;
                }
            }
        }
        if (selected == null) {
            throw fail(RejectionCode.UNKNOWN_KEY_ID, "no trusted key for key id");
        }
        if (minBits > 0 && selected.bits() < minBits) {
            throw fail(RejectionCode.KEY_TOO_WEAK, "trusted key is below the minimum bit size");
        }
        try {
            Signature verifier = Signature.getInstance("SHA256withRSA");
            verifier.initVerify(selected.publicKey());
            verifier.update(envelope.payloadBytes());
            if (!verifier.verify(envelope.signatureBytes())) {
                throw fail(RejectionCode.SIGNATURE_INVALID, "signature verification failed");
            }
        } catch (Failure failure) {
            throw failure;
        } catch (Exception exception) {
            throw fail(RejectionCode.SIGNATURE_INVALID, "signature verification failed");
        }
    }

    static Map<String, String> parseFields(String payload, List<String> fields, boolean validateValues) throws Failure {
        if (payload.isEmpty() || payload.charAt(payload.length() - 1) != '\n' || payload.indexOf('\r') >= 0) {
            throw fail(RejectionCode.PAYLOAD_NOT_CANONICAL, "payload is not canonical");
        }
        Map<String, String> values = new LinkedHashMap<>();
        int offset = 0;
        for (String field : fields) {
            int newline = payload.indexOf('\n', offset);
            if (newline < 0) {
                throw fail(RejectionCode.FIELD_MISSING, "missing field " + field);
            }
            String line = payload.substring(offset, newline);
            String prefix = field + "=";
            if (!line.startsWith(prefix)) {
                throw fail(RejectionCode.FIELD_UNEXPECTED, "expected field " + field);
            }
            String value = line.substring(prefix.length());
            if (validateValues && (value.indexOf('=') >= 0 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)) {
                throw fail(RejectionCode.INVALID_FIELD_VALUE, "invalid value for " + field);
            }
            values.put(field, value);
            offset = newline + 1;
        }
        if (offset != payload.length()) {
            throw fail(RejectionCode.TRAILING_FIELDS, "unknown trailing fields");
        }
        return values;
    }

    static BigInteger parseUint64(String value) throws Failure {
        if (value == null || value.isEmpty()) {
            throw fail(RejectionCode.INTEGER_FIELD_MALFORMED, "integer field malformed");
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < '0' || character > '9') {
                throw fail(RejectionCode.INTEGER_FIELD_MALFORMED, "integer field malformed");
            }
        }
        BigInteger parsed = new BigInteger(value);
        if (parsed.compareTo(MAX_UINT64) > 0) {
            throw fail(RejectionCode.INTEGER_FIELD_MALFORMED, "integer field malformed");
        }
        return parsed;
    }

    static boolean isAsciiHex(String value, int expectedLength) {
        if (value == null || value.length() != expectedLength) {
            return false;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean digit = character >= '0' && character <= '9';
            boolean lower = character >= 'a' && character <= 'f';
            boolean upper = character >= 'A' && character <= 'F';
            if (!digit && !lower && !upper) {
                return false;
            }
        }
        return true;
    }

    static String sha256(byte[] bytes) {
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private static byte[] decodeCanonicalBase64(String encoded) throws Failure {
        try {
            byte[] decoded = Base64.getDecoder().decode(encoded);
            if (!Base64.getEncoder().encodeToString(decoded).equals(encoded)) {
                throw fail(RejectionCode.BASE64_NOT_CANONICAL, "base64 is not canonical");
            }
            return decoded;
        } catch (IllegalArgumentException exception) {
            throw fail(RejectionCode.BASE64_NOT_CANONICAL, "base64 is not canonical");
        }
    }

    private static String extractPreverifyField(String payload, String key) {
        String prefix = key + "=";
        int offset = 0;
        while (offset < payload.length()) {
            int newline = payload.indexOf('\n', offset);
            if (newline < 0) {
                return null;
            }
            String line = payload.substring(offset, newline);
            if (line.startsWith(prefix)) {
                String value = line.substring(prefix.length());
                return value.isEmpty() ? null : value;
            }
            offset = newline + 1;
        }
        return null;
    }

    private static Failure fail(RejectionCode code, String message) {
        return new Failure(code, message);
    }
}
