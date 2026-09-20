export function loginEmail(value: unknown): string | null;
export function validPassword(value: unknown): value is string;
export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, stored: string | null): Promise<boolean>;
