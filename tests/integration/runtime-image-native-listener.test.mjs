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
      // The TLS request reads the certificate the Gateway generates at startup.
      const nativeRequest = enabled
        ? `() => new Promise((resolve, reject) => require("https").get({hostname:"127.0.0.1",port:8080,path:"/readyz",servername:"openclaw-gateway",ca:require("fs").readFileSync("/home/node/tls/cert.pem"),timeout:5000},r=>{r.resume();resolve(r.statusCode)}).on("error",reject).on("timeout",function(){this.destroy(new Error("timeout"))}))`
        : `() => fetch("http://127.0.0.1:8080/readyz",{signal:AbortSignal.timeout(5000)}).then(r=>r.status)`;
      await waitForListenerReady(containerName, nativeRequest);
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
          `const deadline=Date.now()+Number(process.argv[1]);const probe=async port=>{try{const r=await fetch("http://${address}:"+port+"/readyz",{signal:AbortSignal.timeout(3000)});return {port,status:r.status};}catch(e){return {port,error:e.cause?.code??e.name};}};(async()=>{for(;;){const v=await Promise.all([8080,18791].map(probe));if((v[1].status===200&&(v[0].status===200||v[0].error==="ECONNREFUSED"))||Date.now()>=deadline){console.log(JSON.stringify(v));return;}await new Promise(r=>setTimeout(r,500));}})();`,
          String(remoteBudgetMs),
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
