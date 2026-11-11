import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    const admin = async (...args: string[]) => String(await kubectl("-n", namespace, ...args));

    // Start with a new service account and no binding. Build its kubeconfig
    // from public cluster connection details only; never copy the admin user.
    await admin("create", "serviceaccount", "reader");
    const token = (await admin("create", "token", "reader", "--duration=10m")).trim();
    const clusters: unknown = JSON.parse(
      String(
        await kubectl(
          "config",
          "view",
          "--minify",
          "--flatten",
          "--raw",
          "-o",
          "jsonpath-as-json={.clusters[*]}",
        ),
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

    // Recognize the current rendered install without running migration or bootstrap.
    // Suspension preserves the real chart steps while preventing Pod creation.
    const installJob = await renderJob(false);
    installJob.spec.suspend = true;
    await applyManifest(JSON.stringify(installJob.manifest));
    const installUID = (await admin("get", "job", name, "-o", "jsonpath={.metadata.uid}")).trim();
    assert.ok(installUID);
    handoff("doctor", 1, /completion not established/, "--expect-job-uid", installUID);
    await admin("delete", "job", name);

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

test(
  "installation prerequisites report Job quota headroom, address drift and unreadable resources",
  { skip, timeout: 180_000 },
  async (t) => {
    await validateExplicitK3dLoopbackContext(selection);
    const { kubectl, applyManifest, waitFor } = createKubernetesClient({ selection });
    const dir = await mkdtemp(join(tmpdir(), "occ-prerequisites-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const namespace = `prerequisites-${randomUUID()}`;
    await kubectl("create", "namespace", namespace);
    t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));
    const resource = async (kind: string, name: string) =>
      JSON.parse(String(await kubectl("-n", namespace, "get", kind, name, "-o", "json")));
    // A scaled-to-zero controller is an intentional, reachable non-ready state.
    // The diagnostic must not interpret the Deployment's Available=True as readiness.
    await applyManifest(
      JSON.stringify({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "observer", namespace },
        spec: {
          replicas: 0,
          selector: { matchLabels: { app: "observer" } },
          template: {
            metadata: { labels: { app: "observer" } },
            spec: { containers: [{ name: "observer", image: "registry.k8s.io/pause:3.10" }] },
          },
        },
      }),
    );
    const service = JSON.parse(
      String(await kubectl("-n", "default", "get", "service", "kubernetes", "-o", "json")),
    );
    const slices = JSON.parse(
      String(
        await kubectl(
          "-n",
          "default",
          "get",
          "endpointslices",
          "-l",
          "kubernetes.io/service-name=kubernetes",
          "-o",
          "json",
        ),
      ),
    );
    const apiCidrs = [
      service.spec.clusterIP,
      ...slices.items
        .filter((item: { addressType: string }) => item.addressType === "IPv4")
        .flatMap((item: { endpoints: { addresses: string[] }[] }) =>
          item.endpoints.flatMap((endpoint) => endpoint.addresses),
        ),
    ].map((address: string) => `${address}/32`);
    const config = {
      kubeconfig: selection.kubeconfigPath,
      context: selection.kubernetesContext,
      namespace,
      gatewayClass: {
        name: `${namespace}-absent`,
        controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
      },
      controllers: [
        { namespace, name: "observer" },
        { namespace: "kube-system", name: "coredns" },
      ],
      apiCidrs,
      peakAdditional: { jobs: 2, replicaSets: 1 },
      crds: [
        { name: "missing.example.test", version: "v1" },
        { name: "addons.k3s.cattle.io", version: "v1" },
      ],
    };
    const configPath = join(dir, "plan.json");
    type Check = {
      id: string;
      status: string;
      limits?: { resource: string; status: string }[];
      stale?: string[];
      missing?: string[];
    };
    async function diagnose(plan = config, sensitiveValue?: string) {
      await writeFile(configPath, JSON.stringify(plan));
      const result = spawnSync(
        process.execPath,
        ["scripts/diagnose-kubernetes-prerequisites.mjs", "--config", configPath, "--json"],
        { encoding: "utf8", timeout: 100_000 },
      );
      assert.equal(result.error, undefined);
      if (sensitiveValue) {
        assert.ok(
          !result.stdout.includes(sensitiveValue) && !result.stderr.includes(sensitiveValue),
          "diagnostic output exposed a credential",
        );
      }
      assert.ok(!result.stderr, "diagnostic wrote to stderr");
      const report = JSON.parse(result.stdout);
      return {
        status: result.status,
        checks: new Map<string, Check>(report.checks.map((check: Check) => [check.id, check])),
      };
    }
    await waitFor("k3d DNS controller readiness", async () => {
      const dns = JSON.parse(
        String(await kubectl("-n", "kube-system", "get", "deployment", "coredns", "-o", "json")),
      );
      return (
        dns.status?.availableReplicas === dns.spec.replicas &&
        dns.status?.updatedReplicas === dns.spec.replicas
      );
    });
    const initial = await diagnose();
    assert.equal(initial.checks.get("kubernetes-api")?.status, "passed");
    assert.equal(initial.checks.get("api-addresses")?.status, "passed");
    assert.equal(initial.checks.get("resource-quotas")?.status, "passed");
    assert.equal(initial.checks.get(`controller:${namespace}/observer`)?.status, "failed");
    assert.equal(initial.checks.get("controller:kube-system/coredns")?.status, "passed");
    assert.equal(initial.checks.get("crd:addons.k3s.cattle.io")?.status, "passed");
    assert.equal(initial.checks.get("crd:missing.example.test")?.status, "failed");
    assert.equal(initial.status, 1);

    // ResourceQuota's own controller supplies usage. One slot remains, but the candidate needs two
    // concurrent Jobs. A full-quota-only check would miss this shortfall.
    await applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: { name: "one-job", namespace },
        spec: { hard: { "count/jobs.batch": "1" } },
      }),
    );
    await waitFor("quota controller reports its hard and used limits", async () => {
      const quota = await resource("resourcequota", "one-job");
      return (
        quota.status?.hard?.["count/jobs.batch"] === "1" &&
        quota.status?.used?.["count/jobs.batch"] === "0"
      );
    });
    const exhausted = await diagnose({ ...config, apiCidrs: ["192.0.2.1/32"] });
    assert.equal(exhausted.checks.get("resource-quotas")?.status, "failed");
    assert.deepEqual(
      exhausted.checks
        .get("resource-quotas")
        ?.limits?.filter((entry) => entry.status === "failed")
        .map((entry) => entry.resource),
      ["count/jobs.batch"],
    );
    assert.equal(exhausted.checks.get("api-addresses")?.status, "failed");
    assert.deepEqual(exhausted.checks.get("api-addresses")?.missing, [...new Set(apiCidrs)].sort());

    assert.deepEqual(exhausted.checks.get("api-addresses")?.stale, ["192.0.2.1/32"]);
    const fits = await diagnose({ ...config, peakAdditional: { jobs: 1, replicaSets: 1 } });
    assert.equal(fits.checks.get("resource-quotas")?.status, "passed");

    // The same real API refuses this identity. A refusal is incomplete evidence,
    // not a negative readiness observation; credentials must never enter output.
    await kubectl("-n", namespace, "create", "serviceaccount", "reader");
    const token = String(
      await kubectl("-n", namespace, "create", "token", "reader", "--duration=10m"),
    ).trim();
    const clusters = JSON.parse(
      String(
        await kubectl(
          "config",
          "view",
          "--minify",
          "--flatten",
          "--raw",
          "-o",
          "jsonpath-as-json={.clusters[*]}",
        ),
      ),
    );
    const deniedConfig = join(dir, "reader.json");
    await writeFile(
      deniedConfig,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters,
        contexts: [{ name: "reader", context: { cluster: clusters[0].name, user: "reader" } }],
        users: [{ name: "reader", user: { token } }],
      }),
      { mode: 0o600 },
    );
    const denied = await diagnose(
      { ...config, kubeconfig: deniedConfig, context: "reader" },
      token,
    );
    for (const id of [
      "resource-quotas",
      "api-addresses",
      "gateway-class",
      `controller:${namespace}/observer`,
    ]) {
      assert.equal(denied.checks.get(id)?.status, "unknown", id);
    }
    assert.equal(denied.status, 2);
  },
);

