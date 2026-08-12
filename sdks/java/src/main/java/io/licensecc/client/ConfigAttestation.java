package io.licensecc.client;

import java.math.BigInteger;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Fail-closed verification of canonical {@code lcccfg1} configuration attestations. */
public final class ConfigAttestation {
    private static final String PREFIX = "lcccfg1";
    private static final String PURPOSE = "licensecc-config-attestation";
    private static final String VERSION = "1";
    private static final List<String> FIELDS = List.of(
            "purpose", "version", "alg", "key-id", "project", "feature",
            "license-fingerprint", "device-hash", "config-id", "config-seq",
            "config-hash", "issued-at", "expires-at");

    private ConfigAttestation() {}

    public record Expected(byte[] configBytes, String project, String feature,
                           String licenseFingerprint, String deviceHash,
                           BigInteger minConfigSequence, BigInteger now) {
        public Expected {
            configBytes = configBytes == null ? null : configBytes.clone();
            deviceHash = deviceHash == null ? "" : deviceHash;
            minConfigSequence = minConfigSequence == null ? BigInteger.ZERO : minConfigSequence;
        }

        @Override
        public byte[] configBytes() {
            return configBytes == null ? null : configBytes.clone();
        }
    }

    public record Claims(String purpose, String version, String algorithm, String keyId,
                         String project, String feature, String licenseFingerprint,
                         String deviceHash, String configId, BigInteger configSequence,
                         String configHash, BigInteger issuedAt, BigInteger expiresAt) {}

    public static VerificationResult<Claims> verify(String token, Expected expected,
                                                     List<TrustedPublicKey> trustedKeys,
                                                     Set<String> retiredKeyIds) {
        if (expected == null || expected.configBytes() == null) {
            return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "expected config bytes are required");
        }
        try {
            SignedToken.Envelope envelope = SignedToken.split(token, PREFIX);
            SignedToken.verifySignature(envelope, trustedKeys, 3072, retiredKeyIds);
            Map<String, String> values = SignedToken.parseFields(envelope.payloadText(), FIELDS, false);
            Claims claims = new Claims(values.get("purpose"), values.get("version"), values.get("alg"),
                    values.get("key-id"), values.get("project"), values.get("feature"),
                    values.get("license-fingerprint"), values.get("device-hash"), values.get("config-id"),
                    SignedToken.parseUint64(values.get("config-seq")), values.get("config-hash"),
                    SignedToken.parseUint64(values.get("issued-at")),
                    SignedToken.parseUint64(values.get("expires-at")));
            return validate(claims, expected);
        } catch (SignedToken.Failure failure) {
            return VerificationResult.reject(failure.code(), failure.getMessage());
        } catch (RuntimeException failure) {
            return VerificationResult.reject(RejectionCode.PAYLOAD_NOT_CANONICAL, "token verification failed");
        }
    }

    public static VerificationResult<Claims> verify(String token, Expected expected,
                                                     List<TrustedPublicKey> trustedKeys) {
        return verify(token, expected, trustedKeys, Set.of());
    }

    private static VerificationResult<Claims> validate(Claims claims, Expected expected) {
        if (!PURPOSE.equals(claims.purpose()) || !VERSION.equals(claims.version())
                || !SignedToken.ALGORITHM.equals(claims.algorithm())) {
            return VerificationResult.reject(RejectionCode.METADATA_MISMATCH, "metadata mismatch");
        }
        if (!equal(claims.project(), expected.project()) || !equal(claims.feature(), expected.feature())
                || !equal(claims.licenseFingerprint(), expected.licenseFingerprint())
                || !equal(claims.deviceHash(), expected.deviceHash())) {
            return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "request binding mismatch");
        }
        if (!SignedToken.sha256(expected.configBytes()).equals(claims.configHash())) {
            return VerificationResult.reject(RejectionCode.CONFIG_HASH_MISMATCH, "hash does not match config bytes");
        }
        BigInteger now = expected.now() == null ? BigInteger.valueOf(Instant.now().getEpochSecond()) : expected.now();
        if (claims.issuedAt().compareTo(now.add(BigInteger.valueOf(300))) > 0) {
            return VerificationResult.reject(RejectionCode.EXPIRED, "issued in the future");
        }
        if (claims.expiresAt().signum() == 0) {
            return VerificationResult.reject(RejectionCode.NO_EXPIRY, "config token has no expiry");
        }
        if (claims.expiresAt().compareTo(claims.issuedAt()) < 0 || claims.expiresAt().compareTo(now) < 0) {
            return VerificationResult.reject(RejectionCode.EXPIRED, "expired");
        }
        if (claims.configSequence().compareTo(expected.minConfigSequence()) < 0) {
            return VerificationResult.reject(RejectionCode.ROLLBACK_BELOW_FLOOR, "sequence below the minimum");
        }
        return VerificationResult.accept(claims, false);
    }

    private static boolean equal(String left, String right) {
        return left != null && left.equals(right);
    }
}
