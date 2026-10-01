/**
 * The client identity a Worker rate limit keys on: an IPv6 address reduced to its /64 prefix, an
 * IPv4 or IPv4-mapped address as its IPv4 address, anything else as the trimmed raw value.
 */
export function sourceIdentity(raw: unknown): string;
