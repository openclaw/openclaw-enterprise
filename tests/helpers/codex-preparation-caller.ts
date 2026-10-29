import { once } from "node:events";
import { createRequire } from "node:module";
import vm from "node:vm";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
const WebSocket = socketRequire("ws");

type Request = (method: string, params: unknown) => Promise<unknown>;
type RequestError = new (method: string, message: string) => Error;

export function generatedPreparation(env: Record<string, string | undefined>) {
  const context = vm.createContext({
    process: { env },
    require: socketRequire,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
  });
  return vm.runInContext(
    PLUGIN_RUNTIME_HELPERS +
      "\n({ installCodexPlugins, codexAppServerRequest, CodexAppServerRequestError })",
    context,
  ) as {
    installCodexPlugins: (
      runtime: unknown,
      failures: unknown[],
      request?: unknown,
    ) => Promise<unknown>;
    codexAppServerRequest: Request;
    CodexAppServerRequestError: RequestError;
  };
}

// Test client for the existing loopback protocol fixture. One authenticated
// connection carries every request, including concurrent metadata reads.
export function scopedPreparationCaller(
  port: number,
  credential: string,
  RequestError: RequestError,
) {
  let socket: InstanceType<typeof WebSocket> | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; method: string }
  >();

  function rejectPending() {
    for (const request of pending.values()) {
      request.reject(new Error("fixture connection closed"));
    }
    pending.clear();
  }

  function send(method: string, params: unknown): Promise<unknown> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  async function connect() {
    socket = new WebSocket("ws://127.0.0.1:" + port, {
      headers: { authorization: "Bearer " + credential },
      handshakeTimeout: 1000,
    });
    socket.on("close", rejectPending);
    socket.on("error", rejectPending);
    socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString());
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        request.reject(new RequestError(request.method, message.error.message));
      } else {
        request.resolve(message.result);
      }
    });
    await once(socket, "open");
    await send("initialize", {
      clientInfo: { name: "preparation-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  return {
    request: async (method: string, params: unknown) => {
      ready ??= connect();
      await ready;
      return send(method, params);
    },
    close: () => {
      socket?.terminate();
      rejectPending();
    },
  };
}
