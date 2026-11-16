// Runtime image cases split from runtime-image-startup.test.ts, whose cases run
// one after another, so CI can run them on another lane: the pinned Gateway
// proves why Compute admission refuses native listener TLS and binds that
// cannot serve Pod-IP traffic.
import type { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { plaintextGatewayComputeDrivers } from "../helpers/plaintext-gateway-compute.ts";
import assert from "node:assert/strict";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { randomBytes } from "node:crypto";
import { copyFile, chmod, readFile, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import test from "node:test";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { isStringArray, type ProxyRequest } from "../fixtures/runtime-native-trusted-proxy.mts";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { runDocker, commandOutput, failureTail } from "../helpers/runtime-image-docker.ts";
import { waitForContainerReady } from "../helpers/runtime-image-gateway-observations.ts";
import {
  image,
  imageTestOptions,
  createAdmittedRuntimeImageConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.ts";
import { eachSettled } from "../helpers/child-processes.mjs";

type BindSettings = {
  bind?: "loopback" | "custom" | "tailnet" | "lan" | "auto";
  customBindHost?: string;
};
type ScopeExpectation =
  | { status: number; body?: RegExp; nativeSessions?: boolean; scopes?: never }
  | { status: "hello"; scopes: string[]; body?: never; nativeSessions?: never }
  | {
      status: "connect-error" | "operation-ok" | "operation-denied";
      body?: RegExp;
      scopes?: never;
      nativeSessions?: never;
    };
type ScopeCase = [
  label: string,
  auth: OpenClawConfigurationDocument,
  adjust: ((configuration: OpenClawConfigurationDocument) => void) | undefined,
  requests: Array<[ProxyRequest, ScopeExpectation]>,
];

function isConfigurationValue(value: unknown): value is OpenClawConfigurationValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isConfigurationValue);
  }
  return isConfigurationDocument(value);
}

function isConfigurationDocument(value: unknown): value is OpenClawConfigurationDocument {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every(isConfigurationValue);
}

function renderNativeGateway(
  driver: KubernetesComputeDriver,
  input: OpenClawConfigurationDocument,
): OpenClawConfigurationDocument {
  // The production renderer is private, so its emitted declaration has no signature.
  const output: unknown = driver["kubernetesGatewayConfigurationDocument"](input);
  assert.ok(isConfigurationDocument(output), "Expected a rendered Gateway configuration document");
  return output;
}

function gatewaySettings(configuration: Readonly<Record<string, unknown>>) {
  const gateway = asRecord(configuration.gateway);
  assert.ok(gateway, "Missing rendered Gateway settings");
  return gateway;
}

function trustedProxySettings(configuration: Readonly<Record<string, unknown>>) {
  const trustedProxy = asRecord(asRecord(gatewaySettings(configuration).auth)?.trustedProxy);
  assert.ok(trustedProxy, "Missing rendered trusted-proxy settings");
  return trustedProxy;
}

function setCountingProvider(configuration: Readonly<Record<string, unknown>>, apiKey: string) {
  const model = asRecord(asRecord(asRecord(configuration.models)?.providers)?.openai);
  assert.ok(model, "Missing rendered OpenAI provider");
  model.baseUrl = "http://127.0.0.1:18880/v1";
  model.apiKey = apiKey;
}

function observations(json: string, count: number): unknown[] {
  const input: unknown = JSON.parse(json);
  assert.ok(Array.isArray(input), "Expected an observation array");
  assert.equal(input.length, count, "Unexpected observation count");
  return input;
}

async function containerIPv4(containerName: string, network: string) {
  const [inspected] = observations((await runDocker(["inspect", containerName])).stdout, 1);
  const networks = asRecord(asRecord(asRecord(inspected)?.NetworkSettings)?.Networks);
  const address = asRecord(networks?.[network])?.IPAddress;
  assert.ok(typeof address === "string" && isIPv4(address), "Missing container IPv4 address");
  return address;
}

// The loopback provider owns all possible requests; no model turn is sent.
const countingProvider = String.raw`
const http = require("node:http");
let modelCalls = 0;
http.createServer((req, res) => {
  if (req.method === "POST") modelCalls++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/counter" ? { modelCalls } : { data: [{ id: "fixture" }] }));
}).listen(18880, "127.0.0.1");
`;

