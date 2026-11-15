import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  protectedJSON,
  type FixtureRun,
  type LocalRehearsalCluster,
  type RehearsalCustody,
} from "../production-rehearsal-custody.ts";
import { rehearsalPlane } from "../staging-upgrade-return.ts";
import { signinAdmission } from "./admission.ts";
import { fixtureClock } from "./clock.mjs";
import { controllerCut } from "./controller-cut.ts";
import { fixtureFetch, retainedCatalog } from "./custody-probes.ts";
import { tcpControlCommand, tcpProbeCommand } from "./network-probe.ts";
import { runtimeProof } from "./runtime.mjs";
import type { providerDns } from "./dns.ts";
import type { operatorExecutor } from "./operator.ts";
import type { readStagedSignin } from "./staged.ts";
import { trafficGate } from "./traffic-gate.ts";
import { runTransition, type TransitionFixture } from "./transition.ts";
import { writerFence } from "./writer-fence.ts";

const origin = "https://console.signin-rehearsal.test";
const startupSecret = "occ-installation-startup";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

type StagedSignin = Awaited<ReturnType<typeof readStagedSignin>>;
type Plane = ReturnType<typeof rehearsalPlane>;
type ControllerPod = Awaited<ReturnType<Plane["controlPlane"]>>[number];
type Fixture = TransitionFixture<StagedSignin["candidate"], ControllerPod>;
type Target = Parameters<Fixture["openTarget"]>[0];

const labels = Type.Record(Type.String(), Type.String());
const uid = Type.Object({ metadata: Type.Object({ uid: Type.String() }) });
const id = Type.Object({ id: Type.String() });
const selector = Type.Object({
  matchLabels: Type.Optional(labels),
  matchExpressions: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        operator: Type.String(),
        values: Type.Optional(Type.Array(Type.String())),
      }),
    ),
  ),
});
const policies = Type.Object({
  items: Type.Array(
    Type.Object({
      metadata: Type.Object({
        name: Type.String(),
        uid: Type.String(),
        resourceVersion: Type.String(),
      }),
      spec: Type.Object({
        policyTypes: Type.Optional(Type.Array(Type.String())),
        ingress: Type.Optional(Type.Array(Type.Unknown())),
        podSelector: selector,
      }),
    }),
  ),
});
const service = Type.Object({
  metadata: Type.Object({ name: Type.String(), uid: Type.String() }),
  spec: Type.Object({
    type: Type.String(),
    clusterIP: Type.String(),
    externalIPs: Type.Optional(Type.Array(Type.String())),
  }),
});
const services = Type.Object({ items: Type.Array(service) });
const operators = Type.Object({
  items: Type.Array(
    Type.Object({
      metadata: Type.Object({ uid: Type.String(), labels }),
    }),
  ),
});
const apiDeployment = Type.Object({
  metadata: Type.Object({ labels }),
  spec: Type.Object({ template: Type.Object({ metadata: Type.Object({ labels }) }) }),
});
const apiContainers = Type.Object({
  containers: Type.Array(
    Type.Object({
      name: Type.String(),
      env: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
    }),
  ),
});
const operatorPod = Type.Object({
  metadata: Type.Object({ uid: Type.String() }),
  status: Type.Object({ podIP: Type.String() }),
  spec: Type.Object({
    securityContext: Type.Optional(Type.Object({})),
    containers: Type.Array(
      Type.Object({
        name: Type.String(),
        image: Type.String(),
        securityContext: Type.Optional(Type.Object({})),
        resources: Type.Optional(Type.Object({})),
      }),
    ),
  }),
});
const protectedEndpoints = Type.Object({
  items: Type.Array(
    Type.Object({
      metadata: Type.Object({ uid: Type.String(), labels: Type.Optional(labels) }),
      ports: Type.Optional(Type.Array(Type.Unknown())),
      endpoints: Type.Array(
        Type.Object({
          conditions: Type.Optional(Type.Object({ ready: Type.Optional(Type.Boolean()) })),
        }),
      ),
    }),
  ),
});
const probePod = Type.Object({
  metadata: Type.Object({ uid: Type.String() }),
  status: Type.Object({
    phase: Type.String(),
    podIP: Type.Optional(Type.String()),
    containerStatuses: Type.Optional(Type.Array(Type.Object({ ready: Type.Boolean() }))),
  }),
});
const acknowledgedController = Type.Object({
  metadata: Type.Object({ uid: Type.String(), labels }),
  spec: Type.Object({
    nodeName: Type.String(),
    initContainers: Type.Optional(
      Type.Array(Type.Object({ name: Type.String(), image: Type.String() })),
    ),
  }),
  status: Type.Object({
    initContainerStatuses: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          imageID: Type.String(),
          containerID: Type.Optional(Type.String()),
          state: Type.Object({
            terminated: Type.Optional(Type.Object({ exitCode: Type.Integer() })),
          }),
        }),
      ),
    ),
  }),
});
const retainedSecret = Type.Object({
  metadata: Type.Object({
    uid: Type.String(),
    resourceVersion: Type.String(),
    annotations: Type.Optional(labels),
  }),
  data: Type.Record(Type.String(), Type.String()),
});
const databaseCA = Type.Object({
  ...uid.properties,
  data: Type.Object({ "ca.pem": Type.String() }),
});
const providerDnsMapping = Type.Object({ hostname: Type.String(), clusterIP: Type.String() });
const providerConfig = Type.Object({
  issuer: Type.String(),
  clientId: Type.String(),
  clientSecret: Type.String(),
});
const helmRelease = Type.Object({
  info: Type.Object({ status: Type.String() }),
  name: Type.String(),
  namespace: Type.String(),
  version: Type.Integer(),
});
const oidcReceipt = Type.Object({
  revision: Type.Integer(),
  release: Type.String(),
  namespace: Type.String(),
  controllerReference: Type.String(),
});
const addresses = Type.Array(Type.String());
const exitReceipt = Type.Object({ exitCode: Type.Integer() });
const items = Type.Object({ items: Type.Array(Type.Unknown()) });

