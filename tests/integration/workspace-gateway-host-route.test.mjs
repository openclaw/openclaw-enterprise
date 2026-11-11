import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:https";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { selfSigned } from "../helpers/certificates.mjs";
import { startWorkspaceGatewayHostRelay } from "../helpers/envoy-workspace-gateway.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const options = { skip: process.platform !== "linux", timeout: 15_000 };

async function fixture(t, { failPatch = false, failStop = false } = {}) {
  const directory = await temporaryDirectory(t, "oce-host-route-");
  const material = await selfSigned(directory, {
    subjectAltName: "DNS:one.gateway.test,DNS:two.gateway.test",
  });
  const originalCertificates = getCACertificates("default");
  setDefaultCACertificates([...originalCertificates, material.cert]);
  t.after(() => setDefaultCACertificates(originalCertificates));
  const cleanup = new AsyncDisposableStack();
  t.after(() => cleanup.disposeAsync());
  const context = { after: (action) => cleanup.defer(action) };

  async function route(hostname) {
    const patches = [];
    const server = createServer(material, (request, response) => {
      assert.equal(request.socket.servername, hostname);
      response.end(hostname);
    });
    const stop = async () => {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    };
    // The fallback owns the fixture even when an assertion fails before helper cleanup.
    t.after(stop);
    let boundPort;
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
                ports: [{ port: 443, protocol: "TCP", targetPort: 10443 }],
              },
            },
          ],
          // This adapter observes Kubernetes commands; it does not simulate cluster routing.
          kubectl: async (...args) => {
            if (args[0] === "patch") {
              patches.push(args);
              if (failPatch) {
                throw new Error("Service patch refused");
              }
            } else {
              assert.ok(["run", "wait"].includes(args[0]));
            }
          },
          waitFor: async (label, observe) => assert.ok(await observe(), label),
          startPortForwardTarget: async (_namespace, _target, port) => {
            assert.equal(port, "0:8443");
            // A real bound TLS listener supplies the port-forward transport contract.
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            boundPort = server.address().port;
            return {
              url: `http://127.0.0.1:${boundPort}`,
              stop: async () => {
                await stop();
                if (failStop) {
                  throw new Error("Forwarder shutdown failed");
                }
              },
            };
          },
        },
      );
    return { start, server, patches, boundPort: () => boundPort };
  }
  return { route, cleanup };
}

async function readRoute(hostname, port) {
  return new Promise((resolve, reject) => {
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
    const routes = [];
    for (const hostname of ["one.gateway.test", "two.gateway.test"]) {
      const current = await route(hostname);
      const port = await current.start();
      assert.equal(port, current.boundPort());
      assert.equal(current.server.address().address, "127.0.0.1");
      assert.equal(current.patches.length, 1);
      const [patch] = current.patches;
      assert.deepEqual(patch.slice(0, -1), [
        "patch",
        "service",
        "envoy-service",
        "--namespace",
        "envoy-test",
        "--type=json",
        "--patch",
      ]);
      assert.deepEqual(JSON.parse(patch.at(-1)), [
        {
          op: "add",
          path: "/spec/ports/-",
          value: {
            name: "oce-host-relay",
            protocol: "TCP",
            port,
            targetPort: 10443,
          },
        },
      ]);
      routes.push({ ...current, hostname, port });
    }
    // Both listeners remain alive: a second route must not replace or steal the first.
    assert.notEqual(routes[0].port, routes[1].port);
    for (const current of routes) {
      assert.equal(await readRoute(current.hostname, current.port), current.hostname);
    }
    await cleanup.disposeAsync();
    for (const current of routes) {
      assert.equal(current.server.listening, false);
    }
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
