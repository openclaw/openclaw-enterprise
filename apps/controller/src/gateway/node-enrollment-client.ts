import { GatewayClient, type GatewayClientOptions } from "@openclaw/gateway-client";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export interface NodeSetup {
  readonly setupId: string;
  readonly setupCode: string;
  readonly expiresAtMs: number;
}

export interface GatewayNodeEnrollment {
  createSetup(url: string, nodeUrl: string, signal: AbortSignal): Promise<NodeSetup>;
  observeSetup(
    url: string,
    setupId: string,
    signal: AbortSignal,
  ): Promise<{ readonly deviceId: string; readonly connected: boolean } | undefined>;
  isConnected(url: string, deviceId: string, signal: AbortSignal): Promise<boolean>;
}

type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

/** Compute uses the existing administrative route; only the node-only setup crosses to the Harness. */
export function createGatewayNodeEnrollment(
  readApiKey: () => Promise<string>,
): GatewayNodeEnrollment {
  return {
    createSetup: (url, nodeUrl, signal) =>
      withGateway(url, readApiKey, signal, async (client, requestSignal) => {
        const setup = asRecord(
          await client.request(
            "device.pair.setupCode",
            { bootstrapProfile: "node", includeQr: false, publicUrl: nodeUrl },
            { signal: requestSignal },
          ),
        );
        if (
          setup?.access !== "node" ||
          setup.gatewayUrl !== nodeUrl ||
          !isNonEmptyString(setup.setupId) ||
          !isNonEmptyString(setup.setupCode) ||
          typeof setup.expiresAtMs !== "number" ||
          !Number.isSafeInteger(setup.expiresAtMs) ||
          setup.expiresAtMs <= Date.now()
        ) {
          throw new Error("The Gateway did not issue a valid node-only setup credential.");
        }
        return {
          setupId: setup.setupId,
          setupCode: setup.setupCode,
          expiresAtMs: setup.expiresAtMs,
        };
      }),
    observeSetup: (url, setupId, signal) =>
      withGateway(url, readApiKey, signal, async (client, requestSignal) => {
        const status = asRecord(
          await client.request("device.pair.setupStatus", { setupId }, { signal: requestSignal }),
        );
        if (status === undefined) {
          throw new Error("The Gateway returned an invalid setup status.");
        }
        // A delivery-uncertain handoff may still have reached the node. Live
        // presence is observed separately; setup status alone is not readiness.
        const completion = asRecord(status.completion ?? status.deliveryUncertain);
        if (completion === undefined) {
          return undefined;
        }
        if (
          completion.setupId !== setupId ||
          completion.access !== "node" ||
          !isNonEmptyString(completion.deviceId)
        ) {
          throw new Error("The Gateway returned an invalid node setup completion.");
        }
        return {
          deviceId: completion.deviceId,
          connected: await isConnected(client, completion.deviceId, requestSignal),
        };
      }),
    isConnected: (url, deviceId, signal) =>
      withGateway(url, readApiKey, signal, (client, requestSignal) =>
        isConnected(client, deviceId, requestSignal),
      ),
  };
}

async function isConnected(
  client: GatewayClient,
  deviceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const node = asRecord(await client.request("node.describe", { nodeId: deviceId }, { signal }));
  if (node?.nodeId !== deviceId || typeof node.connected !== "boolean") {
    throw new Error("The Gateway returned an invalid node observation.");
  }
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return (
    node.connected &&
    [
      "file.fetch",
      "file.stat",
      "file.write",
      "file.create",
      "dir.list",
      "workspace.memory",
      "workspace.skills",
    ].every((command) => commands.includes(command))
  );
}

async function withGateway<T>(
  url: string,
  readApiKey: () => Promise<string>,
  ownerSignal: AbortSignal,
  operation: (client: GatewayClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Node enrollment requires a private WSS Gateway endpoint.");
  }
  const apiKey = await readApiKey();
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(10_000)]);
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
    const connected = await hello;
    if (connected.auth?.role !== "operator" || !connected.auth.scopes?.includes("operator.admin")) {
      throw new Error("Node enrollment requires the Gateway administrative service identity.");
    }
    return await operation(client, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}
