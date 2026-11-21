/** An Agent's Gateway-channel-only upstream proxy selection. */
export interface AgentNetworkProxy {
  readonly url: string;
  readonly credentialSecretId?: string;
}

function hasControlCharacter(value: string, includeSpace = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= (includeSpace ? 32 : 31) || code === 127) {
      return true;
    }
  }
  return false;
}

/** Validate the complete header value without returning any credential material. */
export function validNetworkProxyAuthorization(value: string): boolean {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    return false;
  }
  const decoded = Buffer.from(match[1]!, "base64");
  return (
    decoded.toString("base64") === match[1] &&
    decoded.includes(58) &&
    !hasControlCharacter(decoded.toString("utf8"))
  );
}

/** Parse without retaining URL parser errors, which can contain credentials. */
export function normalizeAgentNetworkProxy(value: unknown): Readonly<AgentNetworkProxy> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Network proxy selection.");
  }
  const selection = value as Record<string, unknown>;
  const input = selection.url;
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    hasControlCharacter(input, true) ||
    !/^https?:\/\//iu.test(input) ||
    /^https?:\/\/[^/]*@/iu.test(input)
  ) {
    throw new Error(
      "Invalid Network proxy URL. Use an HTTP or HTTPS endpoint without credentials.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(
      "Invalid Network proxy URL. Use an HTTP or HTTPS endpoint without credentials.",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Invalid Network proxy URL. Use an HTTP or HTTPS endpoint without credentials.",
    );
  }
  if (
    selection.credentialSecretId !== undefined &&
    (typeof selection.credentialSecretId !== "string" || !selection.credentialSecretId)
  ) {
    throw new Error("Invalid Network proxy credential Secret reference.");
  }
  return Object.freeze({
    url: parsed.origin,
    ...(selection.credentialSecretId === undefined
      ? {}
      : { credentialSecretId: selection.credentialSecretId }),
  });
}
