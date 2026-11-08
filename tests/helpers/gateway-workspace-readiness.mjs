import { waitFor } from "./wait-for.mjs";

// A ready replacement Pod can still be enrolling its workspace node at Gateway.
// Retry only that explicit protocol state; authentication and other failures stay fatal.
export function waitForWorkspaceReconnect(read, timeoutMs = 60_000) {
  let lastError;
  return waitFor(
    () => `workspace node reconnection${lastError ? ": node not connected (UNAVAILABLE)" : ""}`,
    async () => {
      try {
        return await read();
      } catch (error) {
        const failure = error?.cause;
        if (
          failure?.type !== "gateway_request_error" ||
          failure.code !== "UNAVAILABLE" ||
          (failure.message !== "node not connected" &&
            failure.message !== "GatewayClientRequestError: node not connected: code=UNAVAILABLE")
        ) {
          throw error;
        }
        lastError = error;
        return undefined;
      }
    },
    { timeoutMs, intervalMs: 750 },
  );
}