// One docker exec polls the listener (see waitForContainerReady). The wait scales
// with the runner's CPUs: the lane's other files start runtimes at the same time
// (finding 2448). The 90 s base keeps the former limit: 80 probes of about 1 s each.
async function waitForListenerReady(containerName: string, request: string) {
  try {
    await waitForContainerReady(containerName, {
      label: "Listener",
      request,
      timeoutMs: cpuScaledImageTimeoutMs(90_000),
    });
  } catch (error) {
    const logs = await runDocker(["logs", containerName]).then(
      (result) => failureTail(commandOutput(result)),
      () => "Docker logs unavailable.",
    );
    assert.ok(error instanceof Error);
    error.message += `\nContainer logs:\n${logs}`;
    throw error;
  }
}

async function assertNoModelRequests(containerName: string) {
  const counter = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    'fetch("http://127.0.0.1:18880/counter").then(r=>r.json()).then(v=>console.log(v.modelCalls));',
  ]);
  assert.equal(counter.stdout.trim(), "0");
}

test(
  "runtime image refuses native listener TLS that cannot satisfy Compute HTTP readiness",
  imageTestOptions,
  async (t) => {
    const drivers = plaintextGatewayComputeDrivers();
    const directory = await temporaryDirectory(t, "oce-native-listener-tls-");
    // Each case owns its container and configuration file, so both run at once.
    await eachSettled([true, false], async (enabled) => {
      const configuration = renderNativeGateway(
        drivers[0][1],
        createAdmittedRuntimeImageConfiguration("openclaw"),
      );
      setCountingProvider(configuration, "synthetic-owned-native-tls");
      gatewaySettings(configuration).tls = {
        enabled,
        autoGenerate: true,
        certPath: "/home/node/tls/cert.pem",
        keyPath: "/home/node/tls/key.pem",
      };
      const path = join(directory, `configuration-${enabled}.json`);
      // The parent is private; this synthetic input must be readable by native
      // UID1000 even when a Linux runner writes it with a different UID.
      await writeFile(path, JSON.stringify(configuration), { mode: 0o644 });
      // Feed the original native input to the actual pinned Gateway to prove
      // why Compute refuses it; this is not a supported TLS deployment fixture.
      const { containerName } = await runGatewaySmoke(t, "openclaw", {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: countingProvider + KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
        volumes: [`${path}:/etc/openclaw/openclaw.json:ro`],
        waitUntilReady: false,
        withAppServer: false,
        extraEnvironment: [
          "OPENCLAW_RUNTIME_STATUS_PORT=18791",
          "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
          "OPENCLAW_AGENT_REVISION_ID=owned-native-tls",
          "OPENCLAW_POD_UID=owned-native-tls",
        ],
      });
      const computeReady = `async () => {
        const response = await fetch("http://127.0.0.1:18791/readyz", {signal: AbortSignal.timeout(5000)});
        if (await response.text() !== "") throw new Error("Compute readiness returned a body");
        return response.status;
      }`;
      if (enabled) {
        // Both native endpoints must serve HTTPS before a Compute 503 can be attributed to TLS.
        const nativeReady = `async () => {
          const options = {hostname: "127.0.0.1", port: 8080, servername: "openclaw-gateway",
            ca: require("node:fs").readFileSync("/home/node/tls/cert.pem"), timeout: 5000};
          const statuses = await Promise.all(["/startupz", "/readyz"].map(path => new Promise((resolve, reject) => {
            const request = require("node:https").get({...options, path}, response => {
              response.resume();
              resolve(response.statusCode);
            });
            request.on("error", reject).on("timeout", () => request.destroy(new Error("timeout")));
          })));
          return statuses.every(status => status === 200) ? 200 : 503;
        }`;
        await waitForListenerReady(containerName, nativeReady);
        const { stdout } = await runDocker([
          "exec",
          containerName,
          "node",
          "-e",
          `(${computeReady})().then(status => console.log(status));`,
        ]);
        assert.equal(stdout.trim(), "503");
        for (const [kind, driver] of drivers) {
          assert.throws(
            () => driver.validateGatewaySettings?.(configuration),
            /gateway\.tls\.enabled must be omitted or false/,
            kind,
          );
        }
      } else {
        await waitForListenerReady(
          containerName,
          '() => fetch("http://127.0.0.1:8080/readyz",{signal:AbortSignal.timeout(5000)}).then(r=>r.status)',
        );
        await waitForListenerReady(containerName, computeReady);
        for (const [, driver] of drivers) {
          assert.doesNotThrow(() => driver.validateGatewaySettings(configuration));
        }
      }
      await assertNoModelRequests(containerName);
      t.diagnostic(
        `native TLS enabled=${enabled}: native ready, Compute readiness ${enabled ? "refused" : "passed"}, modelCalls=0`,
      );
      await runDocker(["rm", "-f", containerName]);
    });
  },
);

