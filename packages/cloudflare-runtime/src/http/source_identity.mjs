// The client identity a Worker rate limit keys on, from the cf-connecting-ip header value.

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** @param {string} text @returns {number[] | null} eight 16-bit groups */
function ipv6Groups(text) {
  let body = text, tail = [];
  if (body.includes(".")) {
    // Embedded dotted IPv4 (e.g. ::ffff:192.0.2.1) supplies the last two groups.
    const lastColon = body.lastIndexOf(":");
    const v4 = body.slice(lastColon + 1);
    if (!IPV4.test(v4)) return null;
    const [a, b, c, d] = v4.split(".").map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    body = body.slice(0, lastColon + 1);
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  /** @param {string} part */
  const parse = (part) => part === "" ? [] : part.split(":").map(group => HEXTET.test(group) ? parseInt(group, 16) : NaN);
  const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  return [...head, ...Array(8 - explicit).fill(0), ...rest, ...tail];
}

/**
 * Per-source identity for a rate limit. One IPv6 subscriber usually controls a whole /64, so an
 * IPv6 source is keyed by that prefix; an IPv4-mapped address is its IPv4 address and an IPv4
 * address is kept as sent. Anything unparseable keeps the raw (trimmed) header value, so malformed
 * input never shares a budget with a real prefix by accident. A missing value is "".
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sourceIdentity(raw) {
  const value = String(raw ?? "").trim();
  if (IPV4.test(value)) return value;
  const address = value.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").toLowerCase();
  if (!address.includes(":")) return value;
  const groups = ipv6Groups(address);
  if (!groups) return value;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(":")}::/64`;
}
