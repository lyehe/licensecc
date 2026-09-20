export class UnsignedJsonError extends Error {
  constructor(code = "invalid_request", status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
/** @returns {never} */
function invalid() { throw new UnsignedJsonError(); }
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const MAX_BODY = 16384;

// JSON.parse alone loses duplicate keys. Scan valid JSON's string tokens before
// accepting it, including escaped member names and nested proof objects.
export function parseUnsignedJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BODY) invalid();
  try {
    const source = utf8.decode(bytes);
    const value = JSON.parse(source);
    const stack = [];
    let cursor = 0;
    while (cursor < source.length) {
      const start = cursor++;
      const first = source[start];
      if (first === '"') {
        // JSON.parse already validated escapes. Consume each character once;
        // never search again from a later quote inside the same string.
        while (cursor < source.length) {
          const character = source[cursor++];
          if (character === "\\") cursor += 1;
          else if (character === '"') break;
        }
      } else if (first === "-" || (first >= "0" && first <= "9")) {
        while (cursor < source.length && /[0-9eE+.-]/.test(source[cursor])) cursor += 1;
      }
      const token = source.slice(start, cursor);
      if (token === "{" || token === "[") {
        stack.push(token === "{" ? new Set() : null);
        if (stack.length > 8) invalid();
      } else if (token === "}" || token === "]") stack.pop();
      else if (/^[-0-9]/.test(token)) {
        // This parser accepts only unsigned integer numeric fields. Check
        // its lexical form before JSON rounding can turn a fraction into one.
        if (!/^(0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token))) invalid();
      }
      else if (token.startsWith('"')) {
        const text = JSON.parse(token);
        if (utf8.decode(encoder.encode(text)) !== text) invalid();
        while (cursor < source.length && /[ \t\r\n]/.test(source[cursor])) cursor += 1;
        if (source[cursor] === ":") {
          const keys = stack.at(-1);
          if (!keys || keys.has(text)) invalid();
          keys.add(text);
        }
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    return value;
  } catch { invalid(); }
}

export async function readUnsignedJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") || "")) invalid();
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") invalid();
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) invalid();
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_BODY - length) {
        // An uncooperative stream must not delay rejection after overflow.
        void reader.cancel().catch(() => {});
        invalid();
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch { invalid(); }
  finally { reader.releaseLock(); }
  return parseUnsignedJson(bytes.subarray(0, length));
}
