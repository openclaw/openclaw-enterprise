import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  createKubernetesClient,
  explicitK3dSelection,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import { parseProductionChart, productionValues } from "../helpers/production-chart.mjs";

const execute = promisify(execFile);
const selection = explicitK3dSelection();
const skip =
  selection.kubeconfigPath || selection.kubernetesContext
    ? false
    : "requires explicit disposable k3d";

function jobUid(value: unknown): string {
  const uid = asRecord(asRecord(value)?.metadata)?.uid;
  assert.ok(typeof uid === "string" && uid.length > 0, "Expected the live Job to have a UID");
  return uid;
}

test(
  "Helm install preserves the initialization Job when release history is absent",
  { skip },
  async (t) => {
    await validateExplicitK3dLoopbackContext(selection);
    const { kubeconfigPath, kubernetesContext } = selection;
    assert.ok(kubeconfigPath && kubernetesContext);
    const { kubectl, applyManifest, resource } = createKubernetesClient({ selection });
    const namespace = `retained-job-${randomUUID()}`;
    const release = `retained-install-${randomUUID()}`; // 53 characters: exercises the truncated hook name.
    await kubectl("create", "namespace", namespace);
    t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));
    const target = [
      "--namespace",
      namespace,
      "--kubeconfig",
      kubeconfigPath,
      "--kube-context",
      kubernetesContext,
    ];
    const helm = (...args: string[]) =>
      execute(process.env.OCC_HELM_BIN ?? "helm", [...args, ...target]);
    const chart = [
      release,
      "deploy/helm/openclaw-enterprise",
      ...Object.entries(productionValues).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ];
    const render = (...extra: string[]) =>
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
    const [document]: readonly unknown[] = await parseProductionChart((await render()).stdout);
    const job = asRecord(document);
    const metadata = asRecord(job?.metadata);
    const spec = asRecord(job?.spec);
    const name = metadata?.name;
    assert.ok(
      job?.kind === "Job" && spec && metadata && typeof name === "string" && name.length > 0,
      "Expected Helm to render a named initialization Job with a spec",
    );

    // Reproduce the state after loss of Helm history, without ever starting the bootstrap.
    // The real install below must fail during rendering, before Helm can delete this Job to rerun its hook.
    spec.suspend = true;
    metadata.namespace = namespace;
    await applyManifest(JSON.stringify(job));
    const uid = jobUid(await resource("job", name, namespace));
    await assert.rejects(helm("install", ...chart, "--timeout", "20s"), (error: unknown) => {
      const stderr = asRecord(error)?.stderr;
      return (
        typeof stderr === "string" &&
        stderr.includes(`initialization Job ${namespace}/${name} already exists; preserve it`)
      );
    });
    assert.equal(jobUid(await resource("job", name, namespace)), uid);
    assert.equal((await helm("list", "--all", "--short")).stdout.trim(), "");
    assert.equal((await kubectl("get", "pods", "-n", namespace, "-o", "name")).trim(), "");
  },
);
