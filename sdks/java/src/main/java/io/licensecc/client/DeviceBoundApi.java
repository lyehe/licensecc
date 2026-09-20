package io.licensecc.client;

/** Package-private seam for marshaling tests; no public transport or clock injection. */
interface DeviceBoundApi {
    void open(DeviceBoundConfiguration.Encoded configuration, boolean resume, long[] result);
    void invoke(long handle, int operation, long[] result);
    void prepare(long handle, long[] result, byte[] comparison);
    int simple(long handle, int operation, int waitMilliseconds);
    void close(long handle);
}
