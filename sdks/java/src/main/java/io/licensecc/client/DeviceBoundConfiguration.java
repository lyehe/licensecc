package io.licensecc.client;

import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;

/** Immutable application configuration. The native runtime owns policy validation. */
public final class DeviceBoundConfiguration {
    private static final int[] CAPACITIES = {129, 1025, 1025, 1025, 1025, 1025, 128, 16, 128, 321, 256};
    private final byte[][] fields;
    private final List<TrustedSigner> signers;

    /** A copied, application-pinned RSA-3072 public DER SPKI, not a private key. */
    public static final class TrustedSigner {
        private final byte[] spki;
        private final boolean retired;
        public TrustedSigner(byte[] spki, boolean retired) {
            Objects.requireNonNull(spki, "spki");
            if (spki.length < 1 || spki.length > 512) throw new IllegalArgumentException("Expected 1..512 SPKI bytes");
            this.spki = spki.clone();
            this.retired = retired;
        }
    }

    public DeviceBoundConfiguration(String applicationId, String endpointOrigin, String portalAuthorizationUrl,
            String issuer, String leaseAudience, String proofAudience, String project, String feature,
            String clientId, String deviceLabel, String callbackPath, List<TrustedSigner> signers) {
        String[] values = {applicationId, endpointOrigin, portalAuthorizationUrl, issuer, leaseAudience,
            proofAudience, project, feature, clientId, deviceLabel, callbackPath};
        fields = new byte[values.length][];
        for (int i = 0; i < values.length; i++) {
            String value = Objects.requireNonNull(values[i], "configuration text");
            if (value.length() >= CAPACITIES[i] || value.indexOf('\0') >= 0) throw new IllegalArgumentException("Oversized configuration text or NUL");
            try {
                var encoded = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value));
                if (encoded.remaining() >= CAPACITIES[i]) throw new IllegalArgumentException("Configuration text exceeds UTF-8 field capacity");
                fields[i] = new byte[encoded.remaining()];
                encoded.get(fields[i]);
            } catch (CharacterCodingException error) {
                throw new IllegalArgumentException("Invalid Unicode configuration text", error);
            }
        }
        this.signers = List.copyOf(signers);
        if (this.signers.isEmpty() || this.signers.size() > 8) throw new IllegalArgumentException("Expected 1..8 trusted signers");
    }

    record Encoded(byte[][] fields, byte[][] keys, boolean[] retired) { }
    Encoded encode() {
        byte[][] texts = new byte[fields.length][];
        for (int i = 0; i < texts.length; i++) texts[i] = fields[i].clone();
        byte[][] keys = new byte[signers.size()][];
        boolean[] retired = new boolean[keys.length];
        for (int i = 0; i < keys.length; i++) {
            keys[i] = signers.get(i).spki.clone();
            retired[i] = signers.get(i).retired;
        }
        return new Encoded(texts, keys, retired);
    }
}
