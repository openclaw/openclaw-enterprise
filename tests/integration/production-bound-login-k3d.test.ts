import assert from "node:assert/strict";
import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import test from "node:test";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { k3sImage } from "../../scripts/ci/openshell.mjs";
import { qualifyBoundLogin } from "../helpers/production-bound-login.ts";

async function readPreparedState() {
  const path = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  assert.ok(path, "A prepared job state is required");
  assert.equal(await realpath(path), path);
  const stateFile = await lstat(path);
  assert.ok(stateFile.isFile());
  assert.equal(stateFile.uid, process.getuid!());
  assert.equal(stateFile.mode & 0o777, 0o600);
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(
    state.repositoryRoot,
    fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""),
  );
  assert.equal(state.statePath, path);
  assert.equal(state.lane, "k3d-bound-login");
  assert.ok(process.env.RUNNER_TEMP);
  assert.equal(path, join(resolve(process.env.RUNNER_TEMP), "state", "k3d-bound-login.json"));
  assert.match(state.prefix, /^openclaw-ci-[a-z0-9-]+$/);
  assert.equal(state.prefix, process.env.OPENCLAW_ENTERPRISE_CI_PREFIX);
  assert.equal(state.env.OPENCLAW_ENTERPRISE_CI_PREFIX, state.prefix);
  assert.equal(state.env.OPENCLAW_ENTERPRISE_CI_STATE, path);
  assert.ok(Array.isArray(state.resources));
  assert.equal(
    new Set(state.resources.map((resource: { id: string }) => resource.id)).size,
    state.resources.length,
  );
  for (const resource of state.resources) {
    assert.equal(resource.owner, state.prefix);
  }
  const clusters = state.resources.filter(
    (resource: { kind: string }) => resource.kind === "k3d-cluster",
  );
  assert.equal(clusters.length, 1, "The job owns exactly one cluster");
  const cluster = clusters[0];
  assert.equal(cluster.status, "ready");
  assert.equal(state.env.OCC_TEST_KUBERNETES_KUBECONFIG, cluster.kubeconfig);
  assert.equal(state.env.OCC_TEST_KUBERNETES_CONTEXT, cluster.context);
  assert.match(cluster.name, /^openclaw-k8s-[a-z0-9-]+$/);
  assert.equal(cluster.context, `k3d-${cluster.name}`);
  assert.equal(cluster.kubeconfig, join(cluster.directory, "kubeconfig"));
  assert.ok(basename(cluster.directory).startsWith(cluster.name + "-"));
  assert.equal(await realpath(cluster.directory), cluster.directory);
  assert.deepEqual(cluster.nodes, [`k3d-${cluster.name}-server-0`]);
  assert.equal(cluster.nodeImage, k3sImage);
  assert.equal(cluster.runtimeClass, "openshell-sandbox");
  assert.equal(cluster.runtimeHandler, "runc");
  assert.equal(state.env.OCC_TEST_OPENSHELL_RUNTIME_CLASS, cluster.runtimeClass);
  assert.equal(state.env.OCC_TEST_OPENSHELL_RUNTIME_HANDLER, cluster.runtimeHandler);
  assert.equal(state.env.OCC_KUBECTL_BIN, cluster.kubectl);
  assert.equal(
    cluster.podSecurityAdmissionConfig,
    join(cluster.directory, "openshell-pod-security-admission.yaml"),
  );
  assert.equal(cluster.disabledK3sAddons, undefined);
  for (const variable of [
    "OCC_TEST_KUBERNETES_KUBECONFIG",
    "OCC_TEST_KUBERNETES_CONTEXT",
    "OCC_KUBECTL_BIN",
    "OCC_TEST_OPENSHELL_RUNTIME_CLASS",
  ]) {
    assert.equal(process.env[variable], state.env[variable]);
  }
  const identity = await lstat(cluster.directory);
  return { state, cluster, identity };
}

test(
  "bound Helm upgrade preserves narrow member login, denies outsider and revoked replay, and retains recovery",
  {
    skip:
      process.env.OCC_TEST_PRODUCTION_BOUND_LOGIN === "1"
        ? false
        : "Select the prepared k3d-bound-login lane.",
    timeout: 2100000,
  },
  async (t) => {
    let prepared: Awaited<ReturnType<typeof readPreparedState>>;
    try {
      prepared = await readPreparedState();
    } catch {
      throw new Error(
        'Bound login prepared state refused: {"stage":"prepared-state","action":"admission","failureClass":"local-setup","installedQualified":false,"authenticated":false,"commandCount":0,"mutationCount":0}',
      );
    }
    const { state, cluster, identity } = prepared;
    // No test teardown: an unknown remote outcome ends application work. The
    // standard action's single final cleanup owns disposal on this exclusive VM.
    const receipt = await qualifyBoundLogin(
      t,
      { PATH: process.env.PATH, ...state.env },
      cluster.directory,
      {
        dev: identity.dev,
        ino: identity.ino,
        uid: identity.uid,
      },
    );
    t.signal.throwIfAborted();
    if (process.env.GITHUB_ACTIONS === "true") {
      try {
        assert.ok(process.env.GITHUB_STEP_SUMMARY);
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `### Bound Namespace Console login\n\n` +
            `Helm revision ${receipt.beforeRevision} upgraded to ${receipt.afterRevision}. ` +
            `Member and recovery effects passed; outsider and revoked-session denials retained the same marker. ` +
            `Standard job cleanup follows this test.\n\n` +
            `Job owner SHA-256: ${createHash("sha256").update(state.prefix).digest("hex")}\n\n` +
            `Old chart SHA-256: ${receipt.oldChartSha256}\n\nCandidate chart SHA-256: ${receipt.chartSha256}\n\n` +
            `Namespace UID SHA-256: ${receipt.namespaceUIDSha256}\n`,
        );
      } catch {
        throw new Error(
          'Bound login receipt write failed: {"stage":"receipt","action":"summary-append","proofCompleted":true}',
        );
      }
    }
  },
);
