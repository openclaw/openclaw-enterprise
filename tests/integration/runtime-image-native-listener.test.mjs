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
