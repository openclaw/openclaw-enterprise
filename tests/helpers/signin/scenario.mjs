import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { rehearsalPlane } from "../staging-upgrade-return.ts";
import { signinAdmission } from "./admission.mjs";
import { fixtureClock } from "./clock.mjs";
import { controllerCut } from "./controller-cut.mjs";
import { fixtureFetch, retainedCatalog } from "./custody-probes.mjs";
import { tcpControlCommand, tcpProbeCommand } from "./network-probe.ts";
import { runtimeProof } from "./runtime.mjs";
import { trafficGate } from "./traffic-gate.mjs";
import { runTransition } from "./transition.ts";
import { writerFence } from "./writer-fence.mjs";

const origin = "https://console.signin-rehearsal.test";
const startupSecret = "occ-installation-startup";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function rehearseSignin({
  rehearsal,
  system,
  release,
  custody,
  kubectl,
  kubeArgs,
  localCluster,
  waitFor,
  run,
  record,
  api,
  namespace,
  tenant,
  materialization,
  signinSetup,
  dns,
}) {
  const { port, ca, adminEmail, installationId } = signinSetup;
  const images = { P: rehearsal.previous, A: rehearsal.candidate };
  const { signinPlan, canAdmit } = rehearsal;
  const usesV2 = signinPlan.previous.version === 2;
  const kube = (...args) => kubectl("-n", system, ...args);
  const protectedArgs = [...kubeArgs, "--namespace", system, "--request-timeout=30s"];
  const read = (...args) => run("kubectl", [...protectedArgs, ...args], { protectedInput: true });
  const get = async (resource) => JSON.parse(await read("get", resource, "-o", "json"));
  const consoleFetch = fixtureFetch(origin, "127.0.0.1", port, ca);
  const operator = signinSetup.operator;
  await operator("mv", "/operator/signin-gate.bootstrap", "/operator/signin-gate.retained");
  const gate = trafficGate(operator, consoleFetch, origin);
  const plane = rehearsalPlane({
    kube,
    get,
    run,
    release,
    localCluster,
    namespace: system,
    kubeconfig: localCluster.selection.kubeconfigPath,
    context: localCluster.selection.kubernetesContext,
  });
  const runtime = runtimeProof({
    localCluster,
    custody,
    namespace: system,
    release,
    run,
    kubeArgs: protectedArgs,
    get,
    waitFor,
    verifyPodImage: plane.verifyPodImage,
  });

  const matches = (sel, labels) => {
    if (!Object.entries(sel.matchLabels ?? {}).every(([k, v]) => labels[k] === v)) {
      return false;
    }
    return (sel.matchExpressions ?? []).every((e) => {
      if (e.operator === "In") {
        return e.values.includes(labels[e.key]);
      }
      if (e.operator === "NotIn") {
        return !e.values.includes(labels[e.key]);
      }
      if (e.operator === "Exists") {
        return Object.hasOwn(labels, e.key);
      }
      if (e.operator === "DoesNotExist") {
        return !Object.hasOwn(labels, e.key);
      }
      throw new Error("unknown selector");
    });
  };

  async function checkTopology(acknowledgedApiLabels = []) {
    await localCluster.assertCluster();
    await custody.assertPostgres();
    await materialization.assertDatabaseImage();
    await custody.assertRelease();
    const [policies, services, ingress, operators, deployment, currentPods] = await Promise.all([
      get("networkpolicies"),
      get("services"),
      get("ingresses"),
      read("get", "pods", "-l", "app=production-tui-proxy", "-o", "json").then(JSON.parse),
      get("deployment/openclaw-enterprise-api"),
      plane.pods(),
    ]);
    assert.equal(operators.items.length, 1);
    custody.assertUID("pod/operator", operators.items[0].metadata.uid);
    assert(services.items.every((s) => s.spec.type === "ClusterIP" && !s.spec.externalIPs?.length));
    assert.equal(ingress.items.length, 0);
    const relevant = policies.items.filter(
      (p) => p.spec.policyTypes?.includes("Ingress") && p.spec.ingress?.length,
    );
    assert.equal(deployment.metadata.labels["app.kubernetes.io/instance"], release);
    // Keep checking the template while writers are stopped. Live Pods can have
    // additional labels, so check each one, including the exact admitted UIDs.
    const labels = [
      deployment.spec.template.metadata.labels,
      ...currentPods
        .filter((p) => p.metadata.labels["app.kubernetes.io/component"] === "api")
        .map((p) => p.metadata.labels),
      ...acknowledgedApiLabels,
    ];
    for (const label of labels) {
      const apiRules = relevant.filter((p) => matches(p.spec.podSelector, label));
      assert.equal(apiRules.length, 1, "API ingress must allow only the owned proxy");
      assert.deepEqual(apiRules[0].spec.ingress, [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": system } },
              podSelector: { matchLabels: { app: "production-tui-proxy" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ]);
    }
    assert(!relevant.some((p) => matches(p.spec.podSelector, operators.items[0].metadata.labels)));
    const deny = policies.items.find((p) => p.metadata.name === "signin-operator-private");
    custody.assertUID("networkpolicy/signin-operator-private", deny.metadata.uid);
    assert(
      !deny.spec.ingress?.length &&
        matches(deny.spec.podSelector, operators.items[0].metadata.labels),
    );
  }
  await gate.closeAndProbeRoutes();
  await checkTopology();
  assert.match(adminEmail, /^admin-[a-f0-9]{20}@example\.invalid$/);
  const sql = (query) =>
    custody
      .postgres(
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "--dbname=openclaw_enterprise",
        "-c",
        query,
      )
      .then((s) => s.trim());
  const userId = await sql(`SELECT id FROM occ."user" WHERE email='${adminEmail}'`);
  assert.match(userId, /^[A-Za-z0-9_-]+$/);
  const password = (await operator("cat", "/bootstrap/initial-admin-password")).trim();
  assert(password.length >= 12);
  // The fresh bootstrap chart has no configured OIDC endpoints. No OIDC route
  // has been opened on the single private proxy since its first generation.
  for (const pod of await plane.pods()) {
    const c = pod.spec.containers.find((c) => c.name === "api");
    if (c) {
      assert(!c.env.some((e) => e.name.startsWith("OCC_AUTH_OIDC_")));
    }
  }
  const helmStatus = async () =>
    JSON.parse(
      await run(
        "helm",
        [
          "status",
          release,
          "-n",
          system,
          "--kubeconfig",
          localCluster.selection.kubeconfigPath,
          "--kube-context",
          localCluster.selection.kubernetesContext,
          "-o",
          "json",
        ],
        { protectedInput: true },
      ),
    );
  const before = await helmStatus();
  assert(
    before.info.status === "deployed" && before.name === release && before.namespace === system,
  );
  // Kubernetes projects the optional CoreDNS ConfigMap asynchronously.
  const bootstrapApi = (await plane.pods()).find(
    (p) => p.metadata.labels["app.kubernetes.io/component"] === "api",
  );
  const mapping = materialization.dnsMapping;
  await waitFor("private provider DNS projection", async () => {
    const answer = await read(
      "exec",
      bootstrapApi.metadata.name,
      "-c",
      "api",
      "--",
      "node",
      "-e",
      "require('node:dns').lookup(process.argv[1],{all:true},(e,a)=>console.log(JSON.stringify(e?[]:a.map(x=>x.address))))",
      mapping.hostname,
    );
    const ips = JSON.parse(answer);
    if (!ips.length) {
      return false;
    }
    assert.deepEqual(ips, [mapping.clusterIP]);
    return true;
  });
  const receipt = await materialization.configureOidc(userId);
  const current = await helmStatus();
  assert(
    current.info.status === "deployed" && current.name === release && current.namespace === system,
  );
  assert(
    current.version === before.version + 1 &&
      receipt.revision === current.version &&
      receipt.namespace === system &&
      receipt.release === release &&
      receipt.controllerReference === images.P.reference,
  );
  await custody.bindRelease(current.version);
  await dns.assertBound();
  await gate.assertClosedRoutes();
  let target = "P";
  const { pods, controlPlane, claimIdentity } = plane;
  const cut = controllerCut({
    controls: images,
    get,
    pods,
    controlPlane,
    localCluster,
    custody,
    kube,
    waitFor,
    release,
    assertClosedRoutes: gate.assertClosedRoutes,
    assertNodeContainersStopped: runtime.assertNodeContainersStopped,
    startupSecret,
  });
  async function checkProvider(hashes) {
    await materialization.assertRunningProvider(hashes);
    const config = JSON.parse(
      await readFile(new URL("config.json", materialization.providerDirectory)),
    );
    const ca = await get("secret/signin-rehearsal-database-ca");
    custody.assertUID("secret/signin-rehearsal-database-ca", ca.metadata.uid);
    const apiPod = (await plane.pods()).find(
      (p) => p.metadata.labels["app.kubernetes.io/component"] === "api",
    );
    const script = `const fs=require("node:fs"),c=require("node:crypto"),dns=require("node:dns").promises;
      const fingerprint=p=>new c.X509Certificate(fs.readFileSync(p)).fingerprint256;
      const hash=v=>c.createHash("sha256").update(v).digest("hex");
      (async()=>{
        const oidc=new URL(process.env.OCC_AUTH_OIDC_ISSUER);
        const db=new URL(process.env.OCC_DATABASE_URL);
        const addresses=(await dns.lookup(oidc.hostname,{all:true})).map(a=>a.address);
        const cert=process.env.NODE_EXTRA_CA_CERTS;
        const root=db.searchParams.get("sslrootcert");
        if(cert!=="/etc/openclaw/api-extra-ca/ca.crt"||root!=="/etc/openclaw/database-ca/ca.pem")process.exit(42);
        const reply=await fetch(new URL("/.well-known/openid-configuration",oidc),{redirect:"error",signal:AbortSignal.timeout(5000)});
        if(reply.status!==200)process.exit(42);
        console.log(JSON.stringify([addresses,(await reply.json()).issuer,process.env.OCC_AUTH_BASE_URL,
          hash(process.env.OCC_AUTH_OIDC_CLIENT_ID),hash(process.env.OCC_AUTH_OIDC_CLIENT_SECRET),
          db.hostname,db.searchParams.get("sslmode"),hash(fs.readFileSync(root)), fingerprint(cert)]));
      })().catch(()=>process.exit(42));`;
    const { X509Certificate } = await import("node:crypto");
    const expected = [
      [mapping.clusterIP],
      config.issuer,
      origin,
      digest(config.clientId),
      digest(config.clientSecret),
      "postgres." + system + ".svc.cluster.local",
      "verify-full",
      digest(Buffer.from(ca.data["ca.pem"], "base64")),
      new X509Certificate(await readFile(new URL("ca.pem", materialization.providerDirectory)))
        .fingerprint256,
    ];
    const actual = JSON.parse(
      await read("exec", apiPod.metadata.name, "-c", "api", "--", "node", "-e", script),
    );
    assert(
      isDeepStrictEqual(actual, expected),
      "API provider identity or independent database trust changed",
    );
  }
  const probeName = "signin-ingress-denial";
  const probeLabels = custody.metadata(probeName, { app: probeName }).labels;
  const controlName = "signin-egress-control";
  const controlLabels = { app: controlName };
  async function ingressTargets() {
    const service = await get("service/openclaw-enterprise-api");
    const operatorPod = await get("pod/operator");
    custody.assertUID("pod/operator", operatorPod.metadata.uid);
    const slices = (await get("endpointslices.discovery.k8s.io")).items
      .filter(
        (slice) => slice.metadata.labels?.["kubernetes.io/service-name"] === service.metadata.name,
      )
      .sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid));
    assert(
      slices.length &&
        slices.some((slice) => slice.endpoints.some((endpoint) => endpoint.conditions.ready)),
    );
    return {
      service: { uid: service.metadata.uid, address: service.spec.clusterIP },
      operator: { uid: operatorPod.metadata.uid, address: operatorPod.status.podIP },
      endpoints: slices.map((slice) => ({
        uid: slice.metadata.uid,
        ports: slice.ports,
        endpoints: slice.endpoints,
      })),
    };
  }
  async function assertProbeEgress() {
    const policies = (await get("networkpolicies")).items;
    assert(
      !policies.some(
        (policy) =>
          policy.spec.policyTypes?.includes("Egress") &&
          matches(policy.spec.podSelector, probeLabels),
      ),
      "ordinary probe must not be selected by an Egress policy",
    );
  }
  const identity = await ingressTargets();
  const targets = [
    { label: "api", host: identity.service.address, port: 8080 },
    { label: "operator", host: identity.operator.address, port: 8443 },
  ];
  const operatorPod = await get("pod/operator");
  const container = operatorPod.spec.containers.find((c) => c.name === "operator");
  const pod = (name, labels, command) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: custody.metadata(name, labels),
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: operatorPod.spec.securityContext,
      containers: [
        {
          name: "probe",
          image: container.image,
          imagePullPolicy: "Never",
          securityContext: container.securityContext,
          resources: container.resources,
          command,
        },
      ],
    },
  });
  // This ingress-only control cannot manufacture denial of either protected target.
  await custody.create({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: custody.metadata(controlName),
    spec: {
      podSelector: { matchLabels: controlLabels },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: probeName } } }],
          ports: [{ protocol: "TCP", port: 8081 }],
        },
      ],
    },
  });
  const control = pod(controlName, controlLabels, tcpControlCommand(8081));
  control.spec.containers[0].readinessProbe = { tcpSocket: { port: 8081 }, periodSeconds: 1 };
  const controlUID = await custody.create(control);
  const controlPod = await waitFor("ordinary probe egress control listener", async () => {
    const current = await get("pod/" + controlName);
    assert.equal(current.metadata.uid, controlUID);
    assert.notEqual(current.status.phase, "Failed");
    return current.status.containerStatuses?.some((status) => status.ready) ? current : undefined;
  });
  const controlTarget = { host: controlPod.status.podIP, port: 8081, expect: "connected" };
  async function assertListeners(phase) {
    await checkTopology();
    await assertProbeEgress();
    assert.deepEqual(await ingressTargets(), identity, "protected listener identities changed");
    // The protected executor suppresses failed-command output. Return the probe's
    // explicit exit status as data so its nonsecret socket diagnosis survives.
    const output = await operator(
      "sh",
      "-c",
      '"$@"; status=$?; printf \'{"exitCode":%s}\\n\' "$status"',
      "tcp-listener-check",
      ...tcpProbeCommand(targets.map((target) => ({ ...target, expect: "connected" }))),
    );
    const reports = output.trim().split("\n").map(JSON.parse);
    const result = reports.pop();
    assert.equal(result.exitCode, 0, JSON.stringify({ reports, result, identity }));
    await record("Private ingress live-listener control " + phase, {
      reports,
      result,
      identity,
    });
  }
  await assertListeners("before");
  // Allow only the initial control to wait for new-Pod policy propagation.
  // At most 33 initial attempts plus three one-shot targets fit the log bound.
  const probe = pod(
    probeName,
    probeLabels,
    tcpProbeCommand(
      [
        { ...controlTarget, label: "egress-before" },
        ...targets.map((target) => ({ ...target, expect: "denied" })),
        { ...controlTarget, label: "egress-after" },
      ],
      { waitForInitialEgress: true },
    ),
  );
  probe.spec.activeDeadlineSeconds = 30;
  const probeUID = await custody.create(probe);
  await waitFor("unauthorized client denied by private ingress", async () => {
    const current = await get("pod/" + probeName);
    assert.equal(current.metadata.uid, probeUID);
    if (current.status.phase === "Failed") {
      const failure = new Error(
        "Private ingress probe failed: " +
          JSON.stringify({ uid: probeUID, status: current.status }),
      );
      try {
        failure.message +=
          "\n" +
          (await read(
            "logs",
            "pod/" + probeName,
            "-c",
            "probe",
            "--tail=40",
            "--limit-bytes=65536",
          ));
      } catch (error) {
        throw new AggregateError(
          [failure, error],
          "Private ingress probe failed and logs could not be collected",
          { cause: error },
        );
      }
      throw failure;
    }
    return current.status.phase === "Succeeded";
  });
  await assertListeners("after");
  const currentControl = await get("pod/" + controlName);
  assert.equal(currentControl.metadata.uid, controlUID);
  assert.equal(currentControl.status.podIP, controlTarget.host);
  const outcomes = await read(
    "logs",
    "pod/" + probeName,
    "-c",
    "probe",
    "--tail=40",
    "--limit-bytes=65536",
  );
  await record("Private ingress transport outcomes with live-listener and egress controls", {
    reports: outcomes.trim().split("\n").map(JSON.parse),
    identity,
    probe: { uid: probeUID, labels: probeLabels },
    control: { uid: controlUID, address: controlTarget.host, port: controlTarget.port },
  });
  const policySnapshot = async () =>
    (await get("networkpolicies")).items
      .map((p) => [p.metadata.uid, p.metadata.resourceVersion])
      .sort(([a], [b]) => a.localeCompare(b));
  const initialPolicies = await policySnapshot();
  const clock = await fixtureClock({ kube, pods, custody, localCluster });
  const catalog = retainedCatalog(
    custody,
    userId,
    installationId,
    () => runtime.completedHistory(images[target]),
    signinPlan.catalogManifest,
  );
  let expected;
  async function identities() {
    const secrets = await Promise.all(
      [startupSecret, "occ-auth", "occ-database"].map(async (name) => {
        const s = await get("secret/" + name);
        custody.assertUID("secret/" + name, s.metadata.uid);
        if (name === startupSecret) {
          assert.equal(s.metadata.annotations["openclaw.dev/installation-id"], installationId);
        }
        return [s.metadata.uid, s.metadata.resourceVersion, digest(JSON.stringify(s.data))];
      }),
    );
    return { secrets, claims: await claimIdentity(), database: await custody.assertPostgres() };
  }
  const verifyCustody = async () => {
    await checkTopology();
    await dns.assertBound();
    assert.deepEqual(await policySnapshot(), initialPolicies);
    assert(isDeepStrictEqual(expected, await identities()), "retained storage or Secret changed");
    assert.equal((await api("GET", "/installation")).id, installationId);
    assert.equal((await api("GET", "/namespaces/" + namespace.id)).id, namespace.id);
    custody.assertUID("namespace/" + tenant, (await get("namespace/" + tenant)).metadata.uid);
  };
  const fence = writerFence({
    system,
    controlName,
    controlUID,
    get,
    read,
    custody,
    clock,
    checkTopology,
    usesV2,
  });
  const admission = signinAdmission({
    canAdmit,
    gate,
    images,
    attest: clock.verifiedSkewMs,
    selectedTarget: async () => {
      const live = await controlPlane(images[target], "openclaw_enterprise", startupSecret);
      const acknowledgedApiLabels = [];
      for (const p of live) {
        const pod = await get("pod/" + p.pod);
        assert.equal(pod.metadata.uid, p.uid);
        if (p.component === "api") {
          acknowledgedApiLabels.push(pod.metadata.labels);
        }
        for (const init of pod.spec.initContainers ?? []) {
          if (!Object.values(images).some((i) => i.reference === init.image)) {
            continue;
          }
          assert.equal(init.image, images[target].reference);
          const status = pod.status.initContainerStatuses.find((c) => c.name === init.name);
          assert.equal(status.state.terminated.exitCode, 0);
          await plane.verifyPodImage(images[target], pod, status);
        }
      }
      await checkTopology(acknowledgedApiLabels);
      assert.equal(
        await sql(
          "SELECT coalesce(bool_and(s.ssl AND s.version IS NOT NULL),false) FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.datname=current_database() AND a.usename='occ_app'",
        ),
        "t",
      );

      await fence.admit(
        live.map((p) => p.uid),
        images[target],
      );
      return target;
    },
    assertCustody: verifyCustody,
  });
  let failed = false;
  let primary;
  try {
    expected = await identities();
    await runTransition({
      signinPlan,
      canAdmit,
      ...gate,
      ...catalog,
      ...cut,
      ...clock,
      origin,
      authorizationUrl: "https://idp.signin-rehearsal.test/authorize",
      userId,
      images,
      passwordLogin: { email: adminEmail, password },
      providerDirectory: materialization.providerDirectory,
      providerHashes: materialization.providerHashes,
      providerFetch: materialization.providerFetch,
      consoleFetch,
      assertExclusiveDisposable: verifyCustody,
      assertRunningProvider: checkProvider,
      async assertInitialVirginIssuance() {
        await gate.assertClosedRoutes();
        assert.equal(await sql("SELECT count(*) FROM occ.human_authentication_results"), "0");
      },
      async stopAndDrain(from) {
        const old = await cut.stopAndDrain(from);
        await fence.drained(from);
        target = undefined;
        await record("Sign-in controller drain", {
          from,
          clock: clock.lastObservation(),
          pods: old.map(({ uid, imageDigest }) => ({ uid, imageDigest })),
        });
        return old;
      },
      assertV2Fenced: fence.check,
      async startClosed(to, image) {
        await fence.starting(to, image);
        await cut.startClosed(to, image);
        target = to;
      },
      openTarget: admission.openTarget,
      refusalControls: admission.refusalControls,
      async assertRetainedState() {
        await verifyCustody();
        await catalog.assertRetainedState();
      },
      record: (stage, details) =>
        record("Sign-in " + stage, typeof details === "string" ? { decision: details } : details),
      async closeAndCleanupOwned() {
        await gate.closeAndProbeRoutes();
        if (target) {
          await cut.stopAndDrain(target);
          if (fence.active()) {
            await fence.drained(target);
          }
        }
      },
    });
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await clock.close();
  } catch (error) {
    if (failed) {
      throw new AggregateError([primary, error], "rehearsal and clock cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  if (failed) {
    throw primary;
  }
}
