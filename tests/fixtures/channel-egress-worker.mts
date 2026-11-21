import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { normalizeNetworkDestinationRules } from "../../packages/contracts/src/index.ts";
import {
  loadInstallationConfiguration,
  readHarnessNodeCa,
} from "../../apps/controller/src/composition/installation-config.ts";
import { readWorkspaceFilesApiKey } from "../../apps/controller/src/composition/workspace-files.ts";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");

// A new installed Driver generation supplies controlled endpoint requirements.
// Persistence, worker claims, authorization, Compute, Envoy and workloads remain real.
const path = process.argv[2];
assert.ok(path, "the fixture must explicitly select its immutable Driver declarations");
const destinations = normalizeNetworkDestinationRules(JSON.parse(await readFile(path, "utf8")));
class CurrentChannelDriver extends SlackChannelDriver {
  override enableRouting() {
    return destinations;
  }
}

const installed = await loadInstallationConfiguration({ mode: "production" });
assert.ok(installed);
assert.ok(
  !installed.sandboxDriver && !installed.protectedDriver && !installed.repositoryTransport,
  "this fixture covers ordinary dedicated Compute, not a provider-owned Harness or repository transport",
);
const selection = installed.installation.drivers.compute;
const channelDrivers = [{ provider: "slack", driver: new CurrentChannelDriver() }];
const computeDriver = new KubernetesComputeDriver(
  selection.configuration as unknown as KubernetesComputeDriverOptions,
  {
    id: selection.id,
    implementation: selection.implementation,
    lifecycleDrivers: [installed.configurationDriver],
    channelDrivers,
    ...(installed.tokenService ? { preparedTokens: installed.tokenService } : {}),
    nodeEnrollment: createGatewayNodeEnrollment(() => {
      assert.ok(process.env.OCC_GATEWAY_API_KEY_PATH);
      return readWorkspaceFilesApiKey(process.env.OCC_GATEWAY_API_KEY_PATH);
    }),
    readNodeCa: () => readHarnessNodeCa(process.env),
  },
);
const pool = new pg.Pool({ connectionString: process.env.OCC_DATABASE_URL, max: 6 });
const marker = async (key: string) => {
  const path = process.env[key];
  if (path) {
    await writeFile(path, `${Date.now()}\n`, { mode: 0o600 });
  }
};
const worker = createControllerWorker({
  mode: "production",
  pool,
  drivers: { ...installed, computeDriver, channelDrivers },
  pollIntervalMs: 50,
  leaseDurationMs: 60_000,
  maxAttempts: 30,
  convergenceTimeoutMs: 900_000,
  emit: createWorkerLogEmitter(createOccLogger({ component: "occ-worker", level: "info" })),
  onHealthy: () => marker("OCC_WORKER_READINESS_PATH"),
  onProgress: () => marker("OCC_WORKER_LIVENESS_PATH"),
});
await worker.start();
let stopping = false;
const stop = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  await worker.stop();
};
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
