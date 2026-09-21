import type { R2BucketLike, R2PutOptionsLike, R2PutResultLike } from "./core.js";

export async function exportContentLength(response: Response): Promise<number> {
  const header = response.headers.get("content-length");
  const length = Number(header);
  const encoding = response.headers.get("content-encoding");
  if (header === null || !/^\d+$/.test(header) || !Number.isSafeInteger(length) || length < 1 ||
      (encoding !== null && encoding !== "identity")) {
    await response.body?.cancel();
    throw new Error(length === 0 && header === "0" ? "d1_export_empty" : "d1_export_invalid_content_length");
  }
  return length;
}

// Hashing/scanning strips the fetch body's known-length property. Restore it
// without buffering the dump; the runtime also enforces the declared length.
export async function putKnownLengthStream(
  bucket: R2BucketLike,
  key: string,
  source: ReadableStream<Uint8Array>,
  length: number,
  options: R2PutOptionsLike,
): Promise<R2PutResultLike | null> {
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  const transfer = source.pipeTo(fixed.writable, { signal: abort.signal });
  const upload = Promise.resolve().then(() => bucket.put(key, fixed.readable, options));
  try {
    const [result] = await Promise.all([upload, transfer]);
    return result;
  } catch (error) {
    // An upload rejected before consuming the body must not leave the producer
    // blocked on backpressure. Drain both promises before the Workflow retries.
    abort.abort(error);
    await Promise.allSettled([upload, transfer]);
    throw error;
  }
}
