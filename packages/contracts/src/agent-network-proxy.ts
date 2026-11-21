/** An Agent's Gateway-channel-only upstream proxy selection. */
export interface AgentNetworkProxy {
  readonly url: string;
  readonly credentialSecretId?: string;
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
    /[\u0000-\u0020\u007f]/u.test(input) ||
    !/^https?:\/\//iu.test(input) ||
    /^https?:\/\/[^/]*@/iu.test(input)
  ) {
    throw new Error("Invalid Network proxy URL. Use an HTTP or HTTPS endpoint without credentials.");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid Network proxy URL. Use an HTTP or HTTPS endpoint without credentials.");
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
    throw new Error("Invalid Network proxy URL. Use an HTTP or HTTPS endpoint without credentials.");
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
