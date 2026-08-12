package io.licensecc.client;

import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Objects;

/** A trusted PKCS#1 {@code RSAPublicKey} DER value addressed by its canonical SHA-256 key id. */
public final class TrustedPublicKey {
    private final byte[] pkcs1Der;
    private final String keyId;
    private final PublicKey publicKey;
    private final int bits;

    public TrustedPublicKey(byte[] pkcs1Der) {
        this(pkcs1Der, "");
    }

    public TrustedPublicKey(byte[] pkcs1Der, String keyId) {
        Objects.requireNonNull(pkcs1Der, "pkcs1Der");
        this.pkcs1Der = pkcs1Der.clone();
        String derived = keyIdFromPkcs1Der(this.pkcs1Der);
        if (keyId != null && !keyId.isEmpty() && !derived.equals(keyId)) {
            throw new IllegalArgumentException("keyId does not match the PKCS#1 DER-derived id");
        }
        this.keyId = derived;
        try {
            DerReader reader = new DerReader(this.pkcs1Der);
            DerReader sequence = reader.readSequence();
            BigInteger modulus = sequence.readPositiveInteger();
            BigInteger exponent = sequence.readPositiveInteger();
            sequence.requireEnd();
            reader.requireEnd();
            if (modulus.signum() <= 0 || exponent.signum() <= 0) {
                throw new IllegalArgumentException("RSA modulus and exponent must be positive");
            }
            this.bits = modulus.bitLength();
            this.publicKey = KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(modulus, exponent));
        } catch (IllegalArgumentException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new IllegalArgumentException("invalid PKCS#1 RSA public key", exception);
        }
    }

    public static TrustedPublicKey fromHex(String hex) {
        Objects.requireNonNull(hex, "hex");
        return new TrustedPublicKey(HexFormat.of().parseHex(hex.strip()));
    }

    public static String keyIdFromPkcs1Der(byte[] pkcs1Der) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(pkcs1Der);
            return "sha256:" + HexFormat.of().formatHex(digest);
        } catch (Exception exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    public byte[] pkcs1Der() {
        return pkcs1Der.clone();
    }

    public String keyId() {
        return keyId;
    }

    public PublicKey publicKey() {
        return publicKey;
    }

    public int bits() {
        return bits;
    }

    private static final class DerReader {
        private final byte[] bytes;
        private int offset;

        private DerReader(byte[] bytes) {
            this.bytes = bytes;
        }

        private DerReader readSequence() {
            requireTag(0x30);
            int length = readLength();
            requireAvailable(length);
            byte[] content = Arrays.copyOfRange(bytes, offset, offset + length);
            offset += length;
            return new DerReader(content);
        }

        private BigInteger readPositiveInteger() {
            requireTag(0x02);
            int length = readLength();
            if (length == 0) {
                throw new IllegalArgumentException("empty DER INTEGER");
            }
            requireAvailable(length);
            byte first = bytes[offset];
            if ((first & 0x80) != 0) {
                throw new IllegalArgumentException("negative DER INTEGER");
            }
            if (length > 1 && first == 0 && (bytes[offset + 1] & 0x80) == 0) {
                throw new IllegalArgumentException("non-minimal DER INTEGER");
            }
            byte[] integer = Arrays.copyOfRange(bytes, offset, offset + length);
            offset += length;
            return new BigInteger(1, integer);
        }

        private int readLength() {
            requireAvailable(1);
            int first = bytes[offset++] & 0xff;
            if ((first & 0x80) == 0) {
                return first;
            }
            int octets = first & 0x7f;
            if (octets == 0 || octets > 4) {
                throw new IllegalArgumentException("invalid DER length");
            }
            requireAvailable(octets);
            if (bytes[offset] == 0) {
                throw new IllegalArgumentException("non-minimal DER length");
            }
            long length = 0;
            for (int index = 0; index < octets; index++) {
                length = (length << 8) | (bytes[offset++] & 0xffL);
            }
            if (length <= 0x7f || length > Integer.MAX_VALUE) {
                throw new IllegalArgumentException("invalid DER length");
            }
            return (int) length;
        }

        private void requireTag(int tag) {
            requireAvailable(1);
            if ((bytes[offset++] & 0xff) != tag) {
                throw new IllegalArgumentException("unexpected DER tag");
            }
        }

        private void requireAvailable(int count) {
            if (count < 0 || offset > bytes.length - count) {
                throw new IllegalArgumentException("truncated DER");
            }
        }

        private void requireEnd() {
            if (offset != bytes.length) {
                throw new IllegalArgumentException("trailing DER bytes");
            }
        }
    }
}
