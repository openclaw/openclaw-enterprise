import assert from "node:assert/strict";
import dns from "node:dns";
import { once } from "node:events";
import { createServer, get } from "node:https";
import test, { type TestContext } from "node:test";
import { getCACertificates, setDefaultCACertificates, TLSSocket } from "node:tls";
import { selfSigned } from "../helpers/certificates.ts";
import { startWorkspaceGatewayHostRelay } from "../helpers/workspace-gateway-host-relay.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const options = { skip: process.platform !== "linux", timeout: 15_000 };

async function fixture(
  t: TestContext,
  { failPatch = false, failStop = false, stopAfterLoopback = false } = {},
) {
  const directory = await temporaryDirectory(t, "oce-host-route-");
  const material = await selfSigned(directory, {
    subjectAltName: "DNS:one.gateway.test,DNS:two.gateway.test",
  });
  const originalCertificates = getCACertificates("default");
  setDefaultCACertificates([...originalCertificates, material.cert]);
  t.after(() => setDefaultCACertificates(originalCertificates));
  const cleanup = new AsyncDisposableStack();
  t.after(() => cleanup.disposeAsync());
  const context = { after: (action: () => void | Promise<void>) => cleanup.defer(action) };

  async function route(
    hostname: string,
    {
      targetPort = 10443,
      malformedService = false,
    }: { targetPort?: number | string; malformedService?: boolean } = {},
  ) {
    const commands: string[][] = [];
    const patches: string[][] = [];
    const lookupsDuringStop: (typeof dns.lookup)[] = [];
    const server = createServer(material, (request, response) => {
      response.end(
        request.socket instanceof TLSSocket && request.socket.servername
          ? request.socket.servername
          : "",
      );
    });
    const stop = async () => {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    };
    // The fallback owns the fixture even when an assertion fails before helper cleanup.
    t.after(stop);
    let boundPort: number | undefined;
    const start = () =>
      startWorkspaceGatewayHostRelay(
        context,
        {
          routing: {
            hostname,
            envoyNamespace: "envoy-test",
            gatewayNamespace: "gateway-test",
            gatewayName: "agent-gateways",
          },
          apiPodLabels: { "app.kubernetes.io/name": "controller" },
        },
        {
          gatewayImage: "fixture-image",
          resources: async () => [
            {
              metadata: { name: "envoy-service" },
              spec: {
                clusterIP: "10.43.1.2",
                ports: [
                  {
                    port: 443,
                    protocol: "TCP",
                    targetPort: malformedService ? { port: targetPort } : targetPort,
                  },
                ],
              },
            },
          ],
          // This adapter observes Kubernetes commands; it does not simulate cluster routing.
          kubectl: async (...args: string[]) => {
            const [command] = args;
            assert.ok(command);
            commands.push(args);
            if (command === "patch") {
              patches.push(args);
              if (failPatch) {
                throw new Error("Service patch refused");
              }
            } else {
              assert.ok(["run", "wait"].includes(command));
            }
          },
          waitFor: async (label: string, observe: () => Promise<unknown>) => {
            assert.ok(await observe(), label);
            if (stopAfterLoopback && label === "host-side Gateway routing relay") {
              await stop();
            }
          },
          startPortForwardTarget: async (_namespace: string, _target: string, port: string) => {
            assert.equal(port, "0:8443");
            // A real bound TLS listener supplies the port-forward transport contract.
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            assert.ok(address && typeof address !== "string");
            boundPort = address.port;
            return {
              url: `http://127.0.0.1:${boundPort}`,
              hasExited: () => !server.listening,
              stop: async () => {
                lookupsDuringStop.push(dns.lookup);
                await stop();
                if (failStop) {
                  throw new Error("Forwarder shutdown failed");
                }
              },
            };
          },
        },
      );
    return { start, server, commands, patches, lookupsDuringStop, boundPort: () => boundPort };
  }
  return { route, cleanup };
}

async function readRoute(hostname: string, port: number) {
  return new Promise<string>((resolve, reject) => {
    const request = get({ hostname, port, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.once("end", () => resolve(body));
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

test(
  "Linux Gateway routes reuse distinct bound ports and preserve the HTTPS Service target",
  options,
  async (t) => {
    const { route, cleanup } = await fixture(t);
    const originalLookup = dns.lookup;
    const routes = [];
    for (const [hostname, targetPort] of [
      ["one.gateway.test", 10443],
      ["two.gateway.test", "https"],
    ] as const) {
      const current = await route(hostname, { targetPort });
      const port = await current.start();
      assert.ok(typeof port === "number");
      assert.equal(port, current.boundPort());
      const address = current.server.address();
      assert.ok(address && typeof address !== "string");
      assert.equal(address.address, "127.0.0.1");
      assert.equal(current.patches.length, 1);
      const [patch] = current.patches;
      assert.ok(patch);
      assert.deepEqual(patch.slice(0, -1), [
        "patch",
        "service",
        "envoy-service",
        "--namespace",
        "envoy-test",
        "--type=json",
        "--patch",
      ]);
      const payload = patch.at(-1);
      assert.ok(payload);
      assert.deepEqual(JSON.parse(payload), [
        {
          op: "add",
          path: "/spec/ports/-",
          value: {
            name: "oce-host-relay",
            protocol: "TCP",
            port,
            targetPort,
          },
        },
      ]);
      routes.push({ ...current, hostname, port, lookup: dns.lookup });
    }
    // Both listeners remain alive: a second route must not replace or steal the first.
    const [first, second] = routes;
    assert.ok(first && second);
    assert.notEqual(first.port, second.port);
    for (const current of routes) {
      assert.equal(await readRoute(current.hostname, current.port), current.hostname);
    }
    await cleanup.disposeAsync();
    assert.equal(dns.lookup, originalLookup);
    // Each route releases its DNS override before stopping its own forwarder.
    assert.deepEqual(first.lookupsDuringStop, [originalLookup]);
    assert.deepEqual(second.lookupsDuringStop, [first.lookup]);
    for (const current of routes) {
      assert.equal(current.server.listening, false);
    }
  },
);

test(
  "Gateway TLS readiness fails when its forwarder exits after loopback readiness",
  options,
  async (t) => {
    const { route, cleanup } = await fixture(t, { stopAfterLoopback: true });
    const originalLookup = dns.lookup;
    const current = await route("one.gateway.test");

    await assert.rejects(current.start(), {
      name: "Error",
      message: "The Gateway port-forward exited before relay readiness.",
    });
    await cleanup.disposeAsync();
    assert.equal(dns.lookup, originalLookup);
    assert.deepEqual(current.lookupsDuringStop, [originalLookup]);
  },
);

test(
  "Gateway Service mapping failure retains forwarder cleanup and reports shutdown failure",
  options,
  async (t) => {
    const { route, cleanup } = await fixture(t, { failPatch: true, failStop: true });
    const current = await route("one.gateway.test");
    await assert.rejects(current.start(), /Service patch refused/);
    assert.equal(current.server.listening, true);
    await assert.rejects(cleanup.disposeAsync(), /Forwarder shutdown failed/);
    assert.equal(current.server.listening, false);
  },
);

test(
  "Gateway relay rejects a malformed HTTPS Service target before starting a forwarder",
  options,
  async (t) => {
    const { route } = await fixture(t);
    const current = await route("one.gateway.test", { malformedService: true });
    await assert.rejects(current.start(), /Invalid Kubernetes Service observation/);
    assert.deepEqual(current.commands, []);
    assert.equal(current.boundPort(), undefined);
  },
);
