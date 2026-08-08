export function canonicalEntitlementEvent(row: Record<string, unknown>): string;
export function computeSegmentDigest(prevDigest: string, canonicalEvents: string[]): Promise<string>;
