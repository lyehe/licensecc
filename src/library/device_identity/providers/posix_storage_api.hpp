#ifndef LICENSECC_DEVICE_IDENTITY_POSIX_STORAGE_API_HPP_
#define LICENSECC_DEVICE_IDENTITY_POSIX_STORAGE_API_HPP_

#include <sys/stat.h>
#include <sys/types.h>

#include <cstddef>
#include <ctime>
#include <memory>

namespace license {
namespace device_identity {

/* Internal POSIX seam for descriptor-relative, no-follow storage. */
class PosixStorageApi {
public:
    virtual ~PosixStorageApi() = default;

    virtual int openat(int directory,
                       const char* path,
                       int flags,
                       mode_t mode) noexcept = 0;
    virtual int close(int descriptor) noexcept = 0;
    virtual int fstat(int descriptor, struct stat* status) noexcept = 0;
    virtual int flock(int descriptor, int operation) noexcept = 0;
    virtual ssize_t write(int descriptor, const void* data, std::size_t size) noexcept = 0;
    virtual int fdatasync(int descriptor) noexcept = 0;
    virtual int fsync(int descriptor) noexcept = 0;
    virtual int unlinkat(int directory, const char* path, int flags) noexcept = 0;
    virtual int linkat(int old_directory,
                       const char* old_path,
                       int new_directory,
                       const char* new_path,
                       int flags) noexcept = 0;
    virtual int renameat2_noreplace(int directory,
                                    const char* old_path,
                                    const char* new_path) noexcept = 0;
    virtual int clock_gettime(clockid_t clock, struct timespec* value) noexcept = 0;
    virtual int nanosleep(const struct timespec* request, struct timespec* remaining) noexcept = 0;
};

std::shared_ptr<PosixStorageApi> make_native_posix_storage_api() noexcept;

}  // namespace device_identity
}  // namespace license

#endif