test(
  "runtime image Kubernetes admission refuses healthy native listeners that cannot serve Pod-IP traffic",
  imageTestOptions,
  async (t) => {
    const driver = plaintextGatewayComputeDrivers()[0][1];
    const network = `oce-native-bind-${randomBytes(6).toString("hex")}`;
    await runDocker(["network", "create", "--internal", network]);
    const runtimeCleanups: Array<() => unknown> = [];
    t.after(async () => {
      for (const cleanup of runtimeCleanups.reverse()) {
        await cleanup();
      }
      await runDocker(["network", "rm", network]);
    });
    const directory = await temporaryDirectory(t, "oce-native-bind-");
    // Each case owns its container and configuration file, so the cases run
    // concurrently on the shared internal network.
    const bindCases: ReadonlyArray<[BindSettings, boolean]> = [
      [{ bind: "loopback" }, false],
      [{ bind: "custom", customBindHost: "127.0.0.1" }, false],
      [{ bind: "tailnet" }, false],
      [{ bind: "lan" }, true],
      [{ bind: "auto" }, true],
      [{ bind: "custom", customBindHost: "0.0.0.0" }, true],
      [{}, true],
    ];
    await eachSettled(bindCases, async ([gateway, reachable], index) => {
      const configuration = renderNativeGateway(
        driver,
        createAdmittedRuntimeImageConfiguration("openclaw"),
      );
      const renderedGateway = gatewaySettings(configuration);
      delete renderedGateway.bind;
      Object.assign(renderedGateway, gateway);
      setCountingProvider(configuration, "synthetic-owned-native-bind");
      const path = join(directory, `openclaw-${index}.json`);
      // Private directory, read-only mount, synthetic input readable by native UID1000.
      await writeFile(path, JSON.stringify(configuration), { mode: 0o644 });
      // Feed native-valid inputs independently of admission to establish which
      // healthy listeners cannot serve the actual Service-facing address.
      const { containerName } = await runGatewaySmoke(
        { after: (cleanup) => runtimeCleanups.push(cleanup) },
        "openclaw",
        {
          configurationPath: "/etc/openclaw/openclaw.json",
          entrypoint: countingProvider + KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
          network,
          volumes: [`${path}:/etc/openclaw/openclaw.json:ro`],
          waitUntilReady: false,
          withAppServer: false,
          extraEnvironment: [
            "OPENCLAW_GATEWAY_PASSWORD=synthetic-owned-native-password",
            "OPENCLAW_RUNTIME_STATUS_PORT=18791",
            "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
            "OPENCLAW_AGENT_REVISION_ID=owned-native-bind",
            "OPENCLAW_POD_UID=owned-native-bind",
          ],
        },
      );
      await waitForListenerReady(
        containerName,
        '() => fetch("http://127.0.0.1:18791/readyz",{signal:AbortSignal.timeout(5000)}).then(r=>r.status)',
      );
      const address = await containerIPv4(containerName, network);
      // One container on the network polls both ports until the status listener
      // answers 200 and the native port settles (200 or refused). The status
      // readiness asks the native Gateway with 2 s limits, so on a CPU-starved
      // runner it can answer 503 once just after the private probe saw 200
      // (finding 2468); a Kubernetes readiness probe retries the same way.
      const remoteBudgetMs = cpuScaledImageTimeoutMs(15_000);
      const remote = await runDocker(
        [
          "run",
          "--rm",
          "--pull=never",
          "--network",
          network,
          "-i",
          "--entrypoint",
          "node",
          image,
          "--input-type=module-typescript",
          "-",
          String(remoteBudgetMs),
          address,
          String(reachable),
        ],
        { timeout: remoteBudgetMs + 60_000 * imageSmokeTimeoutMultiplier },
        await readFile(new URL("../fixtures/runtime-native-listener-peer.mts", import.meta.url)),
      );
      const [native, status] = observations(remote.stdout, 2).map(asRecord);
      assert.ok(native);
      assert.ok(status);
      assert.equal(native.port, 8080);
      assert.equal(status.port, 18791);
      assert.equal(status.status, 200);
      if (reachable) {
        assert.equal(native.status, 200);
        assert.doesNotThrow(() => driver.validateGatewaySettings(configuration));
      } else {
        assert.equal(native.error, "ECONNREFUSED");
        assert.throws(
          () => driver.validateGatewaySettings(configuration),
          /gateway\.(bind|customBindHost)/,
        );
      }
      await assertNoModelRequests(containerName);
      t.diagnostic(
        `native bind=${gateway.bind ?? "omitted"} host=${gateway.customBindHost ?? "default"}: private ready=200, Pod-IP ${reachable ? "ready=200" : "ECONNREFUSED"}, modelCalls=0`,
      );
      await runDocker(["rm", "-f", containerName]);
    });
  },
);

