#ifndef LICENSECC_DEVICE_IDENTITY_OPENSSL3_API_HPP_
#define LICENSECC_DEVICE_IDENTITY_OPENSSL3_API_HPP_

#include <openssl/encoder.h>
#include <openssl/evp.h>
#include <openssl/params.h>
#include <openssl/provider.h>
#include <openssl/store.h>
#include <openssl/types.h>

#include <cstddef>
#include <memory>

namespace license {
namespace device_identity {

/* Internal OpenSSL seam.  Keeping every provider-facing call here makes the
 * storage/provider state machine deterministic in the shim without exposing
 * an OpenSSL object through the public C ABI. */
class OpenSsl3Api {
public:
    virtual ~OpenSsl3Api() = default;

    virtual OSSL_LIB_CTX* libctx_new() noexcept = 0;
    virtual void libctx_free(OSSL_LIB_CTX* libctx) noexcept = 0;
    virtual OSSL_PROVIDER* provider_load(OSSL_LIB_CTX* libctx, const char* name) noexcept = 0;
    virtual int provider_unload(OSSL_PROVIDER* provider) noexcept = 0;

    virtual EVP_PKEY_CTX* pkey_ctx_new_from_name(OSSL_LIB_CTX* libctx,
                                                  const char* name,
                                                  const char* properties) noexcept = 0;
    virtual EVP_PKEY_CTX* pkey_ctx_new_from_pkey(OSSL_LIB_CTX* libctx,
                                                 EVP_PKEY* key,
                                                 const char* properties) noexcept = 0;
    virtual void pkey_ctx_free(EVP_PKEY_CTX* context) noexcept = 0;
    virtual int pkey_keygen_init(EVP_PKEY_CTX* context) noexcept = 0;
    virtual int pkey_ctx_set_params(EVP_PKEY_CTX* context, const OSSL_PARAM* params) noexcept = 0;
    virtual int pkey_generate(EVP_PKEY_CTX* context, EVP_PKEY** key) noexcept = 0;
    virtual int pkey_sign_init(EVP_PKEY_CTX* context) noexcept = 0;
    virtual int pkey_verify_init(EVP_PKEY_CTX* context) noexcept = 0;
    virtual int pkey_ctx_set_signature_md(EVP_PKEY_CTX* context, const EVP_MD* digest) noexcept = 0;
    virtual int pkey_sign(EVP_PKEY_CTX* context,
                          unsigned char* signature,
                          std::size_t* signature_size,
                          const unsigned char* digest,
                          std::size_t digest_size) noexcept = 0;
    virtual int pkey_verify(EVP_PKEY_CTX* context,
                            const unsigned char* signature,
                            std::size_t signature_size,
                            const unsigned char* digest,
                            std::size_t digest_size) noexcept = 0;
    virtual EVP_MD* md_fetch(OSSL_LIB_CTX* libctx,
                             const char* name,
                             const char* properties) noexcept = 0;
    virtual void md_free(EVP_MD* digest) noexcept = 0;
    virtual void pkey_free(EVP_PKEY* key) noexcept = 0;
    virtual const OSSL_PROVIDER* pkey_get0_provider(const EVP_PKEY* key) noexcept = 0;
    virtual const char* provider_name(const OSSL_PROVIDER* provider) noexcept = 0;
    virtual int pkey_get_utf8_string_param(const EVP_PKEY* key,
                                           const char* name,
                                           char* value,
                                           std::size_t value_size,
                                           std::size_t* written) noexcept = 0;

    virtual OSSL_ENCODER_CTX* encoder_new_for_pkey(const EVP_PKEY* key,
                                                   int selection,
                                                   const char* output_type,
                                                   const char* output_structure,
                                                   const char* properties) noexcept = 0;
    virtual int encoder_to_data(OSSL_ENCODER_CTX* context,
                                unsigned char** data,
                                std::size_t* data_size) noexcept = 0;
    virtual void encoder_free(OSSL_ENCODER_CTX* context) noexcept = 0;

    virtual OSSL_STORE_CTX* store_open_ex(const char* uri,
                                          OSSL_LIB_CTX* libctx,
                                          const char* properties,
                                          const UI_METHOD* ui_method,
                                          void* ui_data) noexcept = 0;
    virtual int store_expect(OSSL_STORE_CTX* context, int expected_type) noexcept = 0;
    virtual OSSL_STORE_INFO* store_load(OSSL_STORE_CTX* context) noexcept = 0;
    virtual int store_eof(OSSL_STORE_CTX* context) noexcept = 0;
    virtual int store_error(OSSL_STORE_CTX* context) noexcept = 0;
    virtual int store_info_type(const OSSL_STORE_INFO* info) noexcept = 0;
    virtual EVP_PKEY* store_info_get1_pkey(const OSSL_STORE_INFO* info) noexcept = 0;
    virtual void store_info_free(OSSL_STORE_INFO* info) noexcept = 0;
    virtual int store_close(OSSL_STORE_CTX* context) noexcept = 0;

    virtual int rand_priv_bytes_ex(OSSL_LIB_CTX* libctx,
                                   unsigned char* data,
                                   std::size_t size,
                                   unsigned int strength) noexcept = 0;
};

std::shared_ptr<OpenSsl3Api> make_native_openssl3_api() noexcept;

}  // namespace device_identity
}  // namespace license

#endif
