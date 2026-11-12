import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

type WatchCase = {
  kind: "watch";
  name: string;
  id: string;
  clusterDirectory: string;
  captureBarrierDirectory: string;
  podRecords: number;
  eventRecords: number;
};

type StartupCase = {
  kind: "startup";
  root: string;
  deleted: string;
  selection: { kubeconfigPath: string; kubernetesContext: string };
  target: { namespace: string; container: string; labels: Record<string, string> };
};

export type K3dChildCase = WatchCase | StartupCase | { kind: "stop" } | { kind: "passing" };

export async function registerK3dChildTest(scenario: K3dChildCase) {
  switch (scenario.kind) {
    case "watch":
      registerWatchCase(scenario);
      break;
    case "stop":
      await registerStopCase();
      break;
    case "startup":
      await registerStartupCase(scenario);
      break;
    case "passing":
      test("passes", () => {});
      break;
  }
}

function registerWatchCase({
  name,
  id,
  clusterDirectory,
  captureBarrierDirectory,
  podRecords,
  eventRecords,
}: WatchCase) {
  const expectedCaptures = Number(process.env.CI_RUNNER_TEST_EXPECTED_CAPTURES ?? 1);
  const barrier = process.env.CI_RUNNER_TEST_CAPTURE_BARRIER ?? "single";
  const markerPrefix = `capture-ready-${barrier}-`;
  test(name, async () => {
    if (!process.env.OPENCLAW_CI_CONTAINER_LOG_DIR) {
      return;
    }
    let watchReady = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const names = await readdir(clusterDirectory);
      const streams = await Promise.all(
        names
          .filter((entry) => entry.startsWith("agent-activity-"))
          .map(async (entry) => {
            const text = await readFile(join(clusterDirectory, entry), "utf8").catch((error) => {
              if (error?.code === "ENOENT") {
                return "";
              }
              throw error;
            });
            return { name: entry, lines: text.split("\n").filter(Boolean).length };
          }),
      );
      const podStreams = streams.filter(({ name: entry }) => entry.endsWith("-pods.ndjson"));
      const eventStreams = streams.filter(({ name: entry }) => entry.endsWith("-events.ndjson"));
      const podsReady =
        podStreams.length > 0 && podStreams.every(({ lines }) => lines >= podRecords);
      const eventsReady =
        eventStreams.length > 0 && eventStreams.every(({ lines }) => lines >= eventRecords);
      if (
        podStreams.length === expectedCaptures &&
        eventStreams.length === expectedCaptures &&
        podsReady &&
        eventsReady
      ) {
        watchReady = true;
        break;
      }
      await delay(10);
    }
    if (!watchReady) {
      throw new Error("timed out waiting for Agent namespace watch output");
    }
    await writeFile(join(captureBarrierDirectory, `${markerPrefix}${id}`), "ready");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const acknowledgements = (await readdir(captureBarrierDirectory)).filter((entry) =>
        entry.startsWith(markerPrefix),
      );
      if (acknowledgements.length === expectedCaptures) {
        return;
      }
      await delay(10);
    }
    throw new Error("timed out waiting for concurrent capture acknowledgements");
  });
}

async function registerStopCase() {
  const { followContainerLog } = await import("../helpers/container-log-capture.ts");
  let snapshots = 0;
  test("gateway stop is confirmed", async (t) => {
    const log = followContainerLog({
      args: ["logs", "--follow", "--timestamps"],
      env: process.env,
      target: { namespace: "occ-agent-a", pod: "gateway-0", container: "gateway" },
      snapshot: async () => {
        if (process.env.SNAPSHOT_FAILS_AFTER === String(++snapshots)) {
          throw new Error("read failed");
        }
        return { pods: readSnapshot("pods"), events: readSnapshot("events") };
      },
      recoverLogs: undefined,
    });
    try {
      process.env.SNAPSHOT_FAILS_AFTER = "2";
      await log.attachOnFailure(t, "passing wait", async () => "settled");
      log.mark("stop requested");
      await log.attachOnFailure(t, "terminal response wait", async () => {
        throw new Error("timed out");
      });
    } finally {
      await log.stop();
    }
  });
}

function readSnapshot(kind: "pods" | "events"): unknown[] {
  const { items } = JSON.parse(
    execFileSync("kubectl", ["get", kind, "-o", "json"], { encoding: "utf8" }),
  );
  return items;
}

async function registerStartupCase({ root, deleted, selection, target }: StartupCase) {
  const { waitForDeploymentAvailable } = await import("../helpers/kubernetes-real.mjs");
  test("controller startup fails", async (t) => {
    await rm(join(root, "deployment-healthy.ready"), { force: true });
    await rm(join(root, "deployment-openclaw-enterprise-api.ready"), { force: true });
    t.after(() => writeFile(deleted, "deleted"));
    await waitForDeploymentAvailable(t, selection, { ...target, deployment: "healthy" });
    await waitForDeploymentAvailable(t, selection, {
      ...target,
      deployment: "openclaw-enterprise-api",
    });
  });
}
