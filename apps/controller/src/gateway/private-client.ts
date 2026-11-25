import { GatewayClient, type GatewayClientOptions } from "@openclaw/gateway-client";

type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

export function privateGatewayUrl(url: string): URL {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("A private WSS Gateway endpoint is required.");
  }
  return endpoint;
}

/** Open one connection with the routed service identity. The caller checks its granted scopes. */
export async function withPrivateGatewayClient<T>(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  operation: (client: GatewayClient, hello: GatewayHello) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let resolveHello!: (hello: GatewayHello) => void;
  let rejectHello!: (error: unknown) => void;
  const hello = new Promise<GatewayHello>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const abort = () => rejectHello(signal.reason);
  const client = new GatewayClient({
    url,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    deviceIdentity: null,
    scopes: [],
    edgeAuthHeaders: { "x-api-key": apiKey },
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    try {
      client.start();
    } catch (error) {
      rejectHello(error);
    }
    return await operation(client, await hello);
  } finally {
    signal.removeEventListener("abort", abort);
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}
