package io.licensecc.client;

/** Package-private marshaling seam; authority remains in the native runtime. */
interface FeatureSessionApi {
    void open(DeviceBoundConfiguration.Encoded configuration, long[] result);
    void invoke(long handle, int operation, byte[] feature, long[] result);
    void close(long handle);
}
