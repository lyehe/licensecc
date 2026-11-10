export type ProtectedDeviceResult<T> = { ok: true; data: T } | { ok: false; code: string; retryAfter?: number };

interface ProtectedDeviceRequest<T> {
  readonly path: string;
  readonly customerId: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly successCode: string;
  readonly failureStatuses: Readonly<Record<string, number>>;
  readonly validate: (data: unknown) => data is T;
}

export async function protectedDeviceRequest<T>(request: ProtectedDeviceRequest<T>): Promise<ProtectedDeviceResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers: Record<string, string> = { "x-expected-customer-id": encodeURIComponent(request.customerId) };
    if (request.method === "POST") headers["content-type"] = "application/json";
    if (request.idempotencyKey !== undefined) headers["idempotency-key"] = request.idempotencyKey;
    const response = await fetch(request.path, {
      method: request.method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers,
      ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
    });
    const result = await response.json() as { ok?: unknown; code?: unknown; data?: unknown } | null;
    if (response.status === 200 && result?.ok === true && result.code === request.successCode && request.validate(result.data)) {
      return { ok: true, data: result.data };
    }
    if (result?.ok === false && typeof result.code === "string" && Object.hasOwn(request.failureStatuses, result.code)
        && request.failureStatuses[result.code] === response.status) {
      return {
        ok: false,
        code: result.code,
        ...(response.status === 429 ? { retryAfter: Math.min(300, Math.max(60, Number(response.headers.get("retry-after")) || 60)) } : {}),
      };
    }
  } catch {
    // An unconfirmed response cannot prove that a saved mutation failed.
  } finally {
    clearTimeout(timeout);
  }
  return { ok: false, code: "temporarily_unavailable" };
}
