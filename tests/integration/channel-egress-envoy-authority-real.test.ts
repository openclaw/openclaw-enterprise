import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  CHANNEL_EGRESS_IMAGE,
  channelEgressFilterChain,
} from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";
import { availablePort } from "../helpers/available-port.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";

async function request(port: number, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(5_000, () => socket.destroy(new Error("CONNECT timed out.")));
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    socket.once("data", (data) => {
      socket.destroy();
      const status = /^HTTP\/1\.[01] ([0-9]{3}) /u.exec(data.toString("ascii"));
      if (!status) {
        reject(new Error("Envoy returned no HTTP status."));
        return;
      }
      resolve(Number(status[1]));
    });
  });
}

test(
  "pinned channel Envoy enforces CIDR authority membership and excluded final-IP literals before an upstream proxy",
  {
    skip:
      process.env.OCC_TEST_CHANNEL_ENVOY_REAL === "1"
        ? false
        : "Select the pinned channel Envoy Docker proof.",
    timeout: 180_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-channel-envoy-authority-"));
    await chmod(directory, 0o755);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const observed: string[] = [];
    const sockets = new Set<Socket>();
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let bytes = "";
      socket.on("data", (chunk) => {
        bytes += chunk.toString("ascii");
        if (!bytes.includes("\r\n\r\n")) {
          return;
        }
        observed.push(bytes.split("\r\n", 1)[0]!);
        socket.removeAllListeners("data");
        socket.end("HTTP/1.1 200 Connection established\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const port = await availablePort();
    const options = {
      gatewayName: "fleet",
      gatewayNamespace: "platform",
      envoyNamespace: "envoy",
      serviceName: "fleet",
      listenerPortStart: 10001,
      listenerPortEnd: 10001,
      occListenerPort: 10000,
      inspectionPort: 19004,
      excludedCidrs: ["11.42.0.0/16"],
    };
    // The upstream is a controlled loopback fixture. No asserted final destination is contacted.
    const chain = channelEgressFilterChain(
      "authority-proof",
      [
        { destination: { kind: "cidr", cidr: "8.8.8.128/25" }, ports: [443] },
        { destination: { kind: "cidr", cidr: "10.0.0.0/8" }, ports: [443] },
        { destination: { kind: "cidr", cidr: "11.0.0.0/8" }, ports: [443] },
        { destination: { kind: "ip", address: "169.254.169.254" }, ports: [80] },
        { destination: { kind: "dns", name: "0xa9fea9fe", match: "exact" }, ports: [80] },
        { destination: { kind: "dns", name: "0xa9.0xfe.0xa9.0376", match: "exact" }, ports: [80] },
        { destination: { kind: "dns", name: "0xa.0x.0x.1", match: "exact" }, ports: [443] },
      ],
      options,
      { clusterName: "selected-proxy", addresses: ["127.0.0.1"], port: address.port },
    );
    const config = {
      node: { id: "authority-proof", cluster: "authority-proof" },
      static_resources: {
        listeners: [
          {
            name: "agent",
            address: { socket_address: { address: "127.0.0.1", port_value: port } },
            filter_chains: [chain],
          },
        ],
        clusters: [
          {
            name: "selected-proxy",
            type: "STATIC",
            connect_timeout: "1s",
            load_assignment: {
              cluster_name: "selected-proxy",
              endpoints: [
                {
                  lb_endpoints: [
                    {
                      endpoint: {
                        address: {
                          socket_address: { address: "127.0.0.1", port_value: address.port },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const file = join(directory, "envoy.json");
    await writeFile(file, JSON.stringify(config), { mode: 0o644 });
    const name = `oce-channel-authority-${randomUUID()}`;
    t.after(() => runDocker(["rm", "-f", name]).catch(() => undefined));
    await runDocker([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      "--mount",
      `type=bind,src=${file},dst=/etc/envoy/authority.json,readonly`,
      CHANNEL_EGRESS_IMAGE,
      "-c",
      "/etc/envoy/authority.json",
      "--log-level",
      "warning",
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await request(port, "not-allowed.example:443");
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(ready, "Pinned Envoy did not start with the product filter chain.");
    // Allowed CIDR members reach only the selected proxy; neighbors, excluded intersections,
    // metadata literals, and wrong ports must fail before the proxy sees a request.
    for (const [authority, status] of [
      ["8.8.8.129:443", 200],
      ["11.43.0.7:443", 200],
      ["8.8.8.127:443", 403],
      ["1.1.1.1:443", 403],
      ["10.1.2.3:443", 403],
      ["11.42.0.7:443", 403],
      ["169.254.169.254:80", 403],
      ["0xa9fea9fe:80", 403],
      ["0xA9FeA9Fe:80", 403],
      ["0251.0376.0251.0376:80", 403],
      ["169.254.43518:80", 403],
      ["2852039166:80", 403],
      ["0xa9.0xfe.0xa9.0376:80", 403],
      ["0xa.0x.0x.1:443", 403],
      ["8.8.8.129:80", 403],
    ] as const) {
      const before = observed.length;
      assert.equal(await request(port, authority), status, authority);
      assert.equal(observed.length - before, status === 200 ? 1 : 0, `${authority} proxy contact`);
    }
  },
);
