import assert from "node:assert/strict";
import { admitRepositoryNetworkPolicy } from "../../packages/contracts/src/repository-network-policy.ts";
import test from "node:test";
import type {
  V1ConfigMap,
  V1Deployment,
  V1NetworkPolicy,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { strandsBoxResources } from "../../apps/controller/src/drivers/sandbox/strands-box-resources.ts";
import { validateConfiguration } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import { preparedHarness, selection, stagedStockFixture } from "../fixtures/strands-box.ts";

type Context = Parameters<typeof strandsBoxResources>[0];

const gateway = {
  host: "gateway.oce.svc",
  port: 18789,
  egress: {
    to: [{ podSelector: { matchLabels: { app: "gateway" } } }],
    ports: [{ protocol: "TCP", port: 18789 }],
  },
};

function render(context: Context, options = selection(context.namespace.name)) {
  const resources = strandsBoxResources(
    context,
    options,
    "box",
    {},
    "a".repeat(64),
    "b".repeat(64),
    { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
    gateway,
    [{ cidr: "192.0.2.7/32", port: 443 }],
  );
  const pod = (resources.find(({ kind }) => kind === "Deployment") as V1Deployment).spec!.template
    .spec!;
  const data = (resources.find(({ kind }) => kind === "ConfigMap") as V1ConfigMap).data!;
  const network = (resources.find(({ kind }) => kind === "NetworkPolicy") as V1NetworkPolicy).spec!;
  return { pod, data, network, workload: JSON.parse(data["workload.json"]!) };
}

test("only the stock supervisor receives the API key and unmasked procfs", async () => {
  const context = await preparedHarness();
  const key = context.requirements.environment.find(({ name }) => name === "OPENAI_API_KEY");
  assert.ok(key && "valueFrom" in key);
  const { pod, data, network, workload } = render(context);
  const box = pod.containers.find(({ name }) => name === "box-workload")!;
  assert.deepEqual(box.env, [{ name: "OCE_STRANDS_OPENAI_KEY", valueFrom: key.valueFrom }]);
  assert.equal(box.securityContext?.procMount, "Unmasked");
  assert.deepEqual(box.securityContext?.appArmorProfile, {
    type: "Localhost",
    localhostProfile: "oce-strands-box-v0.3.1",
  });
  assert.deepEqual(box.securityContext?.seccompProfile, {
    type: "Localhost",
    localhostProfile: "oce-strands-box-v0.3.1.json",
  });
  assert.equal(pod.runtimeClassName, "oce-strands-box");
  assert.equal(pod.hostUsers, false);
  assert.equal(pod.shareProcessNamespace, false);
  for (const sibling of [...pod.initContainers!, ...pod.containers.filter((c) => c !== box)]) {
    assert.equal(sibling.securityContext?.procMount, undefined);
    assert.ok(!sibling.env?.some((e) => e.valueFrom?.secretKeyRef));
  }
  const reference = key.valueFrom.secretKeyRef;
  assert.ok(
    !pod.volumes!.some(
      ({ secret }) =>
        secret?.secretName === reference.name &&
        (!secret.items || secret.items.some(({ key }) => key === reference.key)),
    ),
  );
  // Enrollment retains Pod egress. The contained process cannot ask its
  // supervisor to open a raw channel to the Gateway.
  assert.deepEqual(network.egress![0], gateway.egress);
  assert.equal(workload.gateway, undefined);
  assert.equal(workload.stockTransport, true);

  // Initial creation precedes pinning. A directory projection lets the
  // trusted listener observe the winning certificate without a Pod restart.
  assert.deepEqual(pod.volumes!.find((v) => v.name === "listener-receipt")?.configMap, {
    name: "box-listener",
    optional: true,
    items: [{ key: "certificate", path: "certificate" }],
  });
  const mounts = [...pod.initContainers!, ...pod.containers].flatMap((c) =>
    (c.volumeMounts ?? []).filter((m) => m.name === "listener-receipt").map((m) => [c.name, m]),
  );
  assert.deepEqual(mounts, [
    ["agent", { name: "listener-receipt", mountPath: "/run/strands-receipt", readOnly: true }],
  ]);

  assert.deepEqual(workload.secretEnvironment, {});
  assert.doesNotMatch(data["workload.json"]!, /OPENAI_API_KEY|OCE_STRANDS_OPENAI_KEY/u);
  assert.doesNotMatch(data["box.toml"]!, /backends|container-agent|strands-stock|strands-secrets/u);
  assert.match(
    data["box.toml"]!,
    /destinations = \["api\.openai\.com:443\/v1\/responses"\]\nsecret\.ref = "env:\/\/OPENAI_API_KEY"\nsecret\.inject = "phantom"/u,
  );
  const requests = data["policy.dw"]!.split("@id").filter((rule) => rule.includes("http:request"));
  assert.equal(requests.length, 1);
  assert.match(
    requests[0]!,
    /context\.input\.host == "api\.openai\.com" && context\.input\.port == 443 && context\.input\.intercepted && context\.input\.method == "POST" && context\.input\.path == "\/v1\/responses" \};/u,
  );

  const receiver = render(context, selection());
  assert.deepEqual(receiver.workload.gateway, gateway);
  assert.equal(receiver.pod.runtimeClassName, undefined);
  assert.ok(receiver.pod.containers.every((c) => !c.securityContext?.procMount));
  assert.match(receiver.data["box.toml"]!, /container-agent = true/u);
  assert.match(receiver.workload.secretEnvironment.OPENAI_API_KEY, /^\/run\/strands-secrets\//u);
});

test("stock configuration rejects overlapping destinations and foreign profiles", () => {
  const options = selection("oce-tenant");
  assert.deepEqual(validateConfiguration(options), []);
  const endpoint = options.policy.network.endpoints[0]!;
  for (const endpoints of [
    [],
    [endpoint, endpoint],
    [endpoint, { host: "github.com", ports: [443] }],
    [{ host: "*.openai.com", ports: [443] }],
    [{ ...endpoint, ports: [443, 80] }],
  ]) {
    assert.ok(validateConfiguration({ ...options, policy: { network: { endpoints } } }).length);
  }
  assert.ok(
    validateConfiguration({
      ...options,
      kubernetes: { ...options.kubernetes, seccompProfile: "other.json" },
    }).length,
  );
  for (const namespace of ["", "*", "control-plane"]) {
    assert.ok(validateConfiguration(selection(namespace)).length);
  }
});

test("stock rendering refuses credential aliases, extra authorities and another tenant", async () => {
  const context = await preparedHarness();
  const { environment, files } = context.requirements;
  const model = environment.find((item) => item.name === "OPENAI_API_KEY");
  assert.ok(model && "valueFrom" in model);
  const unsupported = { code: "SANDBOX_HARNESS_UNSUPPORTED" };
  const withRequirements = (overrides: Partial<Context["requirements"]>) =>
    render({ ...context, requirements: { ...context.requirements, ...overrides } });
  const withoutKey = environment.filter((item) => item !== model);
  for (const replacement of [
    withoutKey,
    [...withoutKey, { name: model.name, value: "literal" }],
    ...[{ name: "foreign" }, { key: "other" }].map((changes) => [
      ...withoutKey,
      {
        name: model.name,
        valueFrom: { secretKeyRef: { ...model.valueFrom.secretKeyRef, ...changes } },
      },
    ]),
    [...environment, model],
    [...environment, { name: "CUSTOM_KEY", valueFrom: model.valueFrom }],
    ...["APP_SERVER_TOKEN", "OPENCLAW_NODE_SETUP_CODE"].map((alias) =>
      environment.map((item) => (item.name === alias ? { ...model, name: alias } : item)),
    ),
  ]) {
    assert.throws(() => withRequirements({ environment: replacement }), unsupported);
  }
  assert.throws(
    () =>
      withRequirements({
        workspaceSetup: { id: "test", secretKeyRef: model.valueFrom.secretKeyRef },
      }),
    unsupported,
  );
  assert.throws(() => withRequirements({ loginMode: "codex_pat" }), unsupported);
  assert.throws(
    () => withRequirements({ files: files.map((file) => ({ ...file, content: "different" })) }),
    unsupported,
  );
  assert.throws(() => withRequirements({ files: [files[0]!, files[0]!] }), unsupported);
  assert.throws(() => render(context, selection("another-tenant")), unsupported);
  const repositoryCredentials = {
    authorization: "credential_source" as const,
    driver: { id: "github", implementation: "github" },
    bindings: [
      {
        repositoryRef: "example/repo",
        backendId: "github",
        profile: "read",
        grant: { providerInstanceId: "github", repositoryId: "repo", grantId: "grant" },
      },
    ],
  };
  assert.throws(
    () => render({ ...context, revision: { ...context.revision, repositoryCredentials } }),
    unsupported,
  );
  const grant = [{ repository: "example/repo", access: "read" }];
  const sandboxPolicy = {
    driverId: "sandbox-provider",
    implementation: "strands-box",
    version: 1,
    defaults: {},
    additions: [],
    repositoryNetworkPolicy: admitRepositoryNetworkPolicy(grant, grant)!,
  };
  assert.throws(
    () => render({ ...context, revision: { ...context.revision, sandboxPolicy } }),
    unsupported,
  );
});

test("a held stock revision projects material only on its launcher and refuses mismatched policies", async () => {
  const { staged, stagedOptions, context, route, allowed, deployment, sourceId, configurationId } =
    await stagedStockFixture();
  const { pod, workload, data } = render(staged, stagedOptions);
  assert.deepEqual(workload.stockStaged, { sourceId, configurationId });
  assert.deepEqual(workload.secretEnvironment, {});
  assert.doesNotMatch(data["box.toml"]!, /strands-material|strands-release/u);
  const legacy = render(context);
  assert.equal(data["policy.dw"], legacy.data["policy.dw"]);
  assert.equal(data["box.toml"], legacy.data["box.toml"]);
  assert.ok(!pod.containers.some((c) => c.env?.some((e) => e.valueFrom?.secretKeyRef)));
  for (const suffix of ["material", "release"]) {
    const volume = pod.volumes!.find(
      (v) => (v.secret?.secretName ?? v.configMap?.name) === `box-${suffix}`,
    )!;
    assert.equal((volume.secret ?? volume.configMap)?.optional, true);
    const users = [...pod.containers, ...pod.initContainers!].flatMap((c) =>
      (c.volumeMounts ?? [])
        .filter((m) => m.name === volume.name)
        .map((m) => [c.name, m.readOnly, m.subPath]),
    );
    assert.deepEqual(users, [["box-workload", true, undefined]]);
  }
  const refused = { code: "SANDBOX_HARNESS_UNSUPPORTED" };
  assert.throws(() => render(staged), refused);
  assert.throws(() => render(context, stagedOptions), refused);
  assert.throws(
    () => render({ ...staged, requirements: context.requirements }, stagedOptions),
    refused,
  );
  assert.throws(
    () => render({ ...staged, revision: { ...staged.revision, agentId: "other" } }, stagedOptions),
    refused,
  );
  // An executable-only authorization cannot become a grant to every process.
  for (const grants of [
    [{ ...route, binary: "/usr/bin/codex" }],
    [
      {
        ...route,
        subject: "agent" as const,
        requestPolicy: { ...route.requestPolicy, path: "/v1/**" },
      },
    ],
    [...allowed, { subject: "agent" as const, host: route.host, ports: route.ports }],
  ]) {
    for (const override of [
      { networkAccessPolicy: { allowed: grants } },
      { injectionPolicies: [{ bindingRef: "model", allowedRequests: grants }] },
    ]) {
      const revision = { ...staged.revision, credentialDeployment: { ...deployment, ...override } };
      assert.throws(() => render({ ...staged, revision }, stagedOptions), refused);
    }
  }
});
