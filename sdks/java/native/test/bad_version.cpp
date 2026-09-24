#include <jni.h>
// Test-only wrong-protocol DLL: it reports the previous protocol, whose outcome arrays were one value shorter.
// Never installed or linked into the production adapter.
extern "C" JNIEXPORT jint JNICALL Java_io_licensecc_client_DeviceBoundNative_version(JNIEnv*, jclass) { return 1; }