// Native HTTP APIs ignore identityScopes: a trusted-proxy request without
// x-openclaw-scopes receives the pinned Gateway's default operator scopes, admin
// included. Compute requires it for human ingress and private routed access. The admin
// route sends operator.admin; chat sends operator.sessions.write for the same identity.
test(
  "runtime image Gateway enforces routed scope ceilings for HTTP and WebSocket",
  imageTestOptions,
  async (t) => {
    const driver = createTestKubernetesComputeDriver("native-chat-scopes", {
      gatewayRuntime: true,
    });
    const network = `oce-native-scopes-${randomBytes(6).toString("hex")}`;
    await runDocker(["network", "create", "--internal", network]);
    const runtimeCleanups: Array<() => unknown> = [];
    t.after(async () => {
      for (const cleanup of runtimeCleanups.reverse()) {
        await cleanup();
      }
      await runDocker(["network", "rm", network]);
    });
    const networkInspection = observations(
      (await runDocker(["network", "inspect", network])).stdout,
      1,
    );
    const ipam = asRecord(asRecord(networkInspection[0])?.IPAM);
    assert.ok(Array.isArray(ipam?.Config), "Missing network IPAM configuration");
    const subnet = asRecord(ipam.Config[0])?.Subnet;
    assert.ok(typeof subnet === "string", "Missing proxy network subnet");
    const [networkAddress, prefix, extra] = subnet.split("/");
    assert.ok(
      networkAddress &&
        isIPv4(networkAddress) &&
        prefix &&
        /^([0-9]|[12][0-9]|3[0-2])$/.test(prefix) &&
        extra === undefined,
      "Invalid proxy network IPv4 CIDR",
    );

    const directory = await temporaryDirectory(t, "oce-native-scopes-");
    const probePath = join(directory, "probe.mts");
    await copyFile(
      new URL("../fixtures/runtime-native-trusted-proxy.mts", import.meta.url),
      probePath,
    );
    await chmod(probePath, 0o644);
    const humanAuth = {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-occ-identity",
        allowUsers: ["occ-workspace-files", "oidc:member-01", "oidc:writer-02"],
      },
      identityScopes: {
        "occ-workspace-files": ["operator.admin"],
        "oidc:member-01": ["operator.read"],
        "oidc:writer-02": ["operator.read", "operator.write"],
      },
    };
    // HTTP: run kills stay admin-only upstream, so 404 means the scope check passed for a
    // session that does not exist, 403 names the missing scope and 401 is refused admission.
    // sessions_list also proves an allowed native operation on the same endpoint as
    // its missing-header/read-only denials; a missing-session 404 alone proves no I/O.
    // WebSocket: a refused proxy identity falls back to device authentication, which this
    // device-less operator connect cannot satisfy; "hello" carries the granted scopes.
    const scopeCases: readonly ScopeCase[] = [
      [
        "human admitted",
        humanAuth,
        undefined,
        [
          [{ identity: "oidc:member-01" }, { status: 401, body: /Unauthorized/ }],
          [
            { identity: "oidc:member-01", scopes: "operator.read" },
            { status: 403, body: /missing scope: operator\.admin/ },
          ],
          [{ identity: "occ-workspace-files" }, { status: 401, body: /Unauthorized/ }],
          [
            { identity: "occ-workspace-files", scopes: "operator.admin" },
            { status: 404, body: /Session not found/ },
          ],
          [
            {
              operation: "sessions_list",
              identity: "occ-workspace-files",
              scopes: "operator.admin",
            },
            { status: 200, nativeSessions: true },
          ],
          [
            {
              operation: "sessions_list",
              identity: "oidc:writer-02",
              scopes: "operator.read,operator.write",
            },
            { status: 200, nativeSessions: true },
          ],
          [
            { operation: "sessions_list", identity: "oidc:member-01" },
            { status: 401, body: /Unauthorized/ },
          ],
          [
            { operation: "sessions_list", identity: "oidc:member-01", scopes: "operator.read" },
            { status: 403, body: /missing scope: operator\.write/ },
          ],
          [
            { kind: "ws", identity: "occ-workspace-files" },
            { status: "connect-error", body: /DEVICE_IDENTITY_REQUIRED/ },
          ],
          [
            { kind: "ws", identity: "occ-workspace-files", scopes: "operator.admin" },
            { status: "hello", scopes: ["operator.admin"] },
          ],
          [
            { kind: "ws", identity: "oidc:member-01", scopes: "operator.read" },
            { status: "hello", scopes: ["operator.read"] },
          ],
        ],
      ],
      [
        "human admitted without the rendered requirement",
        humanAuth,
        (configuration) => {
          // The upstream default the requirement exists for: a read-only human acts as
          // owner on HTTP when the proxy omits the header, while WebSocket connects honour
          // identityScopes. Should an OpenClaw pin bump close this, drop this case and
          // reconsider the requirement rather than adjust the expectation.
          delete trustedProxySettings(configuration).requiredHeaders;
        },
        [
          [{ identity: "oidc:member-01" }, { status: 404, body: /Session not found/ }],
          [
            { identity: "oidc:member-01", scopes: "operator.read" },
            { status: 403, body: /missing scope: operator\.admin/ },
          ],
          [
            { operation: "sessions_list", identity: "oidc:member-01" },
            { status: 200, nativeSessions: true },
          ],
          [
            { operation: "sessions_list", identity: "oidc:member-01", scopes: "operator.read" },
            { status: 403, body: /missing scope: operator\.write/ },
          ],
          [
            { kind: "ws", identity: "oidc:member-01" },
            { status: "hello", scopes: ["operator.read"] },
          ],
        ],
      ],
      [
        "machine only",
        {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
        (configuration) => {
          gatewaySettings(configuration).controlUi = {
            enabled: true,
            allowedOrigins: ["https://agent.example.test"],
          };
        },
        [
          [
            {
              kind: "ws",
              paired: true,
              identity: "occ-workspace-files",
              scopes: "operator.sessions.write",
              method: "config.get",
            },
            { status: "operation-denied", body: /missing scope/ },
          ],
          [
            {
              kind: "ws",
              identity: "occ-workspace-files",
              scopes: "operator.sessions.write",
              password: "synthetic-owned-native-password",
              requestedScopes: ["operator.admin"],
              method: "config.get",
            },
            { status: "operation-denied", body: /missing scope/ },
          ],
          // The chat route uses the existing admin identity, but the scope header must cap
          // its authority even when a client asks for admin in its connect frame.
          [
            {
              kind: "ws",
              identity: "occ-workspace-files",
              scopes: "operator.sessions.write",
              requestedScopes: ["operator.admin"],
            },
            { status: "hello", scopes: ["operator.sessions.write"] },
          ],
          [
            {
              kind: "ws",
              identity: "occ-workspace-files",
              scopes: "operator.sessions.write",
              method: "sessions.list",
            },
            { status: "operation-ok" },
          ],
          [
            {
              kind: "ws",
              identity: "occ-workspace-files",
              scopes: "operator.sessions.write",
              method: "config.get",
            },
            { status: "operation-denied", body: /missing scope/ },
          ],
          [
            { identity: "occ-workspace-files", scopes: "operator.sessions.write" },
            { status: 403, body: /missing scope: operator\.admin/ },
          ],
          [
            {
              operation: "sessions_list",
              identity: "occ-workspace-files",
              scopes: "operator.sessions.write",
            },
            { status: 403, body: /missing scope: operator\.write/ },
          ],
          [{ identity: "occ-workspace-files" }, { status: 401, body: /Unauthorized/ }],
          [
            { identity: "occ-workspace-files", scopes: "operator.admin" },
            { status: 404, body: /Session not found/ },
          ],
          [
            { identity: "oidc:member-01", scopes: "operator.admin" },
            { status: 401, body: /Unauthorized/ },
          ],
          [
            { kind: "ws", identity: "occ-workspace-files" },
            { status: "connect-error", body: /DEVICE_IDENTITY_REQUIRED/ },
          ],
        ],
      ],
    ];
    await eachSettled(scopeCases, async ([label, auth, adjust, requests], index) => {
      // Admitted configurations are frozen; the auth block is this case's input.
      const input: OpenClawConfigurationDocument = structuredClone(
        createAdmittedRuntimeImageConfiguration("openclaw"),
      );
      const gateway = input.gateway;
      assert.ok(gateway && typeof gateway === "object" && !Array.isArray(gateway));
      const configuration = renderNativeGateway(driver, {
        ...input,
        gateway: { ...gateway, auth },
      });
      assert.deepEqual(trustedProxySettings(configuration).requiredHeaders, ["x-openclaw-scopes"]);
      // The probe container stands in for the proxy; Compute renders the Installation's
      // CIDRs, which cannot name this test network.
      gatewaySettings(configuration).trustedProxies = [subnet];
      adjust?.(configuration);
      setCountingProvider(configuration, "synthetic-owned-native-scopes");
      const path = join(directory, `openclaw-${index}.json`);
      await writeFile(path, JSON.stringify(configuration), { mode: 0o644 });
      const { containerName } = await runGatewaySmoke(
        { after: (cleanup) => runtimeCleanups.push(cleanup) },
        "openclaw",
        {
          configurationPath: "/etc/openclaw/openclaw.json",
          entrypoint: countingProvider + KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
          network,
          volumes: [`${path}:/etc/openclaw/openclaw.json:ro`],
          waitUntilReady: false,
          withAppServer: false,
          extraEnvironment: [
            "OPENCLAW_GATEWAY_PASSWORD=synthetic-owned-native-password",
            "OPENCLAW_RUNTIME_STATUS_PORT=18791",
            "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
            "OPENCLAW_AGENT_REVISION_ID=owned-native-scopes",
            "OPENCLAW_POD_UID=owned-native-scopes",
          ],
        },
      );
      await waitForListenerReady(
        containerName,
        '() => fetch("http://127.0.0.1:8080/readyz", {signal: AbortSignal.timeout(5000)}).then(r => r.status)',
      );
      const address = await containerIPv4(containerName, network);
      const remote = await runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        network,
        "--volume",
        `${probePath}:/probe.mts:ro`,
        "--entrypoint",
        "node",
        image,
        "/probe.mts",
        address,
        Buffer.from(JSON.stringify(requests.map(([request]) => request))).toString("base64url"),
      ]);
      const outcomes = observations(remote.stdout, requests.length).map(asRecord);
      for (const [position, [request, expected]] of requests.entries()) {
        const outcome = outcomes[position];
        const description = `${label}: ${request.operation ?? request.kind ?? "http"} ${request.identity} with ${
          request.scopes === undefined ? "no scope header" : `x-openclaw-scopes=${request.scopes}`
        }`;
        assert.ok(outcome, description);
        assert.equal(outcome.status, expected.status, description);
        if (expected.body !== undefined) {
          assert.ok(
            typeof outcome.body === "string" && expected.body.test(outcome.body),
            description,
          );
        }
        if (expected.nativeSessions) {
          assert.ok(typeof outcome.body === "string", description);
          const body = asRecord(JSON.parse(outcome.body));
          const details = asRecord(asRecord(body?.result)?.details);
          assert.equal(body?.ok, true, description);
          assert.ok(Array.isArray(details?.sessions), description);
          assert.equal(details.count, details.sessions.length, description);
        }
        if (expected.scopes !== undefined) {
          assert.ok(isStringArray(outcome.scopes), description);
          assert.deepEqual(outcome.scopes, expected.scopes, description);
          assert.equal(outcome.hasDeviceToken, false, description);
        }
      }
      await assertNoModelRequests(containerName);
      t.diagnostic(
        `${label}: ${outcomes.map((outcome) => outcome?.status).join(",")} modelCalls=0`,
      );
      await runDocker(["rm", "-f", containerName]);
    });
  },
);
