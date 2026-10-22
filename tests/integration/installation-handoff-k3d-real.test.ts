import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";
import { parseProductionChart, renderProductionChart } from "../helpers/production-chart.mjs";

type ChartResource = {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: { managedBy?: string; suspend?: boolean };
};

const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const skip =
  selection.kubeconfigPath || selection.kubernetesContext
    ? false
    : "requires explicit disposable k3d";
test(
  "installation handoff distinguishes replaced Helm Jobs with only named get access",
  { skip },
  async (t) => {
    await validateExplicitK3dLoopbackContext(selection);
    const { kubectl, applyManifest } = createKubernetesClient({ selection });
    const dir = await mkdtemp(join(tmpdir(), "occ-handoff-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const occ = join(dir, "occ");
    execFileSync("go", ["build", "-o", occ, "./cmd/occ"]);

    const namespace = `handoff-${randomUUID()}`;
    const release = "oce.prod";
    const name = "oce.prod-initialization";
    await kubectl("create", "namespace", namespace);
    t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));
    const admin = (...args: string[]) => kubectl("-n", namespace, ...args);

    // Start with a new service account and no binding. Build its kubeconfig
    // from public cluster connection details only; never copy the admin user.
    await admin("create", "serviceaccount", "reader");
    const token = (await admin("create", "token", "reader", "--duration=10m")).trim();
    const clusters: unknown = JSON.parse(
      await kubectl(
        "config",
        "view",
        "--minify",
        "--flatten",
        "--raw",
        "-o",
        "jsonpath-as-json={.clusters[*]}",
      ),
    );
    assert.ok(Array.isArray(clusters));
    const cluster: unknown = clusters[0];
    assert.ok(cluster && typeof cluster === "object" && "name" in cluster);
    assert.ok(typeof cluster.name === "string");
    const config = join(dir, "reader.json");
    await writeFile(
      config,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters,
        contexts: [{ name: "read", context: { cluster: cluster.name, user: "reader" } }],
        users: [{ name: "reader", user: { token } }],
      }),
      { mode: 0o600 },
    );

    function handoff(
      action: "doctor" | "plan",
      status: number,
      expected: RegExp,
      ...args: string[]
    ) {
      const result = spawnSync(
        occ,
        [
          "installation",
          action,
          "--kubeconfig",
          config,
          "--context",
          "read",
          "--kube-namespace",
          namespace,
          "--release",
          release,
          ...args,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, status, result.stderr + result.stdout);
      assert.match(result.stdout, expected);
    }
    handoff("doctor", 1, /unknown. kubectl reported a refusal/);
    handoff("plan", 1, /Confirm the cluster target and intended reader with the access owner/);
    await admin(
      "create",
      "role",
      "reader",
      "--verb=get",
      "--resource=jobs.batch",
      `--resource-name=${name}`,
    );
    await admin(
      "create",
      "rolebinding",
      "reader",
      "--role=reader",
      `--serviceaccount=${namespace}:reader`,
    );
    handoff("doctor", 1, /not found at the selected target/);

    async function renderJob(isUpgrade: boolean) {
      const { stdout } = await renderProductionChart({}, { namespace, isUpgrade, release });
      const resources: ChartResource[] = await parseProductionChart(stdout);
      const job = resources.find(
        (resource) => resource.kind === "Job" && resource.metadata?.name === name,
      );
      assert.ok(job?.metadata && job.spec);
      job.metadata.namespace = namespace;
      return { manifest: job, spec: job.spec };
    }

    // A foreign controller can write completion without running the chart.
    // The CLI must refuse that evidence even when the recorded UID matches.
    const foreignJob = await renderJob(false);
    foreignJob.spec.managedBy = "example.invalid/handoff-readback";
    await applyManifest(JSON.stringify(foreignJob.manifest));
    const now = new Date().toISOString();
    const status = {
      conditions: [
        { type: "SuccessCriteriaMet", status: "True", lastTransitionTime: now },
        { type: "Complete", status: "True", lastTransitionTime: now },
      ],
      succeeded: 1,
      startTime: now,
      completionTime: now,
    };
    const first = (
      await admin(
        "patch",
        "job",
        name,
        "--subresource=status",
        "--type=merge",
        "-p",
        JSON.stringify({ status }),
        "-o",
        "jsonpath={.metadata.uid}",
      )
    ).trim();
    assert.ok(first);
    handoff("doctor", 1, /unsupported Job controller/, "--expect-job-uid", first);
    await admin("delete", "job", name);

    // Suspending the replacement keeps the built-in controller from starting
    // Pods while preserving a supported upgrade Job for identity and step checks.
    const replacementJob = await renderJob(true);
    replacementJob.spec.suspend = true;
    await applyManifest(JSON.stringify(replacementJob.manifest));
    const second = (await admin("get", "job", name, "-o", "jsonpath={.metadata.uid}")).trim();
    assert.ok(second);
    assert.notEqual(second, first);
    handoff("plan", 1, /1\. Recover the original installation record/, "--expect-job-uid", first);
    handoff("doctor", 1, /completion not established/, "--expect-job-uid", second);

    // A replacement's chart labels cannot change which Job the original UID identifies.
    await admin("label", "job", name, "app.kubernetes.io/instance=other", "--overwrite");
    handoff("plan", 1, /1\. Recover the original installation record/, "--expect-job-uid", first);
    handoff(
      "doctor",
      1,
      /did not identify a retained initialization Job/,
      "--expect-job-uid",
      second,
    );
  },
);
