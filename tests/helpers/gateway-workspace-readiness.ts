import { waitFor } from "./wait-for.mjs";

// A ready replacement Pod can still be enrolling its workspace node at Gateway.
// Retry only that explicit protocol state; authentication and other failures stay fatal.
export function waitForWorkspaceReconnect<T>(
  read: () => T | undefined | PromiseLike<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  let sawDisconnect = false;
  return waitFor<T>(
    () => `workspace node reconnection${sawDisconnect ? ": node not connected (UNAVAILABLE)" : ""}`,
    async () => {
      try {
        return await read();
      } catch (error: unknown) {
        const failure = isPropertyBearing(error) ? error.cause : undefined;
        if (
          !isPropertyBearing(failure) ||
          failure.type !== "gateway_request_error" ||
          failure.code !== "UNAVAILABLE" ||
          (failure.message !== "node not connected" &&
            failure.message !== "GatewayClientRequestError: node not connected: code=UNAVAILABLE")
        ) {
          throw error;
        }
        sawDisconnect = true;
        return undefined;
      }
    },
    { timeoutMs, intervalMs: 750 },
  );
}

function isPropertyBearing(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
