import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import {
  createKubernetesClient,
  explicitK3dSelection,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";
import { parseProductionChart, productionValues } from "../helpers/production-chart.mjs";

const execute = promisify(execFile);
const selection = explicitK3dSelection();
const skip =
  selection.kubeconfigPath || selection.kubernetesContext
    ? false
    : "requires explicit disposable k3d";

test(
  "Helm install preserves the initialization Job when release history is absent",
  { skip },
  async (t) => {
    await validateExplicitK3dLoopbackContext(selection);
    const { kubectl, applyManifest, resource } = createKubernetesClient({ selection });
    const namespace = `retained-job-${randomUUID()}`;
    const release = `retained-install-${randomUUID()}`; // 53 characters: exercises the truncated hook name.
    await kubectl("create", "namespace", namespace);
    t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));
    const target = [
      "--namespace",
      namespace,
      "--kubeconfig",
      selection.kubeconfigPath,
      "--kube-context",
      selection.kubernetesContext,
    ];
    const helm = (...args) => execute(process.env.OCC_HELM_BIN ?? "helm", [...args, ...target]);
    const chart = [
      release,
      "deploy/helm/openclaw-enterprise",
      ...Object.entries(productionValues).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ];
    const render = (...extra) =>
      helm(
        "template",
        ...chart,
        "--dry-run=server",
        "--show-only",
        "templates/jobs.yaml",
        ...extra,
      );

    // Only NotFound permits rendering. An authenticated user without Job access gets Forbidden.
    await assert.rejects(
      render("--kube-as-user", "retained-job-reader"),
      /jobs\.batch .*is forbidden: User "retained-job-reader" cannot get resource "jobs"/,
    );
    const [job] = await parseProductionChart((await render()).stdout);

    // Reproduce the state after loss of Helm history, without ever starting the bootstrap.
    // The real install below must fail during rendering, before Helm can delete this Job to rerun its hook.
    job.spec.suspend = true;
    job.metadata.namespace = namespace;
    await applyManifest(JSON.stringify(job));
    const name = job.metadata.name;
    const {
      metadata: { uid },
    } = await resource("job", name, namespace);
    await assert.rejects(helm("install", ...chart, "--timeout", "20s"), (error) => {
      assert.ok(
        error.stderr?.includes(
          `initialization Job ${namespace}/${name} already exists; preserve it`,
        ),
        error.message,
      );
      return true;
    });
    assert.equal((await resource("job", name, namespace)).metadata.uid, uid);
    assert.equal((await helm("list", "--all", "--short")).stdout.trim(), "");
    assert.equal((await kubectl("get", "pods", "-n", namespace, "-o", "name")).trim(), "");
  },
);
