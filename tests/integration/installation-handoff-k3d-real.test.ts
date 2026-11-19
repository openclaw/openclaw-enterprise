import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.ts";
import {
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import { findChartJob } from "../helpers/production-chart-resource.ts";
import { parseProductionChart, renderProductionChart } from "../helpers/production-chart.ts";

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
      const job = findChartJob(await parseProductionChart(stdout), name);
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
    type Plan = typeof config & { serviceDependency?: unknown; clientCertificate?: unknown };
    const configPath = join(dir, "plan.json");
    type Check = {
      id: string;
      resource?: string;
      status: string;
      summary?: string;
      limits?: { resource: string; status: string }[];
      stale?: string[];
      missing?: string[];
      resources?: {
        kind: string;
        namespace: string;
        name: string;
        uid: string;
        resourceVersion: string;
      }[];
    };
    async function invokeDiagnostic(
      plan: Plan,
      sensitiveValues: string[] = [],
      env?: NodeJS.ProcessEnv,
    ) {
      await writeFile(configPath, JSON.stringify(plan));
      const result = spawnSync(
        process.execPath,
        ["scripts/diagnose-kubernetes-prerequisites.ts", "--config", configPath, "--json"],
        { encoding: "utf8", timeout: 100_000, env },
      );
      assert.equal(result.error, undefined);
      for (const sensitiveValue of sensitiveValues) {
        assert.ok(
          !result.stdout.includes(sensitiveValue) && !result.stderr.includes(sensitiveValue),
          "diagnostic output exposed certificate or credential material",
        );
      }
      return result;
    }
    async function diagnose(plan: Plan = config, sensitiveValues: string[] = []) {
      const result = await invokeDiagnostic(plan, sensitiveValues);
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
    assert.equal(initial.checks.has("service-egress"), false);
    assert.equal(initial.checks.has("service-tls"), false);
    assert.equal(initial.checks.has("client-certificate"), false);
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

    // The Service observes a live allocated address and a named target port.
    // The two policy grants cover the Service and its translated destination independently.
    const serviceName = "middleware";
    const policyName = "middleware-egress";
    const secretName = "middleware-tls";
    const serverName = "middleware.example.test";
    const otherName = "other.example.test";
    const servicePort = 9443;
    const targetPort = "https";
    const labels = { app: serviceName };
    await applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: serviceName, namespace },
        spec: { selector: labels, ports: [{ port: servicePort, targetPort }] },
      }),
    );
    const cidr = `${(await resource("service", serviceName)).spec.clusterIP}/32`;
    const namespaceSelector = { matchLabels: { "kubernetes.io/metadata.name": namespace } };
    const podSelector = { matchLabels: labels };
    const setPolicy = (
      address: string,
      peers: { namespaceSelector?: typeof namespaceSelector; podSelector?: typeof podSelector }[],
    ) =>
      applyManifest(
        JSON.stringify({
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: policyName, namespace },
          spec: {
            podSelector: { matchLabels: { app: "observer" } },
            policyTypes: ["Egress"],
            egress: [
              {
                to: [{ ipBlock: { cidr: address } }],
                ports: [{ protocol: "TCP", port: servicePort }],
              },
              { to: peers, ports: [{ protocol: "TCP", port: targetPort }] },
            ],
          },
        }),
      );
    await setPolicy("192.0.2.1/32", [{ namespaceSelector, podSelector }]);

    // Issue temporary leaves with the same generated key. Update only the public
    // certificate after the expired case. Neither certificate nor key belongs in the report.
    const ca = await certificateAuthority(dir, { caName: "prerequisites-fixture" });
    const expired = await signedLeaf(dir, ca, {
      name: "expired",
      commonName: serverName,
      subjectAltName: `DNS:${serverName}`,
      days: -1,
    });
    await kubectl(
      "-n",
      namespace,
      "create",
      "secret",
      "tls",
      secretName,
      `--cert=${expired.certPath}`,
      `--key=${expired.keyPath}`,
    );
    const protectedValues = [
      expired.key,
      Buffer.from(expired.key).toString("base64"),
      "BEGIN PRIVATE KEY",
      expired.cert,
      Buffer.from(expired.cert).toString("base64"),
      "BEGIN CERTIFICATE",
    ];
    async function setLeaf(pem: string, name = secretName) {
      const encoded = Buffer.from(pem).toString("base64");
      protectedValues.push(pem, encoded);
      const patch = join(dir, "certificate-patch.json");
      await writeFile(patch, JSON.stringify({ data: { "tls.crt": encoded } }));
      await kubectl(
        "-n",
        namespace,
        "patch",
        "secret",
        name,
        "--type=merge",
        "--patch-file",
        patch,
      );
    }
    const readVersions = () =>
      Promise.all(
        (
          [
            ["Service", "service", serviceName],
            ["NetworkPolicy", "networkpolicy", policyName],
            ["Secret", "secret", secretName],
          ] as const
        ).map(async ([kind, resourceKind, name]) => {
          const output = String(
            await kubectl(
              "-n",
              namespace,
              "get",
              resourceKind,
              name,
              "--no-headers",
              "-o",
              "custom-columns=UID:.metadata.uid,RV:.metadata.resourceVersion",
            ),
          );
          const [uid, resourceVersion] = output.trim().split(/\s+/u);
          assert.ok(uid && resourceVersion);
          return { kind, namespace, name, uid, resourceVersion };
        }),
      );
    const dependency = {
      service: { namespace, name: serviceName, port: servicePort },
      policy: { namespace, name: policyName },
      tls: { secretName, serverName },
    };
    const dependencyPlan = { ...config, serviceDependency: dependency };
    const egressOnly = { service: dependency.service, policy: dependency.policy };
    // A misspelled optional selection must not silently remove the requested checks.
    const unknownSelection = { ...config, serviceDependecy: dependency };
    const unknownRoot = await invokeDiagnostic(unknownSelection, protectedValues);
    assert.equal(unknownRoot.status, 2);
    assert.equal(unknownRoot.stdout, "");
    assert.match(unknownRoot.stderr, /only supported top-level fields/u);

    const typoPlan = { ...config, serviceDependency: { ...egressOnly, tsl: dependency.tls } };
    const typo = await invokeDiagnostic(typoPlan, protectedValues);
    assert.equal(typo.status, 2);
    assert.equal(typo.stdout, "");
    assert.match(typo.stderr, /serviceDependency accepts only service, policy and tls/u);

    async function checkDependency() {
      const versions = await readVersions();
      const result = await diagnose(dependencyPlan, protectedValues);
      assert.deepEqual(
        await readVersions(),
        versions,
        "the diagnostic must leave all selected objects unchanged",
      );
      const egress = result.checks.get("service-egress");
      const tls = result.checks.get("service-tls");
      assert.deepEqual(egress?.resources, versions.slice(0, 2));
      assert.deepEqual(tls?.resources, versions.slice(2));
      return { egress, tls };
    }
    const stale = await checkDependency();
    assert.equal(stale.egress?.status, "failed");
    assert.deepEqual(stale.egress?.missing, [`${cidr} TCP/${servicePort}`]);
    assert.equal(stale.tls?.status, "failed");
    assert.match(stale.tls?.summary ?? "", /expired/u);

    // Split selectors create two broad peers and do not establish the combined edge.
    await setPolicy(cidr, [{ namespaceSelector }, { podSelector }]);
    const wrongSan = await signedLeaf(dir, ca, {
      name: "wrong-san",
      commonName: serverName,
      subjectAltName: `DNS:${otherName}`,
      keyPem: expired.key,
    });
    await setLeaf(wrongSan.cert);
    const split = await checkDependency();
    assert.equal(split.egress?.status, "failed");
    assert.deepEqual(split.egress?.missing, [
      `${namespace} Service-selected Pods TCP/${targetPort}`,
    ]);
    assert.equal(split.tls?.status, "failed");
    assert.match(split.tls?.summary ?? "", /DNS SAN/u);

    await setPolicy(cidr, [{ namespaceSelector, podSelector }]);
    // Repair the certificate to match the intended client's unchanged server name.
    const repaired = await signedLeaf(dir, ca, {
      name: "repaired",
      commonName: serverName,
      subjectAltName: `DNS:${serverName}`,
      keyPem: expired.key,
    });
    await setLeaf(repaired.cert);
    const corrected = await checkDependency();
    assert.equal(corrected.egress?.status, "passed");
    assert.equal(corrected.tls?.status, "passed");
    const policyOnly = await diagnose(
      { ...config, serviceDependency: egressOnly },
      protectedValues,
    );
    assert.equal(policyOnly.checks.get("service-egress")?.status, "passed");
    assert.equal(policyOnly.checks.has("service-tls"), false);

    // ExternalName is a DNS alias in both API shapes. A declared port cannot
    // supply the ClusterIP and Pod edges that the check requires.
    for (const hasPort of [false, true]) {
      const name = hasPort ? "alias-with-port" : "alias-without-port";
      await applyManifest(
        JSON.stringify({
          apiVersion: "v1",
          kind: "Service",
          metadata: { name, namespace },
          spec: {
            type: "ExternalName",
            externalName: "middleware.example.test",
            ports: hasPort ? [{ port: servicePort }] : undefined,
          },
        }),
      );
      const observed = await resource("service", name);
      assert.equal(observed.spec.ports?.[0]?.port, hasPort ? servicePort : undefined);
      const alias = await diagnose({
        ...config,
        serviceDependency: { ...egressOnly, service: { ...egressOnly.service, name } },
      });
      const egress = alias.checks.get("service-egress");
      assert.equal(egress?.status, "failed", name);
      assert.match(egress?.summary ?? "", /ExternalName/u);
      assert.deepEqual(egress?.resources, [
        {
          kind: "Service",
          namespace,
          name,
          uid: observed.metadata.uid,
          resourceVersion: observed.metadata.resourceVersion,
        },
      ]);
    }

    const commonNameOnly = await signedLeaf(dir, ca, {
      name: "common-name-only",
      commonName: serverName,
      keyPem: expired.key,
    });
    const commonNameLeaf = new X509Certificate(commonNameOnly.cert);
    assert.equal(commonNameLeaf.subjectAltName, undefined);
    assert.equal(commonNameLeaf.checkHost(serverName), serverName);
    await setLeaf(commonNameOnly.cert);
    const noSan = await checkDependency();
    assert.equal(noSan.tls?.status, "failed");
    assert.match(noSan.tls?.summary ?? "", /DNS SAN/u);

    // Keep the SAN and other validity bound intact while corrupting one ASN.1 UTCTime.
    const leaf = new X509Certificate(repaired.cert);
    const validityFields = ["validFromDate", "validToDate"] as const;
    for (const field of validityFields) {
      const utc = leaf[field].toISOString().slice(2, 19).replace(/\D/g, "") + "Z";
      const der = Buffer.from(leaf.raw);
      const fieldBytes = Buffer.concat([Buffer.from([0x17, utc.length]), Buffer.from(utc)]);
      const offset = der.indexOf(fieldBytes);
      assert.ok(offset >= 0);
      assert.equal(der.indexOf(fieldBytes, offset + 1), -1);
      der.write("13", offset + 4, 2, "ascii");
      const corrupt = new X509Certificate(der);
      for (const validityField of validityFields) {
        assert.equal(Number.isFinite(corrupt[validityField].getTime()), validityField !== field);
      }
      assert.equal(corrupt.checkHost(serverName, { subject: "never" }), serverName);
      const encoded = der
        .toString("base64")
        .match(/.{1,64}/g)
        ?.join("\n");
      assert.ok(encoded);
      await setLeaf(`-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`);
      const result = await checkDependency();
      assert.equal(result.tls?.status, "failed");
      assert.match(result.tls?.summary ?? "", /unreadable validity window/u);
    }

    const clientName = "gateway-client";
    const clientSecret = "mounted-client";
    const detachedSecret = "detached-client";
    const detachedItem = "detached-only.pem";
    const clientLeaf = await signedLeaf(dir, ca, {
      name: "current-client",
      commonName: clientName,
      usage: "clientAuth",
      keyPem: expired.key,
    });
    for (const name of [clientSecret, detachedSecret]) {
      await kubectl(
        "-n",
        namespace,
        "create",
        "secret",
        "tls",
        name,
        `--cert=${clientLeaf.certPath}`,
        `--key=${clientLeaf.keyPath}`,
      );
    }
    protectedValues.push(clientLeaf.cert, Buffer.from(clientLeaf.cert).toString("base64"));
    const unrelatedSecretKey = "unrelated-fixture-key";
    const unrelatedSecretValue = Buffer.from(randomUUID()).toString("base64");
    await kubectl(
      "-n",
      namespace,
      "patch",
      "secret",
      clientSecret,
      "--type=merge",
      "-p",
      JSON.stringify({ data: { [unrelatedSecretKey]: unrelatedSecretValue } }),
    );
    protectedValues.push(unrelatedSecretKey, unrelatedSecretValue);
    const clientLabels = { app: clientName };
    const excludedValue = randomUUID();
    const mountPath = "/etc/openclaw/openshell";
    const unrelatedMountPath = "/etc/unrelated";
    const otherContainer = "unrelated-container";
    const otherContainerMountPath = "/etc/other-container";
    const worker = {
      name: "worker",
      image: "example.invalid/client:test",
      env: [{ name: "UNRELATED_FIXTURE_VALUE", value: excludedValue }],
      volumeMounts: [
        { name: "client", mountPath, readOnly: true },
        { name: "scratch", mountPath: unrelatedMountPath },
      ],
    };
    const publicItem = { key: "tls.crt", path: "admin.pem" };
    const clientVolume = {
      name: "client",
      secret: { secretName: clientSecret, items: [publicItem] },
    };
    const clientCertificate = {
      workload: { kind: "Deployment", namespace, name: clientName },
      container: "worker",
      certificatePath: `${mountPath}/admin.pem`,
    };
    await applyManifest(
      JSON.stringify({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: clientName,
          namespace,
          annotations: { "example.test/unrelated": excludedValue },
        },
        spec: {
          replicas: 0,
          selector: { matchLabels: clientLabels },
          template: {
            metadata: { labels: clientLabels },
            spec: {
              containers: [
                worker,
                {
                  name: otherContainer,
                  image: worker.image,
                  volumeMounts: [{ name: "scratch", mountPath: otherContainerMountPath }],
                },
              ],
              volumes: [
                clientVolume,
                { name: "scratch", emptyDir: {} },
                {
                  name: "detached",
                  secret: {
                    secretName: detachedSecret,
                    items: [{ key: "tls.crt", path: detachedItem }],
                  },
                },
              ],
            },
          },
        },
      }),
    );
    const clientPlan = { ...config, clientCertificate };
    const overlapPlan = {
      ...clientPlan,
      controllers: [...config.controllers, { namespace, name: clientName }],
    };

    // Observe real kubectl stdout at the subprocess boundary. Checking only
    // the final report would miss unrelated data already captured by the CLI.
    const kubectlPath = execFileSync("sh", ["-c", "command -v kubectl"], {
      encoding: "utf8",
    }).trim();
    const commandLog = join(dir, "kubectl-observations");
    await writeFile(
      join(dir, "kubectl"),
      String.raw`#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { appendFileSync, fstatSync, statSync } = require("node:fs");
const args = process.argv.slice(2);
const stdinProjection = args.includes("go-template-file=/dev/stdin");
const result = spawnSync(${JSON.stringify(kubectlPath)}, args, {
  encoding: "utf8",
  stdio: [stdinProjection ? 0 : "ignore", "pipe", "pipe"],
  env: { ...process.env, PATH: process.env.OCC_FIXTURE_ORIGINAL_PATH },
});
let observation = {};
if (args.includes("get") && args.includes("deployments.apps") && args.includes(${JSON.stringify(clientName)})) {
  const stderr = fstatSync(2);
  observation = {
    workload: true,
    selectedMount: result.stdout?.includes(${JSON.stringify(mountPath)}),
    excludedValue: result.stdout?.includes(${JSON.stringify(excludedValue)}),
    excludedFields: /"env"|"annotations"/u.test(result.stdout ?? ""),
    detachedSecret: [${JSON.stringify(detachedSecret)}, ${JSON.stringify(detachedItem)}]
      .some((value) => result.stdout?.includes(value)),
    unrelatedMount: result.stdout?.includes(${JSON.stringify(unrelatedMountPath)}),
    otherContainer: [${JSON.stringify(otherContainer)}, ${JSON.stringify(otherContainerMountPath)}]
      .some((value) => result.stdout?.includes(value)),
    stderrDiscarded: stderr.isCharacterDevice() && stderr.rdev === statSync("/dev/null").rdev,
  };
}
if (args.includes("get") && args.includes("secret") && args.includes(${JSON.stringify(clientSecret)})) {
  observation = {
    secret: true,
    unrelatedSecretData: [${JSON.stringify(unrelatedSecretKey)}, ${JSON.stringify(unrelatedSecretValue)}]
      .some((value) => result.stdout?.includes(value)),
    stdinProjection: stdinProjection && fstatSync(0).isFIFO(),
  };
}
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(observation) + "\n");
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
`,
      { mode: 0o700 },
    );
    const projectionEnv = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      OCC_FIXTURE_ORIGINAL_PATH: process.env.PATH,
    };
    await writeFile(commandLog, "");
    const misspelledSelection = { ...config, clientCertifcate: clientCertificate };
    const misspelledClient = await invokeDiagnostic(
      misspelledSelection,
      protectedValues,
      projectionEnv,
    );
    assert.equal(misspelledClient.status, 2);
    assert.equal(misspelledClient.stdout, "");
    assert.match(misspelledClient.stderr, /only supported top-level fields/u);
    assert.equal(await readFile(commandLog, "utf8"), "");

    const clientCheck = async (plan: Plan = clientPlan) =>
      (await diagnose(plan, protectedValues)).checks.get("client-certificate");
    const identity = async (kind: string, resourceKind: string, name: string) => {
      const { uid, resourceVersion } = (await resource(resourceKind, name)).metadata;
      return { kind, namespace, name, uid, resourceVersion };
    };
    await waitFor("client Deployment generation observation", async () => {
      const deployment = await resource("deployment", clientName);
      return deployment.status?.observedGeneration === deployment.metadata.generation;
    });
    const workloadIdentity = await identity("Deployment", "deployment", clientName);
    const secretIdentity = await identity("Secret", "secret", clientSecret);
    const observedClient = await invokeDiagnostic(
      overlapPlan,
      [...protectedValues, excludedValue],
      projectionEnv,
    );
    assert.equal(observedClient.stderr, "");
    const observedChecks = JSON.parse(observedClient.stdout).checks as Check[];
    const bound = observedChecks.find(({ id }) => id === "client-certificate");
    const rollout = observedChecks.find(({ id }) => id === `controller:${namespace}/${clientName}`);
    assert.equal(
      rollout?.status,
      "failed",
      "the selected certificate Deployment has zero replicas",
    );
    assert.equal(rollout?.resource, `${namespace}/${clientName}@${workloadIdentity.uid}`);
    const observations = (await readFile(commandLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const secretOutput = observations.filter(({ secret }) => secret);
    assert.equal(secretOutput.length, 1);
    const [secretProjection] = secretOutput;
    assert.equal(secretProjection.unrelatedSecretData, false);
    assert.equal(secretProjection.stdinProjection, true);
    const workloadOutput = observations.filter(({ workload }) => workload);
    assert.deepEqual(workloadOutput, [
      {
        workload: true,
        selectedMount: false,
        excludedValue: false,
        excludedFields: false,
        detachedSecret: false,
        unrelatedMount: false,
        otherContainer: false,
        stderrDiscarded: true,
      },
      {
        workload: true,
        selectedMount: true,
        excludedValue: false,
        excludedFields: false,
        detachedSecret: false,
        unrelatedMount: false,
        otherContainer: false,
        stderrDiscarded: true,
      },
    ]);
    assert.equal(bound?.status, "passed");
    assert.deepEqual(bound?.resources, [workloadIdentity, secretIdentity]);
    assert.deepEqual(await identity("Deployment", "deployment", clientName), workloadIdentity);
    assert.deepEqual(await identity("Secret", "secret", clientSecret), secretIdentity);

    await setLeaf(expired.cert, clientSecret);
    const expiredClient = await clientCheck();
    assert.equal(expiredClient?.status, "failed");
    assert.match(expiredClient?.summary ?? "", /expired/u);
    assert.equal(expiredClient?.resources?.at(-1)?.name, clientSecret);
    await setLeaf(repaired.cert, clientSecret);
    const wrongUsage = await clientCheck();
    assert.equal(wrongUsage?.status, "failed");
    assert.match(wrongUsage?.summary ?? "", /extended key usage does not permit client/u);
    for (const [name, extension] of [
      ["no-client-eku", ""],
      ["unreadable-client-eku", "2.5.29.37=critical,DER:05:00"],
    ] as const) {
      const unconfirmed = await signedLeaf(dir, ca, {
        name,
        usage: "clientAuth",
        keyPem: expired.key,
        run: async (command, args) => {
          if (args[0] === "x509") {
            const extensions = args[args.indexOf("-extfile") + 1];
            assert.ok(extensions);
            const original = await readFile(extensions, "utf8");
            assert.match(original, /^extendedKeyUsage=clientAuth$/mu);
            await writeFile(
              extensions,
              original.replace(/^extendedKeyUsage=clientAuth$/mu, extension),
            );
          }
          return execFileSync(command, args);
        },
      });
      assert.equal(new X509Certificate(unconfirmed.cert).keyUsage, undefined);
      await setLeaf(unconfirmed.cert, clientSecret);
      const result = await clientCheck();
      assert.equal(result?.status, "unknown");
      assert.match(result?.summary ?? "", /current.*does not establish client authentication/u);
      assert.deepEqual(result?.resources, [
        workloadIdentity,
        await identity("Secret", "secret", clientSecret),
      ]);
    }
    await setLeaf(clientLeaf.cert, clientSecret);

    const peerClients = ["stateful-client", "claim-client", "alias-client"] as const;
    const [peerName, claimName, aliasName] = peerClients;
    const peerClientPlan = (name: (typeof peerClients)[number]) => ({
      ...clientPlan,
      clientCertificate: {
        ...clientCertificate,
        workload: { kind: "StatefulSet", namespace, name },
      },
    });
    const aliasItems = [publicItem, { key: "tls.key", path: "./admin.pem" }];
    for (const name of peerClients) {
      const peerLabels = { app: name };
      await applyManifest(
        JSON.stringify({
          apiVersion: "apps/v1",
          kind: "StatefulSet",
          metadata: { name, namespace },
          spec: {
            replicas: 0,
            serviceName,
            selector: { matchLabels: peerLabels },
            template: {
              metadata: { labels: peerLabels },
              spec: {
                containers: [{ name: "broker", image: worker.image }],
                initContainers: [{ ...worker, restartPolicy: "Always" }],
                volumes: [
                  name === aliasName
                    ? { ...clientVolume, secret: { ...clientVolume.secret, items: aliasItems } }
                    : clientVolume,
                  { name: "scratch", emptyDir: {} },
                ],
              },
            },
            ...(name === claimName
              ? {
                  volumeClaimTemplates: [
                    {
                      metadata: { name: clientVolume.name },
                      spec: {
                        accessModes: ["ReadWriteOnce"],
                        resources: { requests: { storage: "1Mi" } },
                      },
                    },
                  ],
                }
              : {}),
          },
        }),
      );
      await waitFor(`StatefulSet generation for ${name}`, async () => {
        const peer = await resource("statefulset", name);
        return peer.status?.observedGeneration === peer.metadata.generation;
      });
    }
    const peer = await clientCheck(peerClientPlan(peerName));
    assert.equal(peer?.status, "passed");
    assert.deepEqual(peer?.resources, [
      await identity("StatefulSet", "statefulset", peerName),
      await identity("Secret", "secret", clientSecret),
    ]);
    const claimed = await resource("statefulset", claimName);
    assert.equal(claimed.spec.volumeClaimTemplates[0].metadata.name, clientVolume.name);
    assert.equal(claimed.spec.template.spec.volumes[0].secret.secretName, clientSecret);
    const aliased = await resource("statefulset", aliasName);
    assert.deepEqual(aliased.spec.template.spec.volumes[0].secret.items, aliasItems);

    const unmounted = await clientCheck({
      ...clientPlan,
      clientCertificate: { ...clientCertificate, certificatePath: "/etc/detached/tls.crt" },
    });
    assert.equal(unmounted?.status, "failed");
    assert.match(unmounted?.summary ?? "", /does not resolve to one mounted tls\.crt/u);
    assert.deepEqual(unmounted?.resources, [workloadIdentity]);
    const override = await invokeDiagnostic(
      {
        ...clientPlan,
        clientCertificate: { ...clientCertificate, secretName: detachedSecret },
      },
      protectedValues,
    );
    assert.equal(override.status, 2);
    assert.equal(override.stdout, "");
    assert.match(
      override.stderr,
      /clientCertificate accepts only workload, container and certificatePath/u,
    );

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
      { ...dependencyPlan, kubeconfig: deniedConfig, context: "reader" },
      [token, ...protectedValues],
    );
    for (const id of [
      "resource-quotas",
      "api-addresses",
      "gateway-class",
      `controller:${namespace}/observer`,
      "service-egress",
      "service-tls",
    ]) {
      assert.equal(denied.checks.get(id)?.status, "unknown", id);
    }
    assert.equal(denied.status, 2);

    await kubectl(
      "-n",
      namespace,
      "create",
      "role",
      "client-workload-reader",
      "--verb=get",
      "--resource=deployments.apps,statefulsets.apps",
      `--resource-name=${clientName}`,
      ...[claimName, aliasName].map((name) => `--resource-name=${name}`),
    );
    await kubectl(
      "-n",
      namespace,
      "create",
      "rolebinding",
      "client-workload-reader",
      "--role=client-workload-reader",
      `--serviceaccount=${namespace}:reader`,
    );
    const deniedClient = await diagnose(
      { ...clientPlan, kubeconfig: deniedConfig, context: "reader" },
      [token, ...protectedValues],
    );
    const deniedSecret = deniedClient.checks.get("client-certificate");
    assert.equal(deniedSecret?.status, "unknown");
    assert.match(deniedSecret?.summary ?? "", /named resource could not be read.*get access/u);
    assert.deepEqual(deniedSecret?.resources, [workloadIdentity]);

    const workerMounts = "/spec/template/spec/containers/0/volumeMounts";
    async function patchWorkerMounts(operations: object[]) {
      await kubectl(
        "-n",
        namespace,
        "patch",
        "deployment",
        clientName,
        "--type=json",
        "-p",
        JSON.stringify(operations),
      );
    }
    const selectedMount = `${workerMounts}/0/mountPath`;
    // An equivalent spelling of the only mount path still resolves to the leaf.
    await patchWorkerMounts([{ op: "replace", path: selectedMount, value: `${mountPath}//./` }]);
    assert.equal((await clientCheck())?.status, "passed");

    // A differently written parent path still shadows the selected file. The
    // reader has no Secret access, so a premature Secret GET would be unknown.
    const shadow = { name: "scratch", mountPath: "/etc/openclaw//./" };
    await patchWorkerMounts([{ op: "add", path: `${workerMounts}/-`, value: shadow }]);
    await waitFor("shadow mount Deployment generation observation", async () => {
      const deployment = await resource("deployment", clientName);
      return deployment.status?.observedGeneration === deployment.metadata.generation;
    });
    const overlap = await diagnose({ ...clientPlan, kubeconfig: deniedConfig, context: "reader" }, [
      token,
      ...protectedValues,
    ]);
    const shadowed = overlap.checks.get("client-certificate");
    assert.equal(shadowed?.status, "failed");
    assert.match(shadowed?.summary ?? "", /does not resolve to one mounted tls\.crt/u);
    assert.deepEqual(shadowed?.resources, [await identity("Deployment", "deployment", clientName)]);
    await patchWorkerMounts([
      { op: "test", path: `${workerMounts}/2/mountPath`, value: shadow.mountPath },
      { op: "remove", path: `${workerMounts}/2` },
      { op: "replace", path: selectedMount, value: mountPath },
    ]);

    // A Secret read under this identity would be unknown, like the control above.
    for (const name of [claimName, aliasName]) {
      const invalid = await diagnose(
        { ...peerClientPlan(name), kubeconfig: deniedConfig, context: "reader" },
        [token, ...protectedValues],
      );
      const result = invalid.checks.get("client-certificate");
      assert.equal(result?.status, "failed");
      assert.match(result?.summary ?? "", /does not resolve to one mounted tls\.crt/u);
      assert.deepEqual(result?.resources, [await identity("StatefulSet", "statefulset", name)]);
    }

    const companionItems = [publicItem, { key: "companion", path: "companion.txt" }];
    async function updateClientVolume(secret: typeof clientVolume.secret & { optional?: boolean }) {
      const patchPath = join(dir, "client-volume-patch.json");
      await writeFile(
        patchPath,
        JSON.stringify([
          { op: "replace", path: "/spec/template/spec/volumes/0/secret", value: secret },
        ]),
        { mode: 0o600 },
      );
      await kubectl(
        "-n",
        namespace,
        "patch",
        "deployment",
        clientName,
        "--type=json",
        "--patch-file",
        patchPath,
      );
    }
    // The large mapping fits in a Kubernetes object. The check must handle it
    // and accept a required key with an empty value.
    const largeItems = Array.from({ length: 500 }, (_, index) => ({
      key: `mapping-${String(index).padStart(3, "0")}-${"x".repeat(241)}`,
      path: `mapped-${index}.txt`,
    }));
    const data = Object.fromEntries(largeItems.map(({ key }) => [key, ""]));
    const secretPatch = join(dir, "client-secret-patch.json");
    await writeFile(secretPatch, JSON.stringify({ data: { ...data, companion: "" } }), {
      mode: 0o600,
    });
    await kubectl(
      "-n",
      namespace,
      "patch",
      "secret",
      clientSecret,
      "--type=merge",
      "--patch-file",
      secretPatch,
    );
    await updateClientVolume({ ...clientVolume.secret, items: [...companionItems, ...largeItems] });
    assert.equal((await clientCheck())?.status, "passed");

    // Once removed, the same companion key blocks a required volume and is
    // skipped in an optional volume. Both still need the selected public leaf.
    await updateClientVolume({ ...clientVolume.secret, items: companionItems });
    await kubectl(
      "-n",
      namespace,
      "patch",
      "secret",
      clientSecret,
      "--type=merge",
      "-p",
      JSON.stringify({ data: { companion: null } }),
    );
    const requiredCompanion = await clientCheck();
    assert.equal(requiredCompanion?.status, "failed");
    assert.match(requiredCompanion?.summary ?? "", /maps a required key that the Secret lacks/u);
    await updateClientVolume({ ...clientVolume.secret, items: companionItems, optional: true });
    assert.equal((await clientCheck())?.status, "passed");
    const noLeafSecret = "client-without-public-leaf";
    await kubectl("-n", namespace, "create", "secret", "generic", noLeafSecret);
    await updateClientVolume({ ...clientVolume.secret, secretName: noLeafSecret, optional: true });
    const noLeaf = await clientCheck();
    assert.equal(noLeaf?.status, "failed");
    assert.match(noLeaf?.summary ?? "", /lacks a readable X.509 leaf in tls\.crt/u);
    await updateClientVolume(clientVolume.secret);

    await kubectl("-n", namespace, "delete", "secret", clientSecret);
    const missingClient = await clientCheck();
    assert.equal(missingClient?.status, "failed");
    assert.match(missingClient?.summary ?? "", /TLS Secret does not exist/u);
    assert.deepEqual(missingClient?.resources, [
      await identity("Deployment", "deployment", clientName),
    ]);

    const missingService = "missing-middleware";
    const role = "missing-service-reader";
    await kubectl(
      "-n",
      namespace,
      "create",
      "role",
      role,
      "--verb=get",
      "--resource=services",
      `--resource-name=${missingService}`,
    );
    await kubectl(
      "-n",
      namespace,
      "create",
      "rolebinding",
      role,
      `--role=${role}`,
      `--serviceaccount=${namespace}:reader`,
    );
    const missing = await diagnose(
      {
        ...config,
        kubeconfig: deniedConfig,
        context: "reader",
        serviceDependency: {
          service: { ...dependency.service, name: missingService },
          policy: dependency.policy,
        },
      },
      [token, ...protectedValues],
    );
    assert.equal(missing.checks.get("service-egress")?.status, "failed");
    assert.match(missing.checks.get("service-egress")?.summary ?? "", /Service does not exist/u);
    assert.equal(missing.status, 1);
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
  // Missing input Secrets keep the genuine chart Job pending. Select existing
  // credentials below so neither install generates inputs or creates a Secret.
  // This proves Helm dispatch and handoff, not database initialization.
  await writeFile(
    values,
    JSON.stringify({
      gatewayRouting: { enabled: false },
      images: { controller: `registry.example.invalid/controller@sha256:${"a".repeat(64)}` },
      auth: { baseUrl: "https://occ.example.invalid", secretName: "occ-auth", secretKey: "secret" },
      agentNativeAdmin: { domain: "agents.example.invalid" },
      bootstrap: {
        adminEmail: "admin@example.invalid",
        credentials: { secretName: "absent-bootstrap" },
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
    "--bootstrap-credentials=existing",
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
  const jobMetadata = async (jobName: string) => {
    const metadata = asRecord(asRecord(await resource("job", jobName, namespace))?.metadata);
    assert.ok(typeof metadata?.uid === "string" && metadata.uid, "expected the Job UID");
    return metadata;
  };
  let job: Awaited<ReturnType<typeof jobMetadata>> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      job = await jobMetadata(name);
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
  assert.equal(captured.uid, job.uid);
  terminate();
  await exited;
  const intent = JSON.parse(await readFile(join(receipt, "intent.json"), "utf8"));
  assert.equal(asRecord(job.annotations)?.["openclaw.dev/installation-attempt"], intent.attempt);
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
  assert.equal((await jobMetadata(name)).uid, job.uid);
  const retry = spawnSync(occ, args, { encoding: "utf8" });
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /not confirmed unused|never reuse/);
  assert.equal((await jobMetadata(name)).uid, job.uid);

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
  assert.equal(returnedJob.uid, (await jobMetadata("returned-initialization")).uid);

  // An upgrade must not inherit the first-install marker, even when Helm
  // retains its values. A replacement cannot silently become the original.
  const rendered = await renderProductionChart(
    { "installation.attemptId": intent.attempt },
    { namespace, release, isUpgrade: true },
  );
  const replacement = findChartJob(await parseProductionChart(rendered.stdout));
  const annotations = asRecord(replacement.metadata.annotations);
  assert.ok(annotations, "Expected initialization Job annotations");
  assert.equal(annotations["openclaw.dev/installation-attempt"], undefined);
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
