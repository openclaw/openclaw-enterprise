import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dns, {
  type LookupAddress,
  type LookupAllOptions,
  type LookupOneOptions,
  type LookupOptions,
} from "node:dns";
import { connect, isIPv4 } from "node:net";
import { basename } from "node:path";
import { connect as connectTls } from "node:tls";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { availablePort } from "./available-port.ts";
import { withBoundedTeardown } from "./bounded-teardown.ts";
import {
  kubernetesHash as hash,
  type createKubernetesClient,
  type createRealKubernetesFixture,
} from "./kubernetes-real.ts";
import { startWorkspaceGatewayRelayContainer } from "./workspace-gateway-relay-container.ts";

type GatewayPlan = {
  routing: {
    hostname: string;
    envoyNamespace: string;
    gatewayNamespace: string;
    gatewayName: string;
  };
  apiPodLabels: Readonly<Record<string, string>>;
};

type KubernetesClient = ReturnType<typeof createKubernetesClient>;
type PortForward = ReturnType<typeof createRealKubernetesFixture>["startPortForwardTarget"];
type RelayDependencies = {
  kubectl(...args: Parameters<KubernetesClient["kubectl"]>): Promise<unknown>;
  resources: KubernetesClient["resources"];
  waitFor(label: string, observe: () => Promise<true | undefined>): Promise<unknown>;
  startPortForwardTarget: PortForward;
  gatewayImage: string;
};

const portNumber = Type.Integer({ minimum: 1, maximum: 65535 });
const serviceView = Type.Object({
  metadata: Type.Object({ name: Type.String({ minLength: 1 }) }),
  spec: Type.Object({
    clusterIP: Type.Optional(Type.String()),
    ports: Type.Optional(
      Type.Array(
        Type.Object({
          port: portNumber,
          protocol: Type.Optional(
            Type.Union([Type.Literal("TCP"), Type.Literal("UDP"), Type.Literal("SCTP")]),
          ),
          targetPort: Type.Optional(Type.Union([portNumber, Type.String({ minLength: 1 })])),
        }),
      ),
    ),
  }),
});

function httpsService(services: unknown[] | undefined) {
  assert.ok(Array.isArray(services), "Expected the Gateway's Kubernetes Service list.");
  for (const service of services) {
    assert.ok(
      Check(serviceView, service),
      "Invalid Kubernetes Service observation for the workspace Gateway.",
    );
    const https = service.spec.ports?.find(({ port }) => port === 443);
    if (https !== undefined) {
      const { clusterIP } = service.spec;
      assert.ok(
        clusterIP && isIPv4(clusterIP),
        "the disposable k3d Gateway must expose an IPv4 ClusterIP.",
      );
      return { name: service.metadata.name, clusterIP, https };
    }
  }
  assert.fail("the workspace Gateway must expose an Envoy HTTPS Service.");
}

type LookupError = NodeJS.ErrnoException | null;
type LookupOne = (error: LookupError, address: string, family: number) => void;
type LookupAll = (error: LookupError, addresses: LookupAddress[]) => void;
type LookupEither = (error: LookupError, address: string | LookupAddress[], family: number) => void;
type LookupAllCall = [hostname: string, options: LookupAllOptions, callback: LookupAll];
type LookupCall =
  | [hostname: string, callback: LookupOne]
  | [hostname: string, options: number | LookupOneOptions, callback: LookupOne]
  | LookupAllCall
  | [hostname: string, options: LookupOptions, callback: LookupEither];

function looksUpAllAddresses(args: LookupCall): args is LookupAllCall {
  const options = args[1];
  return typeof options === "object" && options?.all === true;
}

// Reflect forwards overload arguments without loosening the callback contract.
const applyLookup: (target: typeof dns.lookup, receiver: typeof dns, args: LookupCall) => unknown =
  Reflect.apply;

function redirectGatewayLookup(gatewayHostname: string): () => void {
  const originalLookup = dns.lookup;
  dns.lookup = new Proxy(originalLookup, {
    apply(target: typeof dns.lookup, _receiver: unknown, args: LookupCall): unknown {
      if (args[0] !== gatewayHostname) {
        // Forward the original overload arguments, including the caller's callback.
        return applyLookup(target, dns, args);
      }
      if (args.length === 2) {
        return args[1](null, "127.0.0.1", 4);
      }
      if (looksUpAllAddresses(args)) {
        return args[2](null, [{ address: "127.0.0.1", family: 4 }]);
      }
      return args[2](null, "127.0.0.1", 4);
    },
  });
  return () => {
    dns.lookup = originalLookup;
  };
}

