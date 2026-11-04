// Runtime image cases split from runtime-image-startup.test.mjs, whose cases run
// one after another, so CI can run them on another lane: the pinned Gateway
// proves why Compute admission refuses native listener TLS and binds that
// cannot serve Pod-IP traffic.
import { plaintextGatewayComputeDrivers } from "../helpers/plaintext-gateway-compute.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  image,
  imageTestOptions,
  runDocker,
  commandOutput,
  failureTail,
  createAdmittedRuntimeImageConfiguration,
  runGatewaySmoke,
  waitForContainerReady,
} from "../helpers/runtime-image-startup.mjs";
import { eachSettled } from "../helpers/child-processes.mjs";

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
async function waitForListenerReady(containerName, request) {
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
    error.message += `\nContainer logs:\n${logs}`;
    throw error;
  }
}

async function assertNoModelRequests(containerName) {
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
      const configuration = drivers[0][1].kubernetesGatewayConfigurationDocument(
        createAdmittedRuntimeImageConfiguration("openclaw"),
      );
      configuration.models.providers.openai.baseUrl = "http://127.0.0.1:18880/v1";
      configuration.models.providers.openai.apiKey = "synthetic-owned-native-tls";
      configuration.gateway.tls = {
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
    const runtimeCleanups = [];
    t.after(async () => {
      for (const cleanup of runtimeCleanups.reverse()) {
        await cleanup();
      }
      await runDocker(["network", "rm", network]);
    });
    const directory = await temporaryDirectory(t, "oce-native-bind-");
    // Each case owns its container and configuration file, so the cases run
    // concurrently on the shared internal network.
    const bindCases = [
      [{ bind: "loopback" }, false],
      [{ bind: "custom", customBindHost: "127.0.0.1" }, false],
      [{ bind: "tailnet" }, false],
      [{ bind: "lan" }, true],
      [{ bind: "auto" }, true],
      [{ bind: "custom", customBindHost: "0.0.0.0" }, true],
      [{}, true],
    ];
    await eachSettled(bindCases, async ([gateway, reachable], index) => {
      const configuration = driver.kubernetesGatewayConfigurationDocument(
        createAdmittedRuntimeImageConfiguration("openclaw"),
      );
      delete configuration.gateway.bind;
      Object.assign(configuration.gateway, gateway);
      configuration.models.providers.openai.baseUrl = "http://127.0.0.1:18880/v1";
      configuration.models.providers.openai.apiKey = "synthetic-owned-native-bind";
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
      const inspected = JSON.parse((await runDocker(["inspect", containerName])).stdout)[0];
      const address = inspected.NetworkSettings.Networks[network].IPAddress;
      assert.ok(address);
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
          "--entrypoint",
          "node",
          image,
          "-e",
          // A fixed program: the address and expectation are arguments, not code.
          'const [budget,address,reachable]=process.argv.slice(1);const deadline=Date.now()+Number(budget);const probe=async port=>{try{const r=await fetch("http://"+address+":"+port+"/readyz",{signal:AbortSignal.timeout(3000)});return {port,status:r.status};}catch(e){return {port,error:e.cause?.code??e.name};}};(async()=>{for(;;){const v=await Promise.all([8080,18791].map(probe));if((v[1].status===200&&(reachable==="true"?v[0].status===200:v[0].error==="ECONNREFUSED"))||Date.now()>=deadline){console.log(JSON.stringify(v));return;}await new Promise(r=>setTimeout(r,500));}})();',
          String(remoteBudgetMs),
          address,
          String(reachable),
        ],
        { timeout: remoteBudgetMs + 60_000 * imageSmokeTimeoutMultiplier },
      );
      const [native, status] = JSON.parse(remote.stdout.trim());
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

// The probe stands in for the proxy on the Gateway's network: native HTTP calls
// or a WebSocket connect as an operator without a device.
const trustedProxyProbe = String.raw`
import WebSocket from "/app/node_modules/ws/index.js";
const [address, encoded] = process.argv.slice(2);
const proxyHeaders = ({ identity, scopes }) => ({
  "x-real-ip": "192.0.2.10",
  "x-occ-identity": identity,
  ...(scopes === undefined ? {} : { "x-openclaw-scopes": scopes }),
});
async function http(request) {
  const invoke = request.operation === "sessions_list";
  const path = invoke ? "/tools/invoke" : "/sessions/probe-session/kill";
  const response = await fetch("http://" + address + ":8080" + path, {
    method: "POST",
    headers: { ...proxyHeaders(request), ...(invoke ? { "content-type": "application/json" } : {}) },
    ...(invoke ? { body: JSON.stringify({ tool: "sessions_list", args: {} }) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.text() };
}
function ws(request) {
  return new Promise((resolve) => {
    const socket = new WebSocket("ws://" + address + ":8080", { headers: proxyHeaders(request) });
    const timer = setTimeout(() => { socket.terminate(); resolve({ status: "timeout" }); }, 15000);
    const done = (value) => { clearTimeout(timer); socket.close(); resolve(value); };
    socket.on("unexpected-response", (_request, response) => done({ status: "handshake-refused", http: response.statusCode }));
    socket.on("error", (error) => done({ status: "error", body: error.message }));
    socket.on("close", (code, reason) => done({ status: "closed", code, body: String(reason) }));
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "event" && message.event === "connect.challenge") {
        socket.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {
          minProtocol: 4, maxProtocol: 4,
          client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
          caps: [], commands: [], role: "operator", scopes: [],
        } }));
      } else if (message.type === "res" && message.id === "connect") {
        done(message.ok
          ? { status: "hello", scopes: message.payload?.auth?.scopes, deviceToken: message.payload?.auth?.deviceToken }
          : { status: "connect-error", body: JSON.stringify(message.error) });
      }
    });
  });
}
const requests = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const outcomes = await Promise.all(requests.map((request) => (request.kind === "ws" ? ws(request) : http(request))));
console.log(JSON.stringify(outcomes));
`;

// Native HTTP APIs ignore identityScopes: a trusted-proxy request without
// x-openclaw-scopes receives the pinned Gateway's default operator scopes, admin
// included. Compute therefore requires the header once a human is admitted, and the
// operator HTTPRoute sends operator.admin for the machine identity (finding 2183).
test(
  "runtime image Gateway refuses trusted-proxy requests without x-openclaw-scopes once Compute admits a human",
  imageTestOptions,
  async (t) => {
    const driver = plaintextGatewayComputeDrivers()[0][1];
    const network = `oce-native-scopes-${randomBytes(6).toString("hex")}`;
    await runDocker(["network", "create", "--internal", network]);
    const runtimeCleanups = [];
    t.after(async () => {
      for (const cleanup of runtimeCleanups.reverse()) {
        await cleanup();
      }
      await runDocker(["network", "rm", network]);
    });
    const subnet = JSON.parse((await runDocker(["network", "inspect", network])).stdout)[0].IPAM
      .Config[0].Subnet;
    assert.ok(subnet);
    const directory = await temporaryDirectory(t, "oce-native-scopes-");
    const probePath = join(directory, "probe.mjs");
    await writeFile(probePath, trustedProxyProbe, { mode: 0o644 });
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
    const scopeCases = [
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
          delete configuration.gateway.auth.trustedProxy.requiredHeaders;
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
        undefined,
        undefined,
        [
          [{ identity: "occ-workspace-files" }, { status: 404, body: /Session not found/ }],
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
            { status: "hello", scopes: ["operator.admin"] },
          ],
        ],
      ],
    ];
    await eachSettled(scopeCases, async ([label, auth, adjust, requests], index) => {
      // Admitted configurations are frozen; the auth block is this case's input.
      const input = structuredClone(createAdmittedRuntimeImageConfiguration("openclaw"));
      if (auth !== undefined) {
        input.gateway = { ...input.gateway, auth: structuredClone(auth) };
      }
      const configuration = driver.kubernetesGatewayConfigurationDocument(input);
      assert.deepEqual(
        configuration.gateway.auth.trustedProxy.requiredHeaders,
        auth === undefined ? undefined : ["x-openclaw-scopes"],
      );
      // The probe container stands in for the proxy; Compute renders the Installation's
      // CIDRs, which cannot name this test network.
      configuration.gateway.trustedProxies = [subnet];
      adjust?.(configuration);
      configuration.models.providers.openai.baseUrl = "http://127.0.0.1:18880/v1";
      configuration.models.providers.openai.apiKey = "synthetic-owned-native-scopes";
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
      const inspected = JSON.parse((await runDocker(["inspect", containerName])).stdout)[0];
      const address = inspected.NetworkSettings.Networks[network].IPAddress;
      assert.ok(address);
      const remote = await runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        network,
        "--volume",
        `${probePath}:/probe.mjs:ro`,
        "--entrypoint",
        "node",
        image,
        "/probe.mjs",
        address,
        Buffer.from(JSON.stringify(requests.map(([request]) => request))).toString("base64url"),
      ]);
      const outcomes = JSON.parse(remote.stdout.trim());
      for (const [position, [request, expected]] of requests.entries()) {
        const outcome = outcomes[position];
        const description = `${label}: ${request.operation ?? request.kind ?? "http"} ${request.identity} with ${
          request.scopes === undefined ? "no scope header" : `x-openclaw-scopes=${request.scopes}`
        }: ${JSON.stringify(outcome)}`;
        assert.equal(outcome.status, expected.status, description);
        if (expected.body !== undefined) {
          assert.match(outcome.body, expected.body, description);
        }
        if (expected.nativeSessions) {
          const body = JSON.parse(outcome.body);
          assert.equal(body.ok, true, description);
          assert.ok(Array.isArray(body.result?.details?.sessions), description);
          assert.equal(body.result.details.count, body.result.details.sessions.length, description);
        }
        if (expected.scopes !== undefined) {
          assert.deepEqual(outcome.scopes, expected.scopes, description);
          assert.equal(outcome.deviceToken, undefined, description);
        }
      }
      await assertNoModelRequests(containerName);
      t.diagnostic(`${label}: ${outcomes.map(({ status }) => status).join(",")} modelCalls=0`);
      await runDocker(["rm", "-f", containerName]);
    });
  },
);
