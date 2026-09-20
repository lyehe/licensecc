package io.licensecc.client;

import java.lang.ref.Cleaner;
import java.lang.ref.Reference;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.locks.ReentrantLock;
import io.licensecc.client.DeviceBoundClient.Result;
import io.licensecc.client.DeviceBoundClient.ProviderResult;
import io.licensecc.client.DeviceBoundClient.CheckpointResult;

/** One native owner per feature job. Blocking calls belong on an application worker thread. */
public final class FeatureSession implements AutoCloseable {
    public enum State { UNKNOWN, READY, STARTING, ACTIVE, NEEDS_ONLINE, DENIED, FAILED, STOPPED }
    /** Advisory metadata; only authorize(requiredFeature) OK permits the next work unit. */
    public record Outcome(Result code, State state, ProviderResult providerResult, CheckpointResult checkpointResult,
                          boolean renewalDue, BigInteger effectiveTime, BigInteger renewAfter, BigInteger expiresAt) { }
    private static final Cleaner CLEANER = Cleaner.create();
    private static final Outcome BUSY = new Outcome(Result.BUSY, State.UNKNOWN, ProviderResult.OK,
            CheckpointResult.NOT_ATTEMPTED, false, BigInteger.ZERO, BigInteger.ZERO, BigInteger.ZERO);
    private static final class Owner implements Runnable {
        final FeatureSessionApi api;
        final ReentrantLock gate = new ReentrantLock();
        long handle;
        Owner(FeatureSessionApi api) { this.api = api; }
        boolean enter() { return !gate.isHeldByCurrentThread() && gate.tryLock(); }
        long requireOpen() {
            if (handle == 0) throw new IllegalStateException("Feature session is closed");
            return handle;
        }
        @Override public void run() {
            if (gate.isHeldByCurrentThread()) throw new IllegalStateException("Cannot close from an active native call");
            gate.lock();
            try {
                long owned = handle; handle = 0;
                if (owned != 0) api.close(owned);
            } finally { gate.unlock(); }
        }
    }
    private final Owner owner;
    private final Cleaner.Cleanable cleanable;
    FeatureSession(FeatureSessionApi api) {
        owner = new Owner(api);
        cleanable = CLEANER.register(this, owner);
    }
    void adopt(long handle) { owner.handle = handle; }
    boolean hasHandle() { return owner.handle != 0; }
    public Outcome start() { return invoke(0, null); }
    public Outcome renew() { return invoke(1, null); }
    public Outcome stop() { return invoke(2, null); }
    public Outcome saveCheckpoint() { return invoke(3, null); }
    public Outcome authorize(String requiredFeature) {
        if (requiredFeature == null || !requiredFeature.matches("[A-Za-z0-9_.:-]{1,15}"))
            throw new IllegalArgumentException("Expected a 1..15-character feature ID");
        return invoke(4, requiredFeature.getBytes(StandardCharsets.US_ASCII));
    }
    private Outcome invoke(int operation, byte[] feature) {
        if (!owner.enter()) return BUSY;
        try {
            long[] raw = newOutcome(0);
            owner.api.invoke(owner.requireOpen(), operation, feature, raw);
            return decode(raw, 0);
        } finally { owner.gate.unlock(); Reference.reachabilityFence(this); }
    }
    static long[] newOutcome(int offset) {
        long[] raw = new long[offset + 8];
        Arrays.fill(raw, offset, raw.length, -1);
        return raw;
    }
    static Outcome decode(long[] raw, int offset) {
        if (raw.length != offset + 8 || raw[offset + 1] < 0 || raw[offset + 1] > 7 ||
                (raw[offset + 2] != 255 && (raw[offset + 2] < 0 || raw[offset + 2] > 14)) ||
                raw[offset + 3] < 0 || raw[offset + 3] > 11 || raw[offset + 4] < 0 || raw[offset + 4] > 1)
            throw new IllegalStateException("Invalid native feature-session outcome");
        return new Outcome(DeviceBoundClient.decodeCode(raw[offset]), State.values()[(int) raw[offset + 1]],
                raw[offset + 2] == 255 ? ProviderResult.INTERNAL_ERROR : ProviderResult.values()[(int) raw[offset + 2]],
                CheckpointResult.values()[(int) raw[offset + 3]], raw[offset + 4] == 1,
                unsigned(raw[offset + 5]), unsigned(raw[offset + 6]), unsigned(raw[offset + 7]));
    }
    private static BigInteger unsigned(long value) { return new BigInteger(Long.toUnsignedString(value)); }
    /** Wait for admitted calls and close once. Recover pending persistence explicitly before close. */
    @Override public void close() {
        try { owner.run(); cleanable.clean(); }
        finally { Reference.reachabilityFence(this); }
    }
}