// Host-run fixture workers need a TLS-preserving route to the private Gateway.
// This relay forwards bytes to the real Envoy listener and restores its scoped DNS override.
async function waitForLoopbackPort(port: number, waitFor: RelayDependencies["waitFor"]) {
  await waitFor("host-side Gateway routing relay", async () => {
    try {
      await new Promise<void>((resolve, reject: (reason: unknown) => void) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return true;
    } catch {
      return undefined;
    }
  });
}

async function waitForWorkspaceGatewayTls(
  hostname: string,
  port: number,
  waitFor: RelayDependencies["waitFor"],
) {
  await waitFor("host-side Gateway TLS path", async () => {
    try {
      await new Promise<void>((resolve, reject: (reason: unknown) => void) => {
        const socket = connectTls({ host: hostname, port, servername: hostname });
        const timeout = setTimeout(
          () => socket.destroy(new Error("Gateway TLS probe timed out.")),
          5_000,
        );
        timeout.unref();
        socket.once("secureConnect", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      return true;
    } catch {
      return undefined;
    }
  });
}

export async function startWorkspaceGatewayHostRelay(
  testContext: Parameters<typeof withBoundedTeardown>[0],
  { routing, apiPodLabels }: GatewayPlan,
  { kubectl, resources, waitFor, startPortForwardTarget, gatewayImage }: RelayDependencies,
): Promise<number> {
  const context = withBoundedTeardown(testContext, { label: "Workspace Gateway cleanup" });
  const usesContainerVm = process.platform === "darwin";
  const dockerRuntimeImage = process.env.OCC_DOCKER_RUNTIME_IMAGE ?? "";
  if (usesContainerVm) {
    assert.ok(
      dockerRuntimeImage,
      "OCC_DOCKER_RUNTIME_IMAGE is required for the loopback-only Gateway routing relay.",
    );
  }
  const { hostname, envoyNamespace, gatewayNamespace, gatewayName } = routing;
  assert.equal(typeof hostname, "string", "Gateway hostname must be configured.");
  assert.ok(hostname.trim().length > 0, "Gateway hostname must be nonempty.");
  const envoyService = httpsService(
    await resources(
      "services",
      envoyNamespace,
      "-l",
      `gateway.envoyproxy.io/owning-gateway-namespace=${gatewayNamespace},gateway.envoyproxy.io/owning-gateway-name=${gatewayName}`,
    ),
  );
  const relayPod = `oce-routing-relay-${hash(randomUUID())}`;
  const relayLabels = Object.entries(apiPodLabels)
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
  const inClusterRelayProgram = [
    'const net = require("node:net");',
    "const server = net.createServer((client) => {",
    `  const upstream = net.connect({ host: ${JSON.stringify(envoyService.clusterIP)}, port: 443 });`,
    "  client.pipe(upstream).pipe(client);",
    '  client.on("error", () => upstream.destroy());',
    '  upstream.on("error", () => client.destroy());',
    "});",
    'server.listen(8443, "0.0.0.0");',
  ].join("\n");
  await kubectl(
    "run",
    relayPod,
    "--namespace",
    gatewayNamespace,
    `--image=${gatewayImage}`,
    "--image-pull-policy=IfNotPresent",
    "--restart=Never",
    `--labels=${relayLabels}`,
    "--command",
    "--",
    "node",
    "-e",
    inClusterRelayProgram,
  );
  await kubectl(
    "wait",
    "--namespace",
    gatewayNamespace,
    "--for=condition=Ready",
    `pod/${relayPod}`,
    "--timeout=180s",
  );
  const forwarding = await startPortForwardTarget(gatewayNamespace, `pod/${relayPod}`, "0:8443");
  // Reuse kubectl's bound socket on Linux; a second listener would race other tests.
  context.after(() => forwarding.stop());
  const forwardedPort = Number(new URL(forwarding.url).port);
  assert.ok(
    Number.isInteger(forwardedPort) && forwardedPort > 0 && forwardedPort <= 65535,
    "The workspace Gateway port-forward must report its bound port.",
  );
  const endpointPort = usesContainerVm ? await availablePort() : forwardedPort;
  // In-cluster callers use the same endpoint port through the Envoy Service.
  const envoyHttpsPort = envoyService.https;
  await kubectl(
    "patch",
    "service",
    envoyService.name,
    "--namespace",
    envoyNamespace,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/spec/ports/-",
        value: {
          name: "oce-host-relay",
          protocol: envoyHttpsPort.protocol ?? "TCP",
          port: endpointPort,
          targetPort: envoyHttpsPort.targetPort ?? envoyHttpsPort.port,
        },
      },
    ]),
  );
  if (usesContainerVm) {
    // Docker Desktop and Podman Machine host networking stays in their Linux VM.
    const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
    const relayHost =
      basename(containerEngine) === "podman" ? "host.containers.internal" : "host.docker.internal";
    const relayName = `oce-openshell-routing-${hash(randomUUID())}`;
    const relayProgram = [
      'const net = require("node:net");',
      "const targetPort = Number(process.argv[1]);",
      "const server = net.createServer((client) => {",
      `  const upstream = net.connect({ host: ${JSON.stringify(relayHost)}, port: targetPort });`,
      "  client.pipe(upstream).pipe(client);",
      '  client.on("error", () => upstream.destroy());',
      '  upstream.on("error", () => client.destroy());',
      "});",
      'server.listen(443, "0.0.0.0");',
      'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    ].join("\n");
    await startWorkspaceGatewayRelayContainer(context, {
      containerEngine,
      relayName,
      runArguments: [
        "--publish",
        `127.0.0.1:${endpointPort}:443`,
        "--user",
        "0",
        "--stop-timeout",
        "2",
        "--entrypoint",
        "node",
        dockerRuntimeImage,
        "-e",
        relayProgram,
        String(forwardedPort),
      ],
    });
  }
  const requireForwarder = () => {
    if (forwarding.hasExited()) {
      throw new Error("The Gateway port-forward exited before relay readiness.");
    }
  };
  const waitForRelay: RelayDependencies["waitFor"] = (label, observe) =>
    waitFor(label, async () => {
      requireForwarder();
      const ready = await observe();
      requireForwarder();
      return ready;
    });
  context.after(redirectGatewayLookup(hostname));
  await waitForLoopbackPort(endpointPort, waitForRelay);
  await waitForWorkspaceGatewayTls(hostname, endpointPort, waitForRelay);
  return endpointPort;
}
