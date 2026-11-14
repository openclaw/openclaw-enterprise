import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { OpenShellBackendConfiguration } from "../../packages/contracts/src/index.ts";
import { relaySockets } from "../helpers/socket-relay.ts";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  boundPort,
} from "./openshell-gateway-wire-fixture.ts";

export function registerConnectCases(): void {
  test("OpenShell HTTP origins keep port 80 in native gRPC connections", async (t) => {
    const server = new grpc.Server();
    let healthCalls = 0;
    addWireService(
      server,
      {
        Health(_call, callback) {
          healthCalls += 1;
          callback(null, { status: "SERVICE_STATUS_HEALTHY" });
        },
      },
      "health",
    );
    const port = await bindWireServer(server);
    const targets: (string | undefined)[] = [];
    const sockets = new Set<Duplex>();
    const proxy = createServer();
    const track = (socket: Duplex) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      return socket;
    };
    // A real CONNECT tunnel avoids privileged listening ports. It accepts only
    // the configured authorities and forwards their actual gRPC bytes to the peer.
    proxy.on("connect", (request, socket, head) => {
      targets.push(request.url);
      track(socket);
      if (
        request.url !== "gateway.example.test:80" &&
        request.url !== "gateway.example.test:7777"
      ) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = track(
        connect(port, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        }),
      );
      // Bytes the client sent after CONNECT go first; the socket queues them until connected.
      if (head.length > 0) {
        upstream.write(head);
      }
      relaySockets(socket, upstream);
    });
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await shutdownWireServer(server);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const childEntry = fileURLToPath(
      new URL("../fixtures/openshell-gateway-proxy-child.ts", import.meta.url),
    );
    const cases: readonly [OpenShellBackendConfiguration, string][] = [
      [{ endpoint: "gateway.example.test:80" }, "gateway.example.test:80"],
      [{ endpoint: "http://gateway.example.test:80" }, "gateway.example.test:80"],
      [{ endpoint: "http://gateway.example.test" }, "gateway.example.test:80"],
      [
        { serviceName: "gateway.example.test", scheme: "http", port: 80 },
        "gateway.example.test:80",
      ],
      [{ endpoint: "http://gateway.example.test:7777" }, "gateway.example.test:7777"],
    ];
    for (const [configuration, target] of cases) {
      const before = targets.length;
      const child = spawn(
        process.execPath,
        [childEntry, JSON.stringify({ ...configuration, requestTimeoutMs: 1000 })],
        {
          env: { PATH: process.env.PATH, grpc_proxy: `http://127.0.0.1:${boundPort(proxy)}` },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        assert.equal(await closed, 0, stderr);
        assert.equal(stdout, "healthy\n");
        assert.deepEqual(targets.slice(before), [target]);
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await closed;
      }
    }
    assert.equal(healthCalls, 5);
  });
}
