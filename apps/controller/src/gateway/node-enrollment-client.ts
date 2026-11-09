import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type GatewayClientOptions,
} from "@openclaw/gateway-client";
import { setTimeout as delay } from "node:timers/promises";
import { TransientDependencyError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString, isWorkspaceNodeDeviceId } from "@openclaw-enterprise/utils";

export { isWorkspaceNodeDeviceId } from "@openclaw-enterprise/utils";

export interface NodeSetup {
  readonly setupId: string;
  readonly setupCode: string;
  readonly expiresAtMs: number;
}

export interface GatewayNodeEnrollment {
  createSetup(url: string, nodeUrl: string, signal: AbortSignal): Promise<NodeSetup>;
  /**
   * Reads the setup receipt before any node lookup, so its owner can persist
   * the consumed setup's identity before probing credential possession. With
   * `waitMs`, keeps one connection and re-reads until either receipt appears
   * or the time is up.
   * `stopWaiting` ends the wait early, after at least one reading, when it
   * returns true between readings.
   */
  observeSetup(
    url: string,
    setupId: string,
    signal: AbortSignal,
    options?: NodeSetupObserveOptions,
  ): Promise<NodeSetupObservation | undefined>;
  /** Requires the supported commands and a current device-token-authenticated session. */
  isConnected(url: string, deviceId: string, signal: AbortSignal): Promise<boolean>;
}

export interface NodeSetupObserveOptions {
  readonly waitMs?: number;
  readonly stopWaiting?: () => Promise<boolean>;
}

export interface NodeSetupObservation {
  readonly deviceId: string;
  /** Native delivery status describes the server write, not client credential custody. */
  readonly delivery: "confirmed" | "uncertain";
}

type GatewayRequest = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  options: { readonly signal: AbortSignal },
) => Promise<unknown>;

// One status read per interval while a caller waits for a node to pair.
export const NODE_SETUP_POLL_MS = 250;
const GATEWAY_CONNECT_BUDGET_MS = 10_000;

type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

// The Gateway's route answers these while it converges: 404 until Envoy has the
// HTTPRoute, 502-504 until it has a ready endpoint for the new Pod.
const CONVERGING_ROUTE_STATUSES = new Set([404, 502, 503, 504]);
const UNREACHABLE_SOCKET_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Names a Gateway connection failure that clears as the Gateway and its route
 * converge, so the worker retries it within the deployment deadline. Rejected
 * credentials, protocol errors and invalid answers stay as they are.
 */
function transientGatewayFailure(error: unknown): TransientDependencyError | undefined {
  if (error instanceof GatewayClientRequestTimeoutError) {
    return new TransientDependencyError(
      "agent_gateway",
      "timeout",
      "An Agent Gateway request timed out.",
      { cause: error },
    );
  }
  const record = asRecord(error);
  const details = asRecord(record?.details);
  if (details?.reason === "websocket-upgrade-rejected") {
    const status = details.httpStatus;
    return typeof status === "number" && CONVERGING_ROUTE_STATUSES.has(status)
      ? new TransientDependencyError(
          "agent_gateway",
          "unavailable",
          `The Agent Gateway route answered HTTP ${status} to the connection upgrade.`,
          { cause: error },
        )
      : undefined;
  }
  if (typeof record?.code === "string" && UNREACHABLE_SOCKET_CODES.has(record.code)) {
    return new TransientDependencyError(
      "agent_gateway",
      "unreachable",
      `The Agent Gateway route was unreachable (${record.code}).`,
      { cause: error },
    );
  }
  if (
    (error instanceof GatewayClientRequestError &&
      error.code === "UNAVAILABLE" &&
      error.retryable) ||
    (error instanceof Error && /^gateway (?:closed \(|not connected$)/u.test(error.message))
  ) {
    return new TransientDependencyError(
      "agent_gateway",
      "unavailable",
      "The Agent Gateway closed the connection or reported itself unavailable.",
      { cause: error },
    );
  }
  return undefined;
}

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
    observeSetup: (url, setupId, signal, options = {}) => {
      const waitMs = Math.max(0, options.waitMs ?? 0);
      return withGateway(
        url,
        readApiKey,
        signal,
        (client, requestSignal) =>
          observeNodeSetup(
            (method, params, request) => client.request(method, params, request),
            setupId,
            requestSignal,
            waitMs,
            options.stopWaiting,
          ),
        waitMs,
      );
    },
    isConnected: (url, deviceId, signal) =>
      withGateway(url, readApiKey, signal, (client, requestSignal) =>
        isConnected(
          (method, params, request) => client.request(method, params, request),
          deviceId,
          requestSignal,
        ),
      ),
  };
}

