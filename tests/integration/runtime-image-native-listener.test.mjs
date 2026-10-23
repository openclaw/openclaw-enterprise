// Runtime image cases split from runtime-image-startup.test.mjs, whose cases run
// one after another, so CI can run them on another lane: the pinned Gateway
// proves why Compute admission refuses native listener TLS and binds that
// cannot serve Pod-IP traffic.
import { plaintextGatewayComputeDrivers } from "../helpers/plaintext-gateway-compute.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  image,
  imageTestOptions,
  runDocker,
  commandOutput,
  failureTail,
  createAdmittedRuntimeImageConfiguration,
  runGatewaySmoke,
  eachSettled,
} from "../helpers/runtime-image-startup.mjs";

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

async function waitForListenerReady(containerName, probe) {
  let lastReadinessFailure = "No readiness probe ran.";
  for (let attempt = 0; attempt < 80 * imageSmokeTimeoutMultiplier; attempt++) {
    try {
      await runDocker(["exec", containerName, "node", "-e", probe]);
      return;
    } catch (error) {
      lastReadinessFailure = failureTail(error.message, 2048);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const logs = await runDocker(["logs", containerName]).then(
    (result) => failureTail(commandOutput(result)),
    () => "Docker logs unavailable.",
  );
  throw new Error(
    `Listener readiness timed out.\nLast readiness failure: ${lastReadinessFailure}\nContainer logs:\n${logs}`,
  );
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
    const directory = await mkdtemp(join(tmpdir(), "oce-native-listener-tls-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
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
      const nativeProbe = enabled
        ? `require("https").get({hostname:"127.0.0.1",port:8080,path:"/readyz",servername:"openclaw-gateway",ca:require("fs").readFileSync("/home/node/tls/cert.pem")},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on("error",()=>process.exit(1));`
        : `fetch("http://127.0.0.1:8080/readyz").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1));`;
      await waitForListenerReady(containerName, nativeProbe);
      const readiness = () =>
        runDocker([
          "exec",
          containerName,
          "node",
          "-e",
          'fetch("http://127.0.0.1:18791/readyz").then(async r=>{if(await r.text()!=="")process.exit(2);console.log(r.status);process.exit(r.status===200?0:1)}).catch(()=>process.exit(2));',
        ]);
      if (enabled) {
        await assert.rejects(
          readiness,
          (error) => error.code === 1 && error.stdout.trim() === "503",
        );
        for (const [kind, driver] of drivers) {
          assert.throws(
            () => driver.validateGatewaySettings?.(configuration),
            /gateway\.tls\.enabled must be omitted or false/,
            kind,
          );
        }
      } else {
        await readiness();
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
    const directory = await mkdtemp(join(tmpdir(), "oce-native-bind-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
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
        'fetch("http://127.0.0.1:18791/readyz").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1));',
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
        "--entrypoint",
        "node",
        image,
        "-e",
        `Promise.all([8080,18791].map(async port=>{try{const r=await fetch("http://${address}:"+port+"/readyz",{signal:AbortSignal.timeout(3000)});return {port,status:r.status};}catch(e){return {port,error:e.cause?.code??e.name};}})).then(v=>console.log(JSON.stringify(v)));`,
      ]);
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

// The probe stands in for the proxy on the Gateway's network: one HTTP call to the
// admin-only run kill, or one WebSocket connect as an operator without a device.
const trustedProxyProbe = String.raw`
import WebSocket from "/app/node_modules/ws/index.js";
const [address, encoded] = process.argv.slice(2);
const proxyHeaders = ({ identity, scopes }) => ({
  "x-real-ip": "192.0.2.10",
  "x-occ-identity": identity,
  ...(scopes === undefined ? {} : { "x-openclaw-scopes": scopes }),
});
async function http(request) {
  const response = await fetch("http://" + address + ":8080/sessions/probe-session/kill", {
    method: "POST",
    headers: proxyHeaders(request),
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
    const directory = await mkdtemp(join(tmpdir(), "oce-native-scopes-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const probePath = join(directory, "probe.mjs");
    await writeFile(probePath, trustedProxyProbe, { mode: 0o644 });
    const humanAuth = {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-occ-identity",
        allowUsers: ["occ-workspace-files", "oidc:member-01"],
      },
      identityScopes: {
        "occ-workspace-files": ["operator.admin"],
        "oidc:member-01": ["operator.read"],
      },
    };
    // HTTP: run kills stay admin-only upstream, so 404 means the scope check passed for a
    // session that does not exist, 403 names the missing scope and 401 is refused admission.
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
        'fetch("http://127.0.0.1:8080/readyz").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1));',
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
        const description = `${label}: ${request.kind ?? "http"} ${request.identity} with ${
          request.scopes === undefined ? "no scope header" : `x-openclaw-scopes=${request.scopes}`
        }: ${JSON.stringify(outcome)}`;
        assert.equal(outcome.status, expected.status, description);
        if (expected.body !== undefined) {
          assert.match(outcome.body, expected.body, description);
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
