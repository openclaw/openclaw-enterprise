/** Test for non-whitespace content; do not trim the caller's value. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Whether a host's last label (before one trailing dot) is a decimal or `0x` hex number, the
 * WHATWG URL "ends in a number" rule. The URL parser then reads the whole host as an IPv4
 * address, and `inet_aton`-style resolvers such as glibc's turn `0xa.0.0.5` or `0x7f.0x1` into
 * one, so a host checked as a DNS name must not end in one.
 */
export function numericLastLabel(host: string): boolean {
  const labels = host.split(".");
  if (labels.length > 1 && labels.at(-1) === "") {
    labels.pop();
  }
  return /^(?:0x[0-9a-f]*|[0-9]+)$/i.test(labels.at(-1) ?? "");
}