type ProbePodSpec = {
  restartPolicy: "Never";
  automountServiceAccountToken: false;
  securityContext: object | undefined;
  activeDeadlineSeconds?: number;
  containers: [
    {
      name: string;
      image: string;
      imagePullPolicy: "Never";
      securityContext: object | undefined;
      resources: object | undefined;
      command: string[];
      readinessProbe?: { tcpSocket: { port: number }; periodSeconds: number };
    },
  ];
};

type Materialization = {
  dnsMapping: unknown;
  providerDirectory: Fixture["providerDirectory"];
  providerHashes: Fixture["providerHashes"];
  providerFetch: Fixture["providerFetch"];
  assertDatabaseImage: () => Promise<void>;
  assertRunningProvider: Fixture["assertRunningProvider"];
  configureOidc: (userId: string) => Promise<unknown>;
};

function observed<S extends TSchema>(schema: S, value: unknown, observation: string): Static<S> {
  // Do not include protected command output, TLS material or Secret values in failures.
  assert.ok(Check(schema, value), "invalid " + observation);
  return value;
}

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
}: {
  rehearsal: StagedSignin;
  system: string;
  release: string;
  directory: string;
  custody: RehearsalCustody;
  kubectl: (...args: string[]) => Promise<string>;
  kubeArgs: readonly string[];
  localCluster: LocalRehearsalCluster;
  waitFor: <T>(description: string, observe: () => Promise<T | false | undefined>) => Promise<T>;
  run: FixtureRun;
  record: (row: string, details: object) => Promise<void>;
  api: (method: "GET", path: string) => Promise<unknown>;
  namespace: { id: string };
  tenant: string;
  materialization: Materialization;
  signinSetup: {
    port: number;
    ca: string | Buffer;
    adminEmail: string;
    installationId: string;
    operator: Awaited<ReturnType<typeof operatorExecutor>>;
  };
  dns: Pick<ReturnType<typeof providerDns>, "assertBound">;
}) {
  const { port, ca, adminEmail, installationId } = signinSetup;
  const images = { P: rehearsal.previous, A: rehearsal.candidate };
  const { signinPlan, canAdmit } = rehearsal;
  const usesV2 = signinPlan.previous.version === 2;
  const kube = (...args: string[]) => kubectl("-n", system, ...args);
  const protectedArgs = [...kubeArgs, "--namespace", system, "--request-timeout=30s"];
  const read = (...args: string[]) =>
    run("kubectl", [...protectedArgs, ...args], { protectedInput: true });
  const get = async (resource: string) =>
    protectedJSON<unknown>(await read("get", resource, "-o", "json"));
  const getObserved = async <S extends TSchema>(resource: string, schema: S) =>
    observed(schema, await get(resource), resource);
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
  const runtime: {
    assertNodeContainersStopped: (previous: readonly ControllerPod[]) => Promise<void>;
    completedHistory: (image: Fixture["images"][Target]) => Promise<void>;
  } = runtimeProof({
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

  const matches = (sel: Static<typeof selector>, labels: Readonly<Record<string, string>>) => {
    if (!Object.entries(sel.matchLabels ?? {}).every(([k, v]) => labels[k] === v)) {
      return false;
    }
    return (sel.matchExpressions ?? []).every((e) => {
      if (e.operator === "In") {
        assert(e.values, "selector In requires values");
        const value = labels[e.key];
        return value !== undefined && e.values.includes(value);
      }
      if (e.operator === "NotIn") {
        assert(e.values, "selector NotIn requires values");
        const value = labels[e.key];
        return value === undefined || !e.values.includes(value);
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

  async function checkTopology(acknowledgedApiLabels: Readonly<Record<string, string>>[] = []) {
    await localCluster.assertCluster();
    await custody.assertPostgres();
    await materialization.assertDatabaseImage();
    await custody.assertRelease();
    const [policyList, serviceList, ingress, operatorList, deployment, currentPods] =
      await Promise.all([
        getObserved("networkpolicies", policies),
        getObserved("services", services),
        getObserved("ingresses", items),
        read("get", "pods", "-l", "app=production-tui-proxy", "-o", "json").then((output) =>
          observed(operators, protectedJSON<unknown>(output), "operator Pod list"),
        ),
        getObserved("deployment/openclaw-enterprise-api", apiDeployment),
        plane.pods(),
      ]);
    const [operator] = operatorList.items;
    assert(operatorList.items.length === 1 && operator);
    custody.assertUID("pod/operator", operator.metadata.uid);
    assert(
      serviceList.items.every((s) => s.spec.type === "ClusterIP" && !s.spec.externalIPs?.length),
    );
    assert.equal(ingress.items.length, 0);
    const relevant = policyList.items.filter(
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
      const [apiRule] = apiRules;
      assert(apiRules.length === 1 && apiRule, "API ingress must allow only the owned proxy");
      assert.deepEqual(apiRule.spec.ingress, [
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
    assert(!relevant.some((p) => matches(p.spec.podSelector, operator.metadata.labels)));
    const deny = policyList.items.find((p) => p.metadata.name === "signin-operator-private");
    assert(deny);
    custody.assertUID("networkpolicy/signin-operator-private", deny.metadata.uid);
    assert(!deny.spec.ingress?.length && matches(deny.spec.podSelector, operator.metadata.labels));
  }
  await gate.closeAndProbeRoutes();
  await checkTopology();
  assert.match(adminEmail, /^admin-[a-f0-9]{20}@example\.invalid$/);
  const sql = (query: string) =>
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
    const c = observed(apiContainers, pod.spec, "bootstrap Pod containers").containers.find(
      (c) => c.name === "api",
    );
    if (c) {
      assert(c.env && !c.env.some((e) => e.name.startsWith("OCC_AUTH_OIDC_")));
    }
  }
  const helmStatus = async () =>
    observed(
      helmRelease,
      protectedJSON<unknown>(
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
      ),
      "Helm release status",
    );
  const before = await helmStatus();
  assert(
    before.info.status === "deployed" && before.name === release && before.namespace === system,
  );
  // Kubernetes projects the optional CoreDNS ConfigMap asynchronously.
  const bootstrapApi = (await plane.pods()).find(
    (p) => p.metadata.labels["app.kubernetes.io/component"] === "api",
  );
  assert(bootstrapApi);
  const mapping = observed(providerDnsMapping, materialization.dnsMapping, "provider DNS mapping");
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
    const ips = observed(addresses, protectedJSON<unknown>(answer), "provider DNS addresses");
    if (!ips.length) {
      return false;
    }
    assert.deepEqual(ips, [mapping.clusterIP]);
    return true;
  });
  const receipt = observed(
    oidcReceipt,
    await materialization.configureOidc(userId),
    "OIDC Helm upgrade receipt",
  );
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
  let target: Target | undefined = "P";
  function selectedImage() {
    assert(target, "no selected controller target");
    return images[target];
  }
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
  async function checkProvider(hashes: Fixture["providerHashes"]) {
    await materialization.assertRunningProvider(hashes);
    const config = observed(
      providerConfig,
      protectedJSON<unknown>(
        await readFile(new URL("config.json", materialization.providerDirectory), "utf8"),
      ),
      "provider configuration",
    );
    const ca = await getObserved("secret/signin-rehearsal-database-ca", databaseCA);
    custody.assertUID("secret/signin-rehearsal-database-ca", ca.metadata.uid);
    const apiPod = (await plane.pods()).find(
      (p) => p.metadata.labels["app.kubernetes.io/component"] === "api",
    );
    assert(apiPod);
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
    const actual = protectedJSON<unknown>(
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
    const apiService = await getObserved("service/openclaw-enterprise-api", service);
    const operator = await getObserved("pod/operator", operatorPod);
    custody.assertUID("pod/operator", operator.metadata.uid);
    const slices = (await getObserved("endpointslices.discovery.k8s.io", protectedEndpoints)).items
      .filter(
        (slice) =>
          slice.metadata.labels?.["kubernetes.io/service-name"] === apiService.metadata.name,
      )
      .sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid));
    assert(
      slices.length &&
        slices.some((slice) => slice.endpoints.some((endpoint) => endpoint.conditions?.ready)),
    );
    return {
      service: { uid: apiService.metadata.uid, address: apiService.spec.clusterIP },
      operator: { uid: operator.metadata.uid, address: operator.status.podIP },
      endpoints: slices.map((slice) => ({
        uid: slice.metadata.uid,
        ports: slice.ports,
        endpoints: slice.endpoints,
      })),
    };
  }
  async function assertProbeEgress() {
    const policyList = (await getObserved("networkpolicies", policies)).items;
    assert(
      !policyList.some(
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
  const operatorSpec = (await getObserved("pod/operator", operatorPod)).spec;
  const container = operatorSpec.containers.find((c) => c.name === "operator");
  assert(container);
  const pod = (
    name: string,
    labels: Record<string, string>,
    command: string[],
  ): {
    apiVersion: string;
    kind: string;
    metadata: ReturnType<RehearsalCustody["metadata"]>;
    spec: ProbePodSpec;
  } => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: custody.metadata(name, labels),
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: operatorSpec.securityContext,
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
  const controlPolicy = {
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
  };
  await custody.create(controlPolicy);
  const control = pod(controlName, controlLabels, tcpControlCommand(8081));
  control.spec.containers[0].readinessProbe = { tcpSocket: { port: 8081 }, periodSeconds: 1 };
  const controlUID = await custody.create(control);
  const controlPod = await waitFor("ordinary probe egress control listener", async () => {
    const current = await getObserved("pod/" + controlName, probePod);
    assert.equal(current.metadata.uid, controlUID);
    assert.notEqual(current.status.phase, "Failed");
    return current.status.containerStatuses?.some((status) => status.ready) ? current : undefined;
  });
  assert(controlPod.status.podIP);
  const controlTarget = { host: controlPod.status.podIP, port: 8081, expect: "connected" };
  async function assertListeners(phase: "before" | "after") {
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
    const reports = output
      .trim()
      .split("\n")
      .map((line) => protectedJSON<unknown>(line));
    const result = reports.pop();
    const exit = observed(exitReceipt, result, "listener exit receipt");
    assert.equal(exit.exitCode, 0, JSON.stringify({ reports, result, identity }));
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
    const current = await getObserved("pod/" + probeName, probePod);
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
  const currentControl = await getObserved("pod/" + controlName, probePod);
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
    reports: outcomes
      .trim()
      .split("\n")
      .map((line) => protectedJSON<unknown>(line)),
    identity,
    probe: { uid: probeUID, labels: probeLabels },
    control: { uid: controlUID, address: controlTarget.host, port: controlTarget.port },
  });
  const policySnapshot = async () =>
    (await getObserved("networkpolicies", policies)).items
      .map((p) => [p.metadata.uid, p.metadata.resourceVersion] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  const initialPolicies = await policySnapshot();
  const clock: Pick<Fixture, "readerUpperMs" | "waitUntilReaderPast"> & {
    verifiedSkewMs: () => Promise<unknown>;
    lastObservation: () => unknown;
    close: () => Promise<void>;
  } = await fixtureClock({ kube, pods, custody, localCluster });
  const verifiedSkewMs: Fixture["verifiedSkewMs"] = async () => {
    const skew: unknown = await clock.verifiedSkewMs();
    assert(typeof skew === "number", "invalid fixture clock skew");
    return skew;
  };
  const { readerUpperMs, waitUntilReaderPast } = clock;
  const catalog = retainedCatalog(
    custody,
    userId,
    installationId,
    () => runtime.completedHistory(selectedImage()),
    signinPlan.catalogManifest,
  );
  let expected: Awaited<ReturnType<typeof identities>> | undefined;
  async function identities() {
    const secrets = await Promise.all(
      [startupSecret, "occ-auth", "occ-database"].map(async (name) => {
        const s = await getObserved("secret/" + name, retainedSecret);
        custody.assertUID("secret/" + name, s.metadata.uid);
        if (name === startupSecret) {
          assert.equal(s.metadata.annotations?.["openclaw.dev/installation-id"], installationId);
        }
        return [
          s.metadata.uid,
          s.metadata.resourceVersion,
          digest(JSON.stringify(s.data)),
        ] as const;
      }),
    );
    return { secrets, claims: await claimIdentity(), database: await custody.assertPostgres() };
  }
  const verifyCustody = async () => {
    await checkTopology();
    await dns.assertBound();
    assert.deepEqual(await policySnapshot(), initialPolicies);
    assert(isDeepStrictEqual(expected, await identities()), "retained storage or Secret changed");
    assert.equal(
      observed(id, await api("GET", "/installation"), "Installation response").id,
      installationId,
    );
    assert.equal(
      observed(id, await api("GET", "/namespaces/" + namespace.id), "Namespace response").id,
      namespace.id,
    );
    custody.assertUID(
      "namespace/" + tenant,
      (await getObserved("namespace/" + tenant, uid)).metadata.uid,
    );
  };
  const fence = writerFence({
    system,
    controlName,
    controlUID,
    get,
    read,
    custody,
    clock: { verifiedSkewMs, readerUpperMs, waitUntilReaderPast },
    checkTopology,
    usesV2,
  });
  const admission = signinAdmission({
    canAdmit,
    gate,
    images,
    attest: verifiedSkewMs,
    selectedTarget: async () => {
      const selected = target;
      assert(selected, "no selected controller target");
      const image = images[selected];
      const live = await controlPlane(image, "openclaw_enterprise", startupSecret);
      const acknowledgedApiLabels: Record<string, string>[] = [];
      for (const p of live) {
        const pod = await getObserved("pod/" + p.pod, acknowledgedController);
        assert.equal(pod.metadata.uid, p.uid);
        if (p.component === "api") {
          acknowledgedApiLabels.push(pod.metadata.labels);
        }
        for (const init of pod.spec.initContainers ?? []) {
          if (!Object.values(images).some((i) => i.reference === init.image)) {
            continue;
          }
          assert.equal(init.image, image.reference);
          const status = pod.status.initContainerStatuses?.find((c) => c.name === init.name);
          assert(status?.containerID && status.state.terminated);
          assert.equal(status.state.terminated.exitCode, 0);
          await plane.verifyPodImage(image, pod, status);
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
        image,
      );
      return selected;
    },
    assertCustody: verifyCustody,
  });
  let failed = false;
  let primary: unknown;
  try {
    expected = await identities();
    const transition: Fixture = {
      signinPlan,
      canAdmit,
      ...gate,
      ...catalog,
      ...cut,
      verifiedSkewMs,
      readerUpperMs,
      waitUntilReaderPast,
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
        const clockObservation: unknown = clock.lastObservation();
        await record("Sign-in controller drain", {
          from,
          clock: clockObservation,
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
    };
    await runTransition(transition);
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