test("first install retains exact attempt evidence after a lost client", { skip }, async (t) => {
  await validateExplicitK3dLoopbackContext(selection);
  const { kubectl, resource } = createKubernetesClient({ selection });
  const dir = await mkdtemp(join(tmpdir(), "occ-install-receipt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const occ = join(dir, "occ");
  execFileSync("go", ["build", "-o", occ, "./cmd/occ"]);
  const namespace = `receipt-${randomUUID()}`;
  const release = "receipt";
  const name = `${release}-initialization`;
  await kubectl("create", "namespace", namespace);
  t.after(() => kubectl("delete", "namespace", namespace, "--wait=false"));
  const values = join(dir, "values.json");
  // Missing input Secrets/PVC keep the genuine chart Job pending. This proves
  // Helm dispatch and handoff, without claiming database initialization ran.
  await writeFile(
    values,
    JSON.stringify({
      gatewayRouting: { enabled: false },
      images: { controller: `registry.example.invalid/controller@sha256:${"a".repeat(64)}` },
      auth: { baseUrl: "https://occ.example.invalid", secretName: "occ-auth", secretKey: "secret" },
      agentNativeAdmin: { domain: "agents.example.invalid" },
      bootstrap: {
        adminEmail: "admin@example.invalid",
        password: { claimName: "absent-bootstrap" },
      },
      api: { clients: [{ namespace: "operator-tools", podLabels: { app: "operator" } }] },
      database: { cidrs: ["10.45.0.12/32"] },
      cluster: { cidrs: ["10.43.0.1/32"] },
    }),
  );
  const receipt = join(dir, "receipt");
  const target = [
    "--kubeconfig",
    selection.kubeconfigPath!,
    "--context",
    selection.kubernetesContext!,
    "--kube-namespace",
    namespace,
    "--release",
    release,
  ];
  const args = [
    "installation",
    "install",
    ...target,
    "--chart",
    "deploy/helm/openclaw-enterprise",
    "--values",
    values,
    "--receipt",
    receipt,
    "--wait-timeout",
    "2m",
  ];
  const child = spawn(occ, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TMPDIR: dir },
  });
  assert.ok(child.pid);
  // Disarm cleanup after termination or exit: process group IDs can be reused.
  let active = true;
  const terminate = () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  };
  t.after(terminate);
  const exited = new Promise((resolve) =>
    child.once("exit", (code) => {
      active = false;
      resolve(code);
    }),
  );
  let job: Awaited<ReturnType<typeof resource>> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      job = await resource("job", name, namespace);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(job, "real Helm install must create its initialization Job");
  // Wait for the durable UID, then lose both the installer and Helm before
  // release completion. Reconciliation must preserve that exact UID.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(join(receipt, "job.json"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const captured = JSON.parse(await readFile(join(receipt, "job.json"), "utf8"));
  assert.equal(captured.uid, job.metadata.uid);
  terminate();
  await exited;
  const intent = JSON.parse(await readFile(join(receipt, "intent.json"), "utf8"));
  assert.equal(job.metadata.annotations["openclaw.dev/installation-attempt"], intent.attempt);
  assert.match(intent.attempt, /^[a-f0-9]{64}$/);
  assert.equal((await stat(receipt)).mode & 0o777, 0o700);
  assert.equal((await stat(join(receipt, "intent.json"))).mode & 0o777, 0o600);
  await assert.rejects(readFile(join(receipt, "helm-result.json")), { code: "ENOENT" });
  const before = await readdir(receipt);
  const handoff = (action: string) =>
    spawnSync(occ, ["installation", action, ...target, "--receipt", receipt], { encoding: "utf8" });
  const observed = handoff("doctor");
  assert.equal(observed.status, 1, observed.stderr + observed.stdout);
  assert.match(observed.stdout, /completion not established/);
  assert.match(observed.stdout, /matches the recorded UID/);
  assert.deepEqual(
    await readdir(receipt),
    before,
    "read-only handoff does not rewrite the receipt",
  );
  assert.equal((await resource("job", name, namespace)).metadata.uid, job.metadata.uid);
  const retry = spawnSync(occ, args, { encoding: "utf8" });
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /not confirmed unused|never reuse/);
  assert.equal((await resource("job", name, namespace)).metadata.uid, job.metadata.uid);

  // A normally returned timeout persists both its separate Helm result and
  // the actual Job UID. Failure still cannot authorize a second install.
  const returnedReceipt = join(dir, "returned-receipt");
  const returnedArgs = [...args];
  returnedArgs[returnedArgs.indexOf("--release") + 1] = "returned";
  returnedArgs[returnedArgs.indexOf("--receipt") + 1] = returnedReceipt;
  returnedArgs[returnedArgs.indexOf("--wait-timeout") + 1] = "2s";
  const returned = spawnSync(occ, returnedArgs, {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir },
  });
  assert.equal(returned.status, 1, returned.stderr + returned.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(returnedReceipt, "helm-result.json"), "utf8")), {
    outcome: "failed",
  });
  const returnedJob = JSON.parse(await readFile(join(returnedReceipt, "job.json"), "utf8"));
  assert.equal(
    returnedJob.uid,
    (await resource("job", "returned-initialization", namespace)).metadata.uid,
  );

  // An upgrade must not inherit the first-install marker, even when Helm
  // retains its values. A replacement cannot silently become the original.
  const rendered = await renderProductionChart(
    { "installation.attemptId": intent.attempt },
    { namespace, release, isUpgrade: true },
  );
  const replacement = (await parseProductionChart(rendered.stdout)).find(
    (item: ChartResource) => item.kind === "Job",
  );
  assert.ok(replacement);
  assert.equal(replacement.metadata.annotations["openclaw.dev/installation-attempt"], undefined);
  replacement.metadata.namespace = namespace;
  replacement.spec.suspend = true;
  await kubectl("-n", namespace, "delete", "job", name);
  const file = join(dir, "replacement.json");
  await writeFile(file, JSON.stringify(replacement));
  await kubectl("apply", "-f", file);
  const replaced = handoff("plan");
  assert.equal(replaced.status, 1);
  assert.match(replaced.stdout, /does not identify the recorded installation attempt/);
});
