// Hand-written types for the Worker-safe HTTP/security kit (kit.mjs).

export declare function constantTimeEqual(a: unknown, b: unknown): Promise<boolean>;
export declare function readTextBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }>;
export declare function requestId(request: Request): string;
export declare function clientIp(request: Request): string;
export declare function bearerToken(request: Request): string | null;
export declare function safeString(value: unknown, maxLen: number): string | null;
export declare function json(body: unknown, status?: number): Response;
