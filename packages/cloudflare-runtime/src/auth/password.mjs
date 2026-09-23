import { scrypt } from "@noble/hashes/scrypt.js";
import { constantTimeEqual } from "../http/kit.mjs";
// OWASP's scrypt N=2^15/r=8/p=3 profile: ~32 MiB, bounded 64 MiB allocation.
const PREFIX = "scrypt-32768-8-3";
const SALT_BYTES = 16;
const encoder = new TextEncoder();
function hex(bytes) { return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }
function unhex(value) { return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)); }
// addr-spec only: header/list/quoting punctuation and controls never reach the mail API.
// eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
const EMAIL = /^[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+@[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+\.[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+$/;
export function loginEmail(value) {
    if (typeof value !== "string")
        return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && EMAIL.test(email) ? email : null;
}
export function validPassword(value) {
    return typeof value === "string" && [...value].length >= 15 && [...value].length <= 128 && encoder.encode(value).length <= 512;
}
async function derive(password, salt) {
    const bytes = encoder.encode(password);
    // Do not yield while the memory-hard buffer is allocated: concurrent requests in
    // one isolate must not each retain a 32 MiB allocation across scheduler turns.
    try {
        return hex(scrypt(bytes, salt, { N: 32768, r: 8, p: 3, dkLen: 32, maxmem: 64 * 1024 * 1024 }));
    }
    finally {
        bytes.fill(0);
    }
}
export async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    return `${PREFIX}$${hex(salt)}$${await derive(password, salt)}`;
}
export async function verifyPassword(password, stored) {
    const match = stored?.match(/^scrypt-32768-8-3\$([a-f0-9]{32})\$([a-f0-9]{64})$/);
    // Missing users perform the same KDF; no cheap username-existence timing path.
    const actual = await derive(password, match?.[1] ? unhex(match[1]) : new Uint8Array(SALT_BYTES));
    return await constantTimeEqual(actual, match?.[2] ?? "0".repeat(64)) && Boolean(match);
}
