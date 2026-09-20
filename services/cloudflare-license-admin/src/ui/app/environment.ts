export interface AdminSettings {
  environment: string;
  public_verifier_url: string;
  auth: "dev-bearer" | "cloudflare-access";
}

export function hasAdminSettings(value: unknown): value is AdminSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data.environment === "string" && data.environment.trim() !== "" && data.environment.length <= 128
    && typeof data.public_verifier_url === "string"
    && (data.auth === "dev-bearer" || data.auth === "cloudflare-access");
}

export function environmentLabel(environment: string): string | null {
  if (environment === "staging") return "Staging";
  if (environment === "development") return "Development";
  if (environment === "production") return "Production";
  return null;
}
