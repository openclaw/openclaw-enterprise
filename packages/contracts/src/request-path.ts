// Match the original wire path. Only spaces and non-ASCII UTF-8 bytes may be escaped.
export function validRequestPath(path: unknown, allowSubtree: boolean): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("//")) {
    return false;
  }
  const base = allowSubtree && path.endsWith("/**") ? path.slice(0, -3) : path;
  if (!/^(?:[A-Za-z0-9._~!$&'()+,:=@/-]|%20|%[89A-F][0-9A-F])*$/.test(base)) {
    return false;
  }
  try {
    return decodeURIComponent(base)
      .split("/")
      .every((segment) => {
        // A segment must remain one ordinary segment even if the origin normalizes Unicode.
        const normalized = segment.normalize("NFKC");
        return normalized !== "." && normalized !== ".." && !/[/%\\?#;*\p{Cc}]/u.test(normalized);
      });
  } catch {
    return false;
  }
}
