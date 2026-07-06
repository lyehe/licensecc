export function json<T>(body: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function envelope<T>(requestId: string, code: string, data?: T, status = 200): Response {
  return json({ ok: status >= 200 && status < 300, code, request_id: requestId, data }, status);
}
