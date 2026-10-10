/** Shared endpoint validation for the Compute and Credential Gateway Drivers. */
export function normalizeOpenAiBaseUrl(value: string): string | undefined {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return undefined;
  }
  const path = endpoint.pathname.replace(/\/$/u, "");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname.length === 0 ||
    // WHATWG decodes hostname escapes but permits stars that profiles treat as patterns.
    endpoint.hostname.includes("*") ||
    endpoint.port === "0" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !path.endsWith("/v1") ||
    path.includes("*") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    return undefined;
  }
  return endpoint.origin + path;
}
