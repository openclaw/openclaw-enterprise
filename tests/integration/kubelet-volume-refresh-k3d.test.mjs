import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createKubernetesClient,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

// Premise test for delivering late workload inputs through optional volumes.
// A Pod starts before its optional Secret or ConfigMap exists; the object is created
// afterwards. The kubelet populates the volume on the Pod's next sync. Without a nudge
// that is the periodic resync (syncFrequency, 1 min by default, plus jitter). Patching an
// annotation on the running Pod is an update event, which syncs the Pod at once.

const execute = promisify(execFile);
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const image = process.env.OCC_TEST_KUBERNETES_IMAGE;
const requested = [...Object.values(selection), image].some(Boolean);

// Bounds from measured k3d runs (lane results, files[].measurements). With the Pod
// annotation nudge the content appeared 1.3-1.4 s after the create call started (two
// kubectl invocations included); 15 s leaves headroom for a loaded runner and is what
// late delivery relies on. Without a nudge it took 67-84 s: the kubelet resync period
// (1 min, jittered up to 1.5x) plus the next sync. 150 s covers that with headroom.
const nudgedBoundSeconds = 15;
const unnudgedBoundSeconds = 150;
const samplesPerCase = 2;
const settleMs = 5_000;
const mountPath = "/var/run/openclaw-late";

// Runs in the fixture image as uid 1000. Reports when the expected content appears.
const watcher = `
const fs = require("node:fs");
const [file, expected] = process.argv.slice(1);
console.log(JSON.stringify({ watchingAtMs: Date.now() }));
const timer = setInterval(() => {
  let value;
  try { value = fs.readFileSync(file, "utf8"); } catch { return; }
  if (value === expected) {
    console.log(JSON.stringify({ seenAtMs: Date.now() }));
    clearInterval(timer);
    setInterval(() => {}, 3_600_000);
  }
}, 100);
`;

function volumeFor(kind, name) {
  return kind === "secret"
    ? {
        name: "late",
        // Mirrors the planned Harness wiring: one projected item, optional, 0440.
        secret: {
          secretName: name,
          optional: true,
          defaultMode: 0o440,
          items: [{ key: "setupCode", path: "setupCode" }],
        },
      }
    : { name: "late", configMap: { name, optional: true } };
}

function podFor({ namespace, name, kind, objectName, expected }) {
  const file = `${mountPath}/${kind === "secret" ? "setupCode" : "deviceId"}`;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { "openclaw.dev/test": "volume-refresh" } },
    spec: {
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 0,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
      volumes: [volumeFor(kind, objectName)],
      containers: [
        {
          name: "watcher",
          image,
          imagePullPolicy: "Never",
          command: ["node", "-e", watcher, file, expected],
          volumeMounts: [{ name: "late", mountPath, readOnly: true }],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
            seccompProfile: { type: "RuntimeDefault" },
          },
          resources: {
            requests: { cpu: "10m", memory: "32Mi" },
            limits: { cpu: "250m", memory: "96Mi" },
          },
        },
      ],
    },
  };
}

function objectFor({ namespace, kind, objectName, expected }) {
  return kind === "secret"
    ? {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: objectName, namespace },
        type: "Opaque",
        stringData: { setupCode: expected },
      }
    : {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: objectName, namespace },
        data: { revisionId: "rev-volume-refresh", deviceId: expected },
      };
}

function logRecords(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

test(
  "optional Secret and ConfigMap volumes populate in running Pods within the measured kubelet refresh bounds",
  {
    skip: requested
      ? false
      : "Select OCC_TEST_KUBERNETES_KUBECONFIG, CONTEXT, and IMAGE to measure volume refresh on disposable k3d.",
    timeout: 600_000,
  },
  async (t) => {
    assert.ok(image, "OCC_TEST_KUBERNETES_IMAGE must select an imported Kubernetes fixture image.");
    await validateExplicitK3dLoopbackContext(selection);
    const kubectl = async (...args) =>
      (
        await execute("kubectl", kubectlArguments(selection, args), {
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    const { applyManifest, resource, waitFor } = createKubernetesClient({
      selection,
      kubectl,
      waitIntervalMs: 250,
    });
    const namespace = `oce-volume-refresh-${randomUUID().slice(0, 8)}`;
    await kubectl("create", "namespace", namespace);
    t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));

    const cases = [];
    for (const kind of ["secret", "configmap"]) {
      for (const nudge of ["none", "pod-annotation"]) {
        for (let sample = 0; sample < samplesPerCase; sample += 1) {
          const name = `${kind}-${nudge === "none" ? "plain" : "nudged"}-${sample}`;
          cases.push({
            kind,
            nudge,
            sample,
            name,
            objectName: `${name}-late`,
            expected: `value-${randomUUID()}`,
          });
        }
      }
    }

    await applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "List",
        items: cases.map((entry) => podFor({ namespace, ...entry })),
      }),
    );
    await Promise.all(
      cases.map((entry) =>
        waitFor(
          `${entry.name} watching its empty optional volume`,
          async () => {
            const pod = await resource("pod", entry.name, namespace);
            if (pod.status?.phase !== "Running") {
              return false;
            }
            const records = logRecords(await kubectl("logs", entry.name, "--namespace", namespace));
            return records.some((record) => record.watchingAtMs !== undefined);
          },
          120_000,
        ),
      ),
    );
    // The late object arrives after the Pod has settled, as a Gateway-ready wait would.
    await delay(settleMs);

    await Promise.all(
      cases.map(async (entry) => {
        entry.createdAtMs = Date.now();
        await applyManifest(JSON.stringify(objectFor({ namespace, ...entry })));
        if (entry.nudge === "pod-annotation") {
          await kubectl(
            "annotate",
            "pod",
            entry.name,
            "--namespace",
            namespace,
            "--overwrite",
            `openclaw.dev/volume-refresh=${Date.now()}`,
          );
        }
      }),
    );

    await Promise.all(
      cases.map(async (entry) => {
        const seen = await waitFor(
          `${entry.name} to see its ${entry.kind} content`,
          async () =>
            logRecords(await kubectl("logs", entry.name, "--namespace", namespace)).find(
              (record) => record.seenAtMs !== undefined,
            ),
          (unnudgedBoundSeconds + 60) * 1_000,
        );
        entry.seconds = Math.round((seen.seenAtMs - entry.createdAtMs) / 100) / 10;
        t.diagnostic(
          `openclaw-ci-measurement ${JSON.stringify({
            kind: "kubelet-volume-refresh",
            volume: entry.kind,
            nudge: entry.nudge,
            sample: entry.sample,
            seconds: entry.seconds,
          })}`,
        );
      }),
    );

    for (const entry of cases) {
      const bound = entry.nudge === "pod-annotation" ? nudgedBoundSeconds : unnudgedBoundSeconds;
      assert.ok(
        entry.seconds <= bound,
        `${entry.kind} with nudge ${entry.nudge} took ${entry.seconds} s (bound ${bound} s)`,
      );
    }
  },
);
