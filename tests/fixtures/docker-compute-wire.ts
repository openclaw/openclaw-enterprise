import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage, type RequestListener, type RequestOptions } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { AGENT_READINESS_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  withComputeAbortSignal,
  withComputeOperationDeadline,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type { Namespace } from "../../packages/contracts/src/index.ts";

const exec = promisify(execFile);

async function withLoopbackPeer(listener: RequestListener, run: (port: number) => Promise<void>) {
  const server = http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

async function withEnginePeer(
  listener: RequestListener,
  run: () => Promise<void>,
  observer?: { onRequest: () => void; onTransportError: (error: Error) => void },
) {
  await withLoopbackPeer(listener, async (port) => {
    const nativeRequest = http.request;
    http.request = (
      input: string | URL | RequestOptions,
      options?: RequestOptions | ((response: IncomingMessage) => void),
      callback?: (response: IncomingMessage) => void,
    ) => {
      if (typeof input === "string" || input instanceof URL) {
        return typeof options === "function"
          ? nativeRequest(input, options)
          : nativeRequest(input, options ?? {}, callback);
      }
      const receive = typeof options === "function" ? options : callback;
      assert.equal(input.socketPath, "/var/run/docker.sock");
      observer?.onRequest();
      const request = nativeRequest(
        { ...input, socketPath: undefined, host: "127.0.0.1", port },
        (response) => {
          if (observer) {
            response.once("error", observer.onTransportError);
          }
          receive?.(response);
        },
      );
      if (observer) {
        request.once("error", observer.onTransportError);
      }
      return request;
    };
    syncBuiltinESMExports();
    try {
      await run();
    } finally {
      http.request = nativeRequest;
      syncBuiltinESMExports();
    }
  });
}

async function requestCancellation() {
  let mode: "reset" | "timeout" | "caller" | "success" = "reset";
  let cancel: (() => void) | undefined;
  let transportError: Error | undefined;
  let nativeRequests = 0;
  let timeoutReceived: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  const paths: (string | undefined)[] = [];
  await withEnginePeer(
    (request, response) => {
      assert.equal(request.method, "GET");
      paths.push(request.url);
      if (request.url === "/_ping") {
        response.end("OK");
      } else if (request.url === "/version" && mode !== "success" && mode !== "caller") {
        if (mode === "timeout") {
          timeoutReceived = Date.now();
        }
        // A reset rejects promptly; an unfinished body reaches the real request deadline.
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        response.write('{"Platform":');
        if (mode === "reset") {
          setTimeout(() => response.destroy(), 10);
        }
      } else if (request.url === "/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ Platform: { Name: "Docker Engine" } }));
      } else {
        assert.equal(request.url, "/images/private-image-selection%3Alocal/json");
        if (mode === "caller") {
          // No response headers: exercise request error handling as well as the body stream.
          assert.ok(cancel);
          cancel();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }
    },
    async () => {
      try {
        const driver = new DockerComputeDriver({
          images: {
            gateway: "private-image-selection:local",
            agent: "private-image-selection:local",
          },
        });
        // Cancelling after entering the owner scope must not inspect or rewrite the raw reason.
        const selfCaused = new Error("original cancellation");
        selfCaused.cause = selfCaused;
        const accessorCause = new Error("original cancellation");
        Object.defineProperty(accessorCause, "cause", {
          get() {
            throw new Error("cause must not be read");
          },
        });
        for (const reason of [selfCaused, accessorCause]) {
          const controller = new AbortController();
          await assert.rejects(
            withComputeAbortSignal(controller.signal, () => {
              controller.abort(reason);
              return driver.preflight();
            }),
            (error: unknown) => {
              assert.equal(error, reason);
              assert.ok(error instanceof Error);
              assert.equal(error.message, "original cancellation");
              return true;
            },
          );
          assert.equal(nativeRequests, 0, "pre-aborted owner must not open an HTTP request");
        }
        const result = await Promise.race([
          driver.preflight().then(
            () => ({ status: "resolved" }),
            (error: unknown) => {
              assert.ok(error instanceof Error && "code" in error);
              return { status: "rejected", code: error.code };
            },
          ),
          new Promise<{ status: string }>((resolve) => {
            timer = setTimeout(() => resolve({ status: "pending" }), 1_500);
          }),
        ]);
        assert.equal(
          result.status,
          "rejected",
          "Docker preflight remained pending after an interrupted response",
        );
        assert.ok("code" in result);
        assert.equal(result.code, "ECONNRESET");
        clearTimeout(timer);

        mode = "timeout";
        const timeoutStarted = Date.now();
        await assert.rejects(driver.preflight(), (error: unknown) => {
          assert.ok(error instanceof Error && "code" in error);
          assert.equal(error, transportError, "preserve the original transport error");
          assert.equal(error.name, "AbortError");
          assert.equal(error.code, "ABORT_ERR");
          const cause = error.cause;
          assert.ok(typeof cause === "object" && cause !== null && "name" in cause);
          assert.equal(cause.name, "TimeoutError");
          const diagnostic =
            /^Docker GET version: request timeout after (\d+) ms \(request timeout 10000 ms; deadline ([^)]+)\)\.$/.exec(
              error.message,
            );
          assert.ok(diagnostic, error.message);
          assert.ok(Number(diagnostic[1]) >= 10_000);
          const deadlineText = diagnostic[2];
          assert.ok(deadlineText && timeoutReceived !== undefined);
          const deadline = Date.parse(deadlineText);
          assert.ok(deadline >= timeoutStarted + 10_000 - 100);
          assert.ok(deadline <= timeoutReceived + 10_000 + 100);
          return true;
        });

        mode = "caller";
        for (const reason of [new Error("private-owner-cancellation-detail"), NaN]) {
          const controller = new AbortController();
          const deadlineAt = new Date(Date.now() + 5_000).toISOString();
          cancel = () => controller.abort(reason);
          await assert.rejects(
            withComputeOperationDeadline({ signal: controller.signal, deadlineAt }, () =>
              driver.preflight(),
            ),
            (error: unknown) => {
              assert.ok(error instanceof Error && "code" in error);
              assert.equal(error, transportError, "do not replace the caller's transport error");
              assert.equal(error.code, "ABORT_ERR");
              assert.equal(error.name, "AbortError");
              assert.equal(error.cause, reason);
              assert.match(
                error.message,
                /^Docker GET image-inspect: caller cancellation after \d+ ms/,
              );
              assert.ok(error.message.includes("request timeout 10000 ms; deadline " + deadlineAt));
              assert.doesNotMatch(
                error.message,
                /private-image-selection|private-owner-cancellation-detail/,
              );
              return true;
            },
          );
        }

        // Failed calls must not leave the Driver cancelled: later qualification still succeeds.
        mode = "success";
        await driver.preflight();
        assert.deepEqual(paths, [
          "/_ping",
          "/version",
          "/_ping",
          "/version",
          "/_ping",
          "/version",
          "/images/private-image-selection%3Alocal/json",
          "/_ping",
          "/version",
          "/images/private-image-selection%3Alocal/json",
          "/_ping",
          "/version",
          "/images/private-image-selection%3Alocal/json",
          "/images/private-image-selection%3Alocal/json",
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    {
      onRequest() {
        nativeRequests += 1;
      },
      onTransportError(error) {
        transportError = error;
      },
    },
  );
}

async function responseLimit() {
  let interval: NodeJS.Timeout | undefined;
  let versionRequests = 0;
  let streamedBytes = 0;
  const limit = 4 * 1024 * 1024;
  await withEnginePeer(
    (request, response) => {
      if (request.url === "/_ping") {
        response.end("OK");
        return;
      }
      if (request.url?.startsWith("/images/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      assert.equal(request.url, "/version");
      versionRequests += 1;
      if (versionRequests === 3) {
        // Exactly at the cap, declared and sent: read whole.
        const empty = JSON.stringify({ Version: "27.0.0", Pad: "" });
        const body = empty.replace('"Pad":""', '"Pad":"' + "x".repeat(limit - empty.length) + '"');
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
        return;
      }
      if (versionRequests === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(4 * 1024 * 1024 + 1),
        });
        response.flushHeaders();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      interval = setInterval(() => {
        response.write(chunk);
        streamedBytes += chunk.length;
      }, 5);
    },
    async () => {
      try {
        const driver = new DockerComputeDriver({
          images: { gateway: "fixture:local", agent: "fixture:local" },
        });
        await assert.rejects(driver.preflight(), { message: "Docker API response is too large." });
        assert.equal(streamedBytes, 0);
        await assert.rejects(driver.preflight(), { message: "Docker API response is too large." });
        assert.ok(streamedBytes > 4 * 1024 * 1024, String(streamedBytes));
        assert.ok(streamedBytes < 6 * 1024 * 1024, String(streamedBytes));
        clearInterval(interval);
        await driver.preflight();
      } finally {
        clearInterval(interval);
      }
    },
  );
}

async function agentReadiness() {
  const require = createRequire(import.meta.url);
  const kubernetesRequire = createRequire(
    require.resolve("@kubernetes/client-node", {
      paths: [fileURLToPath(new URL("../../apps/controller", import.meta.url))],
    }),
  );
  const wsModules = dirname(dirname(kubernetesRequire.resolve("ws")));
  const missingMarkerDirectory = await mkdtemp(join(tmpdir(), "oce-docker-readiness-"));
  try {
    await withLoopbackPeer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        response.write('{"phase":"ready",');
        setTimeout(() => response.destroy(), 10);
      },
      async (port) => {
        await assert.rejects(
          exec(process.execPath, ["-e", AGENT_READINESS_ENTRYPOINT], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_PATH: wsModules,
              OPENCLAW_PLUGIN_STATUS_PORT: String(port),
              OPENCLAW_AGENT_REVISION_ID: "rev_interrupted_status",
              APP_SERVER_TOKEN: "synthetic-token",
              APP_SERVER_PORT: "1",
            },
            encoding: "utf8",
            timeout: 5_000,
          }),
          (error: unknown) => {
            assert.ok(
              error instanceof Error && "code" in error && "stderr" in error && "stdout" in error,
            );
            assert.equal(error.code, 1);
            assert.equal(error.stderr, "");
            assert.equal(error.stdout, "plugin runtime status unavailable: ECONNRESET\n");
            return true;
          },
        );
        await assert.rejects(
          exec(process.execPath, ["-e", AGENT_READINESS_ENTRYPOINT], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_PATH: wsModules,
              OPENCLAW_PLUGIN_READY_MARKER: join(missingMarkerDirectory, "ready"),
              OPENCLAW_RUNTIME_STATUS_PORT: String(port),
            },
            encoding: "utf8",
            timeout: 5_000,
          }),
          (error: unknown) => {
            assert.ok(
              error instanceof Error && "code" in error && "stderr" in error && "stdout" in error,
            );
            assert.equal(error.code, 1);
            assert.equal(error.stderr, "");
            assert.equal(error.stdout, "plugin ready marker is missing\n");
            return true;
          },
        );
      },
    );
  } finally {
    await rm(missingMarkerDirectory, { recursive: true, force: true });
  }
}

async function namespaceDeletion() {
  const labels = {
    "org.openclaw.enterprise.managed": "true",
    "org.openclaw.enterprise.compute-driver": "docker",
    "org.openclaw.enterprise.namespace-id": "ns_vanish",
  };
  let deleteStatus = 204;
  const requests: string[] = [];
  await withEnginePeer(
    (request, response) => {
      const path = request.url?.split("?")[0];
      assert.ok(path);
      requests.push(request.method + " " + path);
      const send = (status: number, body?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (request.method === "GET" && path.startsWith("/networks/")) {
        return send(200, { Labels: labels });
      }
      if (request.method === "DELETE" && path.startsWith("/networks/")) {
        return deleteStatus === 204
          ? send(204)
          : send(deleteStatus, { message: "network " + deleteStatus });
      }
      if (request.method === "GET" && path === "/containers/json") {
        return send(200, []);
      }
      if (request.method === "GET" && path === "/volumes") {
        return send(200, { Volumes: [] });
      }
      send(500, { message: "unexpected " + request.method + " " + path });
    },
    async () => {
      const driver = new DockerComputeDriver({
        images: { gateway: "gateway:local", agent: "agent:local" },
      });
      const namespace: Namespace = {
        id: "ns_vanish",
        name: "Vanishing network",
        status: "deleting",
        createdAt: "2026-09-01T00:00:00.000Z",
      };
      const deleted = { namespaceId: namespace.id, namespaceDeleted: true };
      const kept = { namespaceId: namespace.id, namespaceDeleted: false };
      const cases = [
        [204, deleted],
        // Engine already removed the network between inspect and DELETE.
        [404, deleted],
        [409, { ...kept, failure: "permanent" }],
        [500, { ...kept, failure: "retryable" }],
      ] as const;
      for (const [status, outcome] of cases) {
        deleteStatus = status;
        requests.length = 0;
        const actual = await driver.deleteNamespace(namespace);
        const network = "/networks/oce-ns-vanish-477d365e7f8f";
        assert.deepEqual(
          requests,
          [`GET ${network}`, "GET /containers/json", "GET /volumes", `DELETE ${network}`],
          String(status),
        );
        assert.deepEqual(actual, outcome, String(status));
      }
    },
  );
}

switch (process.argv[2]) {
  case "cancellation":
    await requestCancellation();
    break;
  case "response-limit":
    await responseLimit();
    break;
  case "readiness":
    await agentReadiness();
    break;
  case "namespace-delete":
    await namespaceDeletion();
    break;
  default:
    assert.fail("Select a Docker conformance wire case");
}
