/** Convert separate Set-Cookie fields to a Cookie header without splitting Expires commas. */
export function cookieHeaderFromSetCookie(values: string | readonly string[] | undefined): string {
  const entries = Array.isArray(values) ? values : values === undefined ? [] : [values];
  return entries
    .filter((value) => !/(?:^|;)\s*Max-Age=0(?:\s*;|$)/i.test(value))
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("; ");
}
