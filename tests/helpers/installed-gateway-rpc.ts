import { asRecord } from "../../packages/utils/src/index.ts";

export function installedGatewayRpc(
  execNode: (script: string) => Promise<string>,
  defaultTimeoutMs: number,
) {
  async function call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = defaultTimeoutMs,
  ): Promise<unknown> {
    // The CLI authenticates from the Pod's environment and configuration.
    const result: unknown = JSON.parse(
      await execNode(`
    const { execFileSync } = require("node:child_process");
    try {
      process.stdout.write(execFileSync(process.execPath, ["/app/openclaw.mjs", "gateway", "call",
      ${JSON.stringify(method)}, "--params", ${JSON.stringify(JSON.stringify(params))},
      "--json", "--timeout", ${JSON.stringify(String(timeoutMs))}], { encoding: "utf8", timeout: ${timeoutMs + 30_000} }));
    } catch (error) {
      if (error.status !== 1 || error.signal !== null) throw error;
      let failure;
      try {
        failure = JSON.parse(error.stdout);
      } catch {
        throw error;
      }
      if (failure?.ok !== false || failure.error?.type !== "gateway_request_error") throw error;
      process.stdout.write(JSON.stringify(failure));
    }
  `),
    );
    const reply = asRecord(result);
    const failure = asRecord(reply?.error);
    if (reply?.ok === false && failure?.type === "gateway_request_error") {
      throw new Error(String(failure.message ?? ""), { cause: failure });
    }
    return result;
  }

  async function readAvailableHistory(sessionKey: string, limit = 30) {
    try {
      return await call("chat.history", { sessionKey, limit });
    } catch (error) {
      const failure = asRecord(asRecord(error)?.cause);
      if (
        failure?.type === "gateway_request_error" &&
        failure.code === "UNAVAILABLE" &&
        failure.retryable === true &&
        asRecord(failure.details)?.method === "chat.history"
      ) {
        // Startup can still be preparing history after the Pod becomes ready.
        return undefined;
      }
      throw error;
    }
  }

  return { call, readAvailableHistory };
}
