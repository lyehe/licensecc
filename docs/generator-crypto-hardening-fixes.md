# Generator crypto-helper hardening fixes (hand-off)

These five fixes harden the `lcc-license-generator` submodule's crypto helpers. They
were found by the iterative review of the parent `licensecc` repo (rounds 4, 6 and the
plan-eng-review pass) but belong to the **separate generator repo**
(`extern/license-generator`, GitHub `open-license-manager/lcc-license-generator`).

They are currently applied to the submodule **working tree**, interleaved with the
large uncommitted generator WIP, so they could not be committed cleanly from the parent
branch and the submodule has no fork to push to. Apply them with the generator work, on
a box that can build the OpenSSL backend (Linux) for the three OpenSSL ones.

All triggers are crypto-API failure paths (OOM / broken OpenSSL/BCrypt), so impact is
low, but they are real defects (a use-after-free, a null-deref, an uninitialised handle,
two unchecked/leaking paths) in the license-signing tool.

---

## 1. `signString` use-after-free — `src/base_lib/openssl/crypto_helper_ssl.cpp` (HIGH)

On `EVP_DigestSignInit` failure the context is destroyed but execution falls through to
`EVP_DigestSignUpdate(mdctx, ...)`, dereferencing the freed `mdctx`.

```cpp
	if (1 != EVP_DigestSignInit(mdctx, NULL, EVP_sha256(), NULL, m_pktmp)) {
		EVP_MD_CTX_destroy(mdctx);
+		throw logic_error("Message signing init exception");
	}
```

## 2. `generateKeyPair` null-deref + ctx leak — `crypto_helper_ssl.cpp`

`ctx` is dereferenced after empty `if (!ctx) {}` / `if (... <= 0) {}` bodies, and the
later throw paths leak `ctx`.

```cpp
-	EVP_PKEY_CTX *ctx;
-	ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);
-	if (!ctx) {
-	}
-	if (EVP_PKEY_keygen_init(ctx) <= 0) {
-	}
-	if (EVP_PKEY_CTX_set_rsa_keygen_bits(ctx, static_cast<int>(key_bits)) <= 0) {
-		throw logic_error("error setting key properties");
-	}
-	if (EVP_PKEY_keygen(ctx, &m_pktmp) <= 0) {
-		throw logic_error("error generating keypair");
-	}
-	EVP_PKEY_CTX_free(ctx);
+	EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);
+	if (!ctx) {
+		throw logic_error("error creating key generation context");
+	}
+	if (EVP_PKEY_keygen_init(ctx) <= 0) {
+		EVP_PKEY_CTX_free(ctx);
+		throw logic_error("error initializing key generation");
+	}
+	if (EVP_PKEY_CTX_set_rsa_keygen_bits(ctx, static_cast<int>(key_bits)) <= 0) {
+		EVP_PKEY_CTX_free(ctx);
+		throw logic_error("error setting key properties");
+	}
+	if (EVP_PKEY_keygen(ctx, &m_pktmp) <= 0) {
+		EVP_PKEY_CTX_free(ctx);
+		throw logic_error("error generating keypair");
+	}
+	EVP_PKEY_CTX_free(ctx);
```

## 3 + 4. `exportPrivateKey` unchecked PEM + `rsa` leak — `crypto_helper_ssl.cpp`

`PEM_write_bio_RSAPrivateKey`'s return is ignored (a failed/empty serialization yields an
empty key that is silently written), and the `EVP_PKEY_get1_RSA` reference is never freed.

```cpp
 	RSA *rsa = EVP_PKEY_get1_RSA(m_pktmp);
+	if (rsa == NULL) {
+		BIO_free(bio_private);
+		throw logic_error("error reading RSA private key for export");
+	}
 	// EVP_PKEY_assign_RSA(m_pktmp, rsa);
-	PEM_write_bio_RSAPrivateKey(bio_private, rsa, NULL, NULL, 0, NULL, NULL);
-	// RSA_free(rsa);
+	if (PEM_write_bio_RSAPrivateKey(bio_private, rsa, NULL, NULL, 0, NULL, NULL) != 1) {
+		RSA_free(rsa);
+		BIO_free(bio_private);
+		throw logic_error("error serializing RSA private key");
+	}
+	RSA_free(rsa);  // BIO now owns the serialized bytes; release the EVP_PKEY_get1_RSA reference.
 	int keylen = BIO_pending(bio_private);
+	if (keylen <= 0) {
+		BIO_free(bio_private);
+		throw logic_error("empty RSA private key export");
+	}
 	char *pem_key = (char *)(calloc(keylen + 1, 1));
```

## 5. Uninitialised BCrypt hash handle — `src/base_lib/win/CryptoHelperWindows.cpp::signString`

`hHash` is only assigned inside `BCryptCreateHash`; an earlier failure reaches the
unconditional `if (hHash) { BCryptDestroyHash(hHash); }` cleanup with an indeterminate
handle. (Build-verified on Windows.)

```cpp
-	BCRYPT_HASH_HANDLE hHash;
+	BCRYPT_HASH_HANDLE hHash = nullptr;
```
