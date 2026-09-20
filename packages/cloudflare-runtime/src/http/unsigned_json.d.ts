/** Strict, bounded JSON objects with unsigned safe-integer numeric fields. */
export class UnsignedJsonError extends Error {
  constructor(code?: string, status?: number);
  code: string;
  status: number;
}

export function parseUnsignedJson(bytes: Uint8Array): Record<string, unknown>;
export function readUnsignedJson(request: Request): Promise<Record<string, unknown>>;