/**
 * Setup status over one Gateway connection. Without a wait this is a single
 * read. With one, it re-reads every NODE_SETUP_POLL_MS until
 * a receipt appears or `waitMs` has passed, and returns the last reading.
 * `stopWaiting`, asked between readings, ends the wait early the same way.
 * Every reading gets the same validation; waiting never relaxes it.
 */
export async function observeNodeSetup(
  request: GatewayRequest,
  setupId: string,
  signal: AbortSignal,
  waitMs = 0,
  stopWaiting?: () => Promise<boolean>,
): Promise<NodeSetupObservation | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal.throwIfAborted();
    const status = asRecord(await request("device.pair.setupStatus", { setupId }, { signal }));
    signal.throwIfAborted();
    if (status === undefined) {
      throw new Error("The Gateway returned an invalid setup status.");
    }
    // Validate both present receipts before preferring confirmed completion.
    // Even a confirmed server write can precede the client's hello receipt.
    let observation: NodeSetupObservation | undefined;
    for (const field of ["completion", "deliveryUncertain"] as const) {
      if (!Object.hasOwn(status, field)) {
        continue;
      }
      const completion = asRecord(status[field]);
      if (
        completion === undefined ||
        completion.setupId !== setupId ||
        completion.access !== "node" ||
        !isWorkspaceNodeDeviceId(completion.deviceId)
      ) {
        throw new Error("The Gateway returned an invalid node setup completion.");
      }
      observation ??= {
        deviceId: completion.deviceId,
        delivery: field === "completion" ? "confirmed" : "uncertain",
      };
    }
    if (
      observation !== undefined ||
      Date.now() + NODE_SETUP_POLL_MS > deadline ||
      (stopWaiting !== undefined && (await stopWaiting()))
    ) {
      return observation;
    }
    try {
      await delay(NODE_SETUP_POLL_MS, undefined, { signal });
    } catch (error) {
      // Surface the owner's reason (a lost claim, a timeout), not a bare AbortError.
      signal.throwIfAborted();
      throw error;
    }
  }
}

async function isConnected(
  request: GatewayRequest,
  deviceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const node = asRecord(await request("node.describe", { nodeId: deviceId }, { signal }));
  signal.throwIfAborted();
  if (
    node?.nodeId !== deviceId ||
    typeof node.connected !== "boolean" ||
    typeof node.deviceTokenAuthenticated !== "boolean"
  ) {
    throw new Error("The Gateway returned an invalid node observation.");
  }
  if (!node.connected) {
    return false;
  }
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const missing = [
    "file.fetch",
    "file.stat",
    "file.write",
    "file.create",
    "dir.list",
    "workspace.memory",
    "workspace.skills",
  ].filter((command) => !commands.includes(command));
  if (missing.length > 0) {
    throw new Error(`The workspace node is missing required commands: ${missing.join(", ")}.`);
  }
  // Bootstrap registration and its server receipt do not prove possession.
  // Native exposes this fact only for the current open session after checking
  // the exact device token and its still-current pairing generation.
  return node.deviceTokenAuthenticated;
}

async function withGateway<T>(
  url: string,
  readApiKey: () => Promise<string>,
  ownerSignal: AbortSignal,
  operation: (client: GatewayClient, signal: AbortSignal) => Promise<T>,
  waitMs = 0,
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
  const budget = AbortSignal.timeout(GATEWAY_CONNECT_BUDGET_MS + waitMs);
  const signal = AbortSignal.any([ownerSignal, budget]);
  signal.throwIfAborted();
  const failure = (error: unknown): unknown => {
    if (ownerSignal.aborted) {
      // The owner's reason (a lost claim, worker shutdown) is never a Gateway failure.
      return ownerSignal.reason ?? error;
    }
    if (budget.aborted) {
      return new TransientDependencyError(
        "agent_gateway",
        "timeout",
        "The Agent Gateway did not answer within its connection budget.",
        { cause: error },
      );
    }
    return transientGatewayFailure(error) ?? error;
  };
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
    let connected: GatewayHello;
    try {
      connected = await hello;
    } catch (error) {
      throw failure(error);
    }
    if (connected.auth?.role !== "operator" || !connected.auth.scopes?.includes("operator.admin")) {
      throw new Error("Node enrollment requires the Gateway administrative service identity.");
    }
    try {
      return await operation(client, signal);
    } catch (error) {
      throw failure(error);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}
