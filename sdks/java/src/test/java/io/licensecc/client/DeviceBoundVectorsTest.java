package io.licensecc.client;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Independent test-only wire/crypto oracle, not a production authorization verifier. */
final class DeviceBoundVectorsTest {
    private static final BigInteger ORDER = new BigInteger(
            "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);

    private DeviceBoundVectorsTest() {}

    static void run(Path root) throws Exception {
        Path directory = root.resolve("test/vectors/device_bound/v1");
        Map<?, ?> renewal = read(directory, "protocol.json");
        proof(renewal, "renew");
        proof(read(directory, "exchange.json"), "exchange");
        lease(renewal);
        comparison(read(directory, "enrollment_comparison.json"));
        System.out.println("Device-bound Java vectors passed (test-only oracle)");
    }

    private static void proof(Map<?, ?> vector, String purpose) throws Exception {
        Map<?, ?> body = (Map<?, ?>) vector.get("body");
        Map<?, ?> proof = (Map<?, ?>) vector.get("proof");
        equal(value(proof, "operation_id"), value(body, "operation_id"), "proof operation binding");
        equal(value(proof, "method"), "POST", "proof method");
        equal(value(proof, "path"), purpose.equals("renew") ? "/v2/device-leases/renew"
                : "/v2/device-authorizations/exchange", "proof path");
        // All string values are encoded before JSON serialization: no JSON escaping ambiguity.
        String semantic = purpose.equals("renew")
                ? "[\"" + encoded(body, "binding_id") + "\"," + body.get("generation")
                    + ",\"" + encoded(body, "operation_id") + "\"]"
                : List.of("attempt_handle", "code", "code_verifier", "redirect_uri", "operation_id")
                    .stream().map(field -> "\"" + encoded(body, field) + "\"")
                    .collect(Collectors.joining(",", "[", "]"));
        equal(hash(bytes(semantic)), value(proof, "body_sha256"), "semantic body hash");
        byte[] operation = bytes("lcc-device-operation-v1\n" + b64(bytes(purpose)) + "\n"
                + encoded(proof, "key_id") + "\n" + b64(bytes(semantic)) + "\n");
        equal(hex(operation), value(vector, "operation_digest_input_hex"), "operation bytes");
        equal(hash(operation), value(vector, "operation_digest"), "operation digest");
        StringBuilder transcript = new StringBuilder("lcc-device-proof-v2\n");
        for (String field : List.of("audience", "method", "path", "key_id", "operation_id",
                "body_sha256", "challenge_id", "nonce")) {
            transcript.append(encoded(proof, field)).append('\n');
        }
        transcript.append(proof.get("expires_at")).append('\n');
        byte[] input = bytes(transcript.toString());
        equal(hex(input), value(vector, "proof_input_hex"), "proof bytes");
        byte[] der = decode(value(vector, "device_spki"));
        equal("sha256:" + hash(der), value(proof, "key_id"), "device key id");
        PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
        check(der.length == 91 && hex(Arrays.copyOf(der, 27)).equals(
                "3059301306072a8648ce3d020106082a8648ce3d03010703420004"), "canonical P-256 SPKI profile");
        check(Arrays.equals(der, key.getEncoded()), "EC SPKI roundtrip");
        byte[] signature = decode(value(vector, "proof_signature"));
        check(lowS(signature), "canonical low-S proof");
        check(verify("SHA256withECDSAinP1363Format", key, input, signature), "proof signature");
        byte[] changed = input.clone();
        changed[0] ^= 1;
        check(!verify("SHA256withECDSAinP1363Format", key, changed, signature), "changed domain rejects");
        byte[] high = signature.clone();
        byte[] highS = ORDER.subtract(new BigInteger(1, Arrays.copyOfRange(signature, 32, 64))).toByteArray();
        System.arraycopy(highS, highS.length - 32, high, 32, 32);
        check(verify("SHA256withECDSAinP1363Format", key, input, high), "high-S is mathematically valid");
        check(!lowS(high), "protocol rejects malleable high-S proof");
        check(!lowS(new byte[64]) && !lowS(new byte[63]), "zero and truncated proofs reject");
        check(!lowS(scalars(BigInteger.ZERO, BigInteger.ONE)), "zero r rejects");
        check(!lowS(scalars(ORDER, BigInteger.ONE)), "out-of-range r rejects");
        check(!lowS(scalars(BigInteger.ONE, BigInteger.ZERO)), "zero s rejects");
        check(lowS(scalars(BigInteger.ONE, ORDER.shiftRight(1))), "low-S boundary inclusive");
        check(!lowS(scalars(BigInteger.ONE, ORDER.shiftRight(1).add(BigInteger.ONE))), "high-S boundary rejects");
    }

    private static void lease(Map<?, ?> vector) throws Exception {
        Map<?, ?> claims = (Map<?, ?>) vector.get("claims");
        Map<?, ?> body = (Map<?, ?>) vector.get("body");
        Map<?, ?> proof = (Map<?, ?>) vector.get("proof");
        equal(claims.get("version").toString(), "1", "lease version");
        equal(value(claims, "purpose"), "device-lease", "lease purpose");
        equal(value(claims, "binding-id"), value(body, "binding_id"), "lease binding");
        equal(claims.get("generation").toString(), body.get("generation").toString(), "lease generation");
        equal(value(claims, "operation-id"), value(body, "operation_id"), "lease operation");
        equal(value(claims, "device-key-id"), value(proof, "key_id"), "lease device key");
        StringBuilder payload = new StringBuilder();
        for (String field : List.of("version", "purpose", "key-id", "issuer", "audience", "project",
                "feature", "license-fingerprint", "binding-id", "device-key-id", "generation",
                "revocation-seq", "lease-id", "operation-id", "issued-at", "renew-after", "expires-at")) {
            Object item = claims.get(field);
            payload.append(field).append('=').append(item instanceof String
                    ? b64(bytes((String) item)) : item).append('\n');
        }
        equal(hex(bytes(payload.toString())), value(vector, "lease_payload_hex"), "lease payload");
        byte[] input = bytes("lccdl1." + payload);
        equal(hex(input), value(vector, "lease_signing_input_hex"), "lease signing bytes");
        String[] token = value(vector, "token").split("\\.", -1);
        check(token.length == 3 && token[0].equals("lccdl1"), "lease envelope");
        check(Arrays.equals(decode(token[1]), bytes(payload.toString())), "envelope payload");
        byte[] der = decode(value(vector, "lease_signer_spki"));
        equal("sha256:" + hash(der), value(claims, "key-id"), "lease signer id");
        RSAPublicKey key = (RSAPublicKey) KeyFactory.getInstance("RSA")
                .generatePublic(new X509EncodedKeySpec(der));
        check(Arrays.equals(der, key.getEncoded()), "RSA SPKI canonical roundtrip");
        check(der.length == 422 && key.getPublicExponent().equals(BigInteger.valueOf(65537)), "RSA SPKI profile");
        byte[] signature = decode(token[2]);
        check(key.getModulus().bitLength() == 3072 && signature.length == 384, "RSA3072 sizes");
        check(verify("SHA256withRSA", key, input, signature), "lease signature");
        check(!verify("SHA256withRSA", key, bytes("lccoa1." + payload), signature), "wrong envelope rejects");
        input[input.length - 2] ^= 1;
        check(!verify("SHA256withRSA", key, input, signature), "changed expiry rejects");
    }

    private static void comparison(Map<?, ?> vector) throws Exception {
        Map<?, ?> values = (Map<?, ?>) vector.get("input");
        StringBuilder input = new StringBuilder("lcc-device-enrollment-comparison-v1\n");
        for (String field : List.of("attempt_handle", "client_id", "project", "key_id",
                "redirect_uri", "state", "code_challenge")) input.append(encoded(values, field)).append('\n');
        equal(hex(bytes(input.toString())), value(vector, "input_hex"), "comparison bytes");
        String digest = hash(bytes(input.toString()));
        equal(digest, value(vector, "sha256_hex"), "comparison hash");
        String display = digest.substring(0, 12).toUpperCase(java.util.Locale.ROOT);
        equal(display.substring(0, 4) + "-" + display.substring(4, 8) + "-" + display.substring(8),
                value(vector, "comparison_code"), "comparison display");
    }

    private static boolean lowS(byte[] signature) {
        if (signature.length != 64) return false;
        BigInteger r = new BigInteger(1, Arrays.copyOfRange(signature, 0, 32));
        BigInteger s = new BigInteger(1, Arrays.copyOfRange(signature, 32, 64));
        return r.signum() > 0 && r.compareTo(ORDER) < 0 && s.signum() > 0
                && s.compareTo(ORDER.shiftRight(1)) <= 0;
    }

    private static byte[] scalars(BigInteger r, BigInteger s) {
        byte[] result = new byte[64];
        byte[] first = r.toByteArray(), second = s.toByteArray();
        int firstSize = Math.min(32, first.length), secondSize = Math.min(32, second.length);
        System.arraycopy(first, first.length - firstSize, result, 32 - firstSize, firstSize);
        System.arraycopy(second, second.length - secondSize, result, 64 - secondSize, secondSize);
        return result;
    }

    private static boolean verify(String algorithm, PublicKey key, byte[] input, byte[] signed) throws Exception {
        Signature verifier = Signature.getInstance(algorithm);
        verifier.initVerify(key);
        verifier.update(input);
        return verifier.verify(signed);
    }

    private static Map<?, ?> read(Path directory, String name) throws Exception {
        return (Map<?, ?>) Json.parse(Files.readString(directory.resolve(name), StandardCharsets.UTF_8));
    }
    private static String value(Map<?, ?> map, String field) { return (String) map.get(field); }
    private static String encoded(Map<?, ?> map, String field) { return b64(bytes(value(map, field))); }
    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static String b64(byte[] value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    private static byte[] decode(String value) {
        byte[] result = Base64.getUrlDecoder().decode(value);
        equal(b64(result), value, "canonical base64url");
        return result;
    }
    private static String hex(byte[] value) { return HexFormat.of().formatHex(value); }
    private static String hash(byte[] value) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(value)); }
    private static void equal(String actual, String expected, String label) { check(actual.equals(expected), label); }
    private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
