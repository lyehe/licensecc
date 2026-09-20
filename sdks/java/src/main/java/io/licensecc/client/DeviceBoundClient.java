package io.licensecc.client;

import java.lang.ref.Cleaner;
import java.lang.ref.Reference;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.locks.ReentrantLock;
import java.util.Arrays;

/** Opaque native owner. Calls block: run on an application worker thread. Only authorize OK permits work. */
public final class DeviceBoundClient implements AutoCloseable {
    public enum Result {
        OK, INVALID_ARGUMENT, UNSUPPORTED_VERSION, UNSUPPORTED_PLATFORM, BUSY, INVALID_STATE,
        RETRY, CONFLICT, DENIED, EXPIRED, WAITING, CALLBACK_REJECTED, CALLBACK_RECEIVED,
        ENROLLMENT_REQUIRED, ONLINE_REQUIRED, RESUME_REQUIRED, INVALID_RESPONSE, PROVIDER_ERROR,
        STORAGE_ERROR, BROWSER_UNAVAILABLE, CANCELLED, INTERNAL_ERROR
    }
    public enum ProviderResult {
        OK, INVALID_ARGUMENT, UNSUPPORTED_VERSION, BUFFER_TOO_SMALL, PROVIDER_UNAVAILABLE,
        HARDWARE_UNAVAILABLE, ACCESS_DENIED, KEY_NOT_FOUND, KEY_CORRUPT, KEY_LOST,
        UNSUPPORTED_ALGORITHM, SIGN_FAILED, IO_ERROR, BUSY, POLICY_VIOLATION, INTERNAL_ERROR
    }
    public enum CheckpointResult {
        NOT_ATTEMPTED, SAVED, UNCHANGED, MISSING, BUSY, STALE, CONFLICT, INVALID, IO_ERROR,
        MIRROR_PENDING, COMMIT_UNKNOWN, LOADED
    }
    /** Persistence and renewal hints are independent of permission to perform protected work. */
    public record Outcome(Result code, ProviderResult providerResult, CheckpointResult checkpointResult,
            boolean renewalDue, BigInteger effectiveTime) { }
    /** Comparison display only: expiresAt is never a caller-supplied authorization clock. */
    public record EnrollmentView(String comparisonCode, BigInteger expiresAt) { }
    public record PrepareResult(Result code, EnrollmentView view) { }

    private static final Cleaner CLEANER = Cleaner.create();
    private static final Outcome BUSY = new Outcome(Result.BUSY, ProviderResult.OK, CheckpointResult.NOT_ATTEMPTED, false, BigInteger.ZERO);
    private final State state;
    private final Cleaner.Cleanable cleanable;
    // This action must not retain the client. The shared lock excludes close from native calls.
    private static final class State implements Runnable {
        final DeviceBoundApi api;
        final ReentrantLock gate = new ReentrantLock();
        long handle;
        State(DeviceBoundApi api, long handle) { this.api = api; this.handle = handle; }
        boolean enter() { return !gate.isHeldByCurrentThread() && gate.tryLock(); }
        long requireOpen() {
            if (handle == 0) throw new IllegalStateException("Device-bound client is closed");
            return handle;
        }
        @Override public void run() {
            if (gate.isHeldByCurrentThread()) throw new IllegalStateException("Cannot close from an active native call");
            gate.lock();
            try {
                long owned = handle;
                handle = 0;
                if (owned != 0) api.close(owned);
            } finally { gate.unlock(); }
        }
    }
    DeviceBoundClient(DeviceBoundApi api) {
        state = new State(api, 0);
        cleanable = CLEANER.register(this, state);
    }
    // Called only by the library before publication; no allocation after the native handle arrives.
    void adopt(long handle) { state.handle = handle; }
    boolean hasHandle() { return state.handle != 0; }

    public Outcome activate() { return invoke(0); }
    public Outcome renew() { return invoke(1); }
    public Outcome authorize() { return invoke(2); }
    public Outcome saveCheckpoint() { return invoke(3); }
    public Outcome abandonPending() { return invoke(4); }
    private Outcome invoke(int operation) {
        if (!state.enter()) return BUSY;
        try {
            long[] raw = newOutcome(0);
            state.api.invoke(state.requireOpen(), operation, raw);
            return decode(raw, 0);
        } finally { state.gate.unlock(); Reference.reachabilityFence(this); }
    }
    public PrepareResult prepare() {
        if (!state.enter()) return new PrepareResult(Result.BUSY, null);
        try {
            long[] raw = new long[2];
            raw[0] = -1;
            byte[] comparison = new byte[15];
            state.api.prepare(state.requireOpen(), raw, comparison);
            Result code = decodeCode(raw[0]);
            if (code != Result.OK) return new PrepareResult(code, null);
            String text = new String(comparison, 0, 14, StandardCharsets.US_ASCII);
            if (comparison[14] != 0 || !text.matches("[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}")) {
                throw new IllegalStateException("Invalid native comparison code");
            }
            return new PrepareResult(code, new EnrollmentView(text, unsigned(raw[1])));
        } finally { state.gate.unlock(); Reference.reachabilityFence(this); }
    }
    public Result launch() { return simple(0, 0); }
    public Result poll(int waitMilliseconds) {
        if (waitMilliseconds < 0 || waitMilliseconds > 1000) throw new IllegalArgumentException("Poll wait must be 0..1000 ms");
        return simple(1, waitMilliseconds);
    }
    public Result cancel() { return simple(2, 0); }
    private Result simple(int operation, int waitMilliseconds) {
        if (!state.enter()) return Result.BUSY;
        try { return decodeCode(state.api.simple(state.requireOpen(), operation, waitMilliseconds)); }
        finally { state.gate.unlock(); Reference.reachabilityFence(this); }
    }
    static Result decodeCode(long code) {
        if (code == 255) return Result.INTERNAL_ERROR;
        if (code < 0 || code > 20) throw new IllegalStateException("Unknown native result");
        return Result.values()[(int) code];
    }
    static Outcome decode(long[] raw, int offset) {
        if (raw.length != offset + 5 || (raw[offset + 1] != 255 && (raw[offset + 1] < 0 || raw[offset + 1] > 14))
                || raw[offset + 2] < 0 || raw[offset + 2] > 11 || raw[offset + 3] < 0 || raw[offset + 3] > 1) {
            throw new IllegalStateException("Invalid native outcome");
        }
        return new Outcome(decodeCode(raw[offset]), raw[offset + 1] == 255 ? ProviderResult.INTERNAL_ERROR : ProviderResult.values()[(int) raw[offset + 1]],
            CheckpointResult.values()[(int) raw[offset + 2]], raw[offset + 3] == 1, unsigned(raw[offset + 4]));
    }
    static long[] newOutcome(int offset) {
        long[] raw = new long[offset + 5];
        Arrays.fill(raw, offset, raw.length, -1);
        return raw;
    }
    private static BigInteger unsigned(long value) { return new BigInteger(Long.toUnsignedString(value)); }
    /** Waits for admitted calls and closes once. Does not retire, save or delete the device key. */
    @Override public void close() {
        try {
            // Calling run directly also makes every concurrent close wait for admission.
            // Do not consume the Cleanable on a rejected reentrant close.
            state.run();
            cleanable.clean();
        } finally { Reference.reachabilityFence(this); }
    }
}
