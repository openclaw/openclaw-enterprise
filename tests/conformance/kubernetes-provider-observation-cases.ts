import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { createKubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type {
  ComputeRevisionContext,
  RuntimeFailureEvidence,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  admitLoggingConfiguration,
} from "../../packages/contracts/src/index.ts";
import type { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import {
  providerReadinessFixture,
  supervisorPeerLabels,
} from "../fixtures/kubernetes-provider-readiness.mjs";
import { authContext, digest, options, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  firstPeerSelector,
  podSelector,
  resourceLabels,
  resourceRecord,
  resourceRecords,
  selectorMatches,
  serviceSelector,
} from "../helpers/kubernetes-rendered-resources.ts";

export async function checkMalformedProviderPodObservations(t: TestContext) {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const invalid = /invalid or incomplete provider Harness Pod list/;
  const invalidLists: [string, unknown][] = [
    ["null response", null],
    ["missing items", {}],
    ["object items", { items: {} }],
    ["null items", { items: null }],
    ["wrong list kind", { kind: "ServiceList", items: [ready] }],
    ["wrong list version", { apiVersion: "apps/v1", items: [ready] }],
    ["malformed list metadata", { metadata: [], items: [ready] }],
    ["continuation", { metadata: { continue: "next-page" }, items: [ready] }],
    ["SDK continuation", { metadata: { _continue: "next-page" }, items: [ready] }],
    ["remaining items", { metadata: { remainingItemCount: 1 }, items: [ready] }],
  ];
  for (const [name, response] of invalidLists) {
    await t.test(name, async () => {
      fixture.setObservation(response);
      await assert.rejects(fixture.ready(), invalid);
    });
  }
  type ProviderPod = {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; labels: Record<string, string> };
    status: { conditions: { type: string; status: string }[] };
  };
  const invalidPods: [string, (pod: ProviderPod) => unknown][] = [
    ["wrong kind", (pod) => ({ ...pod, kind: "Service" })],
    ["wrong version", (pod) => ({ ...pod, apiVersion: "apps/v1" })],
    ["missing metadata", ({ metadata: _metadata, ...pod }) => pod],
    ["array metadata", (pod) => ({ ...pod, metadata: [] })],
    [
      "missing name",
      (pod) => {
        const { name: _name, ...metadata } = pod.metadata;
        return { ...pod, metadata };
      },
    ],
    ["empty namespace", (pod) => ({ ...pod, metadata: { ...pod.metadata, namespace: "" } })],
    ["array labels", (pod) => ({ ...pod, metadata: { ...pod.metadata, labels: [] } })],
    [
      "nonstring label",
      (pod) => ({
        ...pod,
        metadata: { ...pod.metadata, labels: { ...pod.metadata.labels, extra: 1 } },
      }),
    ],
    [
      "contradictory selector label",
      (pod) => ({
        ...pod,
        metadata: {
          ...pod.metadata,
          labels: { ...pod.metadata.labels, "openclaw.dev/service-principal": "another-principal" },
        },
      }),
    ],
    ...(
      [
        ["null deletion timestamp", null],
        ["invalid deletion date", new Date(NaN)],
        ["invalid deletion string", "0"],
        // Date would roll these over to a plausible wrong day; the frontier rule refuses them.
        ["impossible deletion date", "2026-02-30T00:00:00Z"],
        ["non-leap February 29", "2026-02-29T00:00:00Z"],
        ["hour 24 deletion time", "2026-08-24T24:00:00Z"],
        ["offset deletion time", "2026-08-25T00:00:00+00:00"],
        ["nonzero offset deletion time", "2026-08-25T02:00:00.000+02:00"],
        ["ten fraction digits", "2026-08-25T00:00:00.1234567890Z"],
      ] as const
    ).map(([name, deletionTimestamp]): [string, (pod: ProviderPod) => unknown] => [
      name,
      (pod) => ({ ...pod, metadata: { ...pod.metadata, deletionTimestamp } }),
    ]),
    ["null status", (pod) => ({ ...pod, status: null })],
    ["array status", (pod) => ({ ...pod, status: [] })],
    ["object conditions", (pod) => ({ ...pod, status: { conditions: {} } })],
    [
      "null condition",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, null] },
      }),
    ],
    [
      "nonstring condition type",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, { type: 1, status: "True" }] },
      }),
    ],
    [
      "nonstring condition status",
      (pod) => ({
        ...pod,
        status: {
          conditions: pod.status.conditions.map((condition) => ({ ...condition, status: true })),
        },
      }),
    ],
    [
      "invalid condition status",
      (pod) => ({
        ...pod,
        status: {
          conditions: pod.status.conditions.map((condition) => ({ ...condition, status: "true" })),
        },
      }),
    ],
    [
      "duplicate Ready",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, { type: "Ready", status: "True" }] },
      }),
    ],
    [
      "conflicting Ready",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, { type: "Ready", status: "False" }] },
      }),
    ],
  ];
  for (const [name, makeMalformed] of invalidPods) {
    await t.test(name, async () => {
      const malformed = makeMalformed(fixture.pod("harness-malformed"));
      // A valid Ready entry must not hide invalid observations before or after it.
      for (const items of [[malformed], [ready, malformed], [malformed, ready]]) {
        fixture.setObservation({ items });
        await assert.rejects(fixture.ready(), invalid);
      }
    });
  }
  for (const malformed of [null, false, "pod", [], {}]) {
    fixture.setObservation({ items: [ready, malformed] });
    await assert.rejects(fixture.ready(), invalid);
  }
  fixture.setObservation({ metadata: { continue: "", remainingItemCount: 0 }, items: [ready] });
  assert.equal(await fixture.ready(), true);
}

export async function checkProviderActivationBeforeRouting() {
  const fixture = providerReadinessFixture();
  const context: ComputeRevisionContext = {
    ...authContext(fixture.revision),
    secretEnvironment: [],
  };
  const resolved = context.harnessAuth;
  assert.ok("backendRef" in resolved && resolved.backendRef !== undefined);
  const invalidContexts: (ComputeRevisionContext | undefined)[] = [
    undefined,
    { ...context, harnessAuth: { ...resolved, source: { ...resolved.source, id: "sec_other" } } },
    { ...context, harnessAuth: { ...resolved, secretDriverId: "another-secret-driver" } },
    {
      ...context,
      harnessAuth: {
        ...resolved,
        backendRef: { ...resolved.backendRef, namespaceName: "another-tenant" },
      },
    },
    { ...context, harnessAuth: { ...resolved, backendRef: { ...resolved.backendRef, uid: "" } } },
  ];
  for (const invalidContext of invalidContexts) {
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, invalidContext),
      /authentication.*(?:context|source)/i,
    );
  }
  assert.equal(fixture.requests.length, 0, "invalid authentication must fail before Pod readiness");
  for (const items of [
    [],
    [fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("also-ready")],
  ]) {
    fixture.setObservation({ items });
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, context),
      /The exact AgentRevision workload is not ready/,
    );
  }
  fixture.setObservation({ items: [fixture.pod("ready"), null] });
  await assert.rejects(
    fixture.driver.activateRevision(fixture.revision, context),
    /invalid or incomplete/,
  );
  assert.equal(fixture.requests.length, 5);
}

export async function checkProviderReadinessErrorsAndCancellation() {
  const fixture = providerReadinessFixture();
  Object.assign(fixture.driver, { waitBeforeRetry: async () => {} });
  const denied = Object.assign(new Error("Pod observation denied"), { statusCode: 403 });
  fixture.setObservation(() => {
    throw denied;
  });
  await assert.rejects(fixture.ready(), (error) => error === denied);
  assert.equal(fixture.requests.length, 1);
  const unavailable = Object.assign(new Error("Pod observation unavailable"), { statusCode: 503 });
  fixture.setObservation(() => {
    throw unavailable;
  });
  await assert.rejects(fixture.ready(), (error) => error === unavailable);
  assert.equal(fixture.requests.length, 7);

  const cancellation = new Error("revision observation cancelled");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(alreadyAborted.signal, () => fixture.ready()),
    (error) => error === cancellation,
  );
  assert.equal(fixture.requests.length, 7);
  for (const lateSuccess of [false, true]) {
    const owner = new AbortController();
    const { promise: observing, resolve: started } = Promise.withResolvers<AbortSignal>();
    const {
      promise: observation,
      resolve: release,
      reject,
    } = Promise.withResolvers<{ items: ReturnType<typeof fixture.pod>[] }>();
    fixture.setObservation(() => {
      const signal = currentComputeAbortSignal();
      assert.ok(signal);
      started(signal);
      if (!lateSuccess) {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
      return observation;
    });
    // Manual owner cancellation exercises the driver context; it is not database lease-loss proof.
    const readiness = withComputeAbortSignal(owner.signal, () => fixture.ready());
    const rejected = assert.rejects(readiness, (error) => error === cancellation);
    const requestSignal = await observing;
    owner.abort(cancellation);
    assert.equal(requestSignal.aborted, true);
    if (lateSuccess) {
      release({ items: [fixture.pod("late-ready")] });
    }
    await rejected;
  }
  assert.equal(fixture.requests.length, 9);
}

export async function checkKubernetesReadRetryAfter() {
  const fixture = providerReadinessFixture();
  const waits: number[] = [];
  const waitBeforeRetry = async (ms: number) => {
    waits.push(ms);
  };
  Object.assign(fixture.driver, { waitBeforeRetry });
  const failing = (count: number, error: () => Error) => {
    let failures = 0;
    fixture.setObservation(() => {
      if (failures < count) {
        failures += 1;
        throw error();
      }
      return { items: [fixture.pod("ready")] };
    });
  };

  // Four 503s in a row (a few hundred milliseconds of API server restart) still
  // end in a successful read, with exponential, jittered waits.
  failing(4, () => Object.assign(new Error("unavailable"), { code: 503, headers: {} }));
  assert.equal(await fixture.ready(), true);
  assert.equal(fixture.requests.length, 5);
  assert.equal(waits.length, 4);
  waits.forEach((ms, index) => {
    assert.ok(ms >= 25 * 2 ** index && ms <= 50 * 2 ** index, `wait ${index}: ${ms}`);
  });

  // Retry-After in seconds and as an HTTP date is honored, capped at 2 s per wait.
  waits.length = 0;
  const throttled = (value: string) =>
    Object.assign(new Error("throttled"), { code: 429, headers: { "retry-after": value } });
  const retryAfter = ["1", new Date(Date.now() + 60_000).toUTCString()];
  fixture.setObservation(() => {
    const value = retryAfter.shift();
    if (value !== undefined) {
      throw throttled(value);
    }
    return { items: [fixture.pod("ready")] };
  });
  assert.equal(await fixture.ready(), true);
  // The date is a minute away, but the wait stops at the 2 s total.
  assert.deepEqual(waits, [1_000, 1_000]);

  // The total wait is bounded: a persistent outage fails within the budget.
  waits.length = 0;
  const before = fixture.requests.length;
  fixture.setObservation(() => {
    throw throttled("30");
  });
  await assert.rejects(fixture.ready(), /throttled/);
  assert.deepEqual(waits, [2_000]);
  assert.equal(fixture.requests.length - before, 2);

  // Mutating calls never retry, and a 404 is not retryable.
  waits.length = 0;
  let calls = 0;
  const flaky = () => {
    calls += 1;
    throw Object.assign(new Error("unavailable"), { code: 503, headers: {} });
  };
  await assert.rejects(fixture.driver["request"](flaky, { mutating: true }), /unavailable/);
  await assert.rejects(
    fixture.driver["request"](() => {
      calls += 1;
      throw Object.assign(new Error("missing"), { code: 404 });
    }),
    /missing/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
}

export async function checkKubernetesRetryOwnerCancellation() {
  const driver = createKubernetesComputeDriver(options());
  const owner = new AbortController();
  const reason = new Error("revision observation cancelled");
  let calls = 0;
  const started = Date.now();
  const request = withComputeAbortSignal(owner.signal, () =>
    driver["request"](() => {
      calls += 1;
      throw Object.assign(new Error("throttled"), {
        code: 429,
        headers: { "Retry-After": "2" },
      });
    }),
  );
  const cancel = setTimeout(() => owner.abort(reason), 50);
  try {
    await assert.rejects(request, (error) => error === reason);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1_500);
  } finally {
    clearTimeout(cancel);
  }
}

type EndpointFixture = ReturnType<typeof providerEndpointFixture>;
type PreparedEndpoint = (
  fixture?: EndpointFixture,
  context?: Parameters<EndpointFixture["prepare"]>[1],
) => Promise<EndpointFixture>;
type ExpectedRevision = { namespaceId: string; agentId: string; revisionId: string };
type ProviderStatusScenario = {
  name: string;
  answer: SandboxHarnessStatus;
  outcome: { ready: boolean; runtimeFailure?: RuntimeFailureEvidence };
};
type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type DeletePolicy = Parameters<
  InstanceType<KubernetesSdk["NetworkingV1Api"]>["deleteNamespacedNetworkPolicy"]
>[0];

function storedEndpointResource(
  fixture: EndpointFixture,
  kind: string,
  name: string,
  namespace?: string,
) {
  const resource = resourceRecord(fixture.read(kind, name, namespace), kind);
  assert.equal(resource.kind, kind);
  return {
    ...resource,
    metadata: resourceRecord(resource.metadata, `${kind} metadata`),
    spec: resource.spec,
  };
}

function specOf(resource: { spec: unknown }, field: string) {
  return resourceRecord(resource.spec, field);
}

function endpointGatewayPod(fixture: EndpointFixture) {
  const gateway = storedEndpointResource(
    fixture,
    "Deployment",
    fixture.gatewayName,
    fixture.gatewayNamespace,
  );
  const template = resourceRecord(
    specOf(gateway, "Gateway Deployment spec").template,
    "Gateway Pod template",
  );
  return resourceRecord(template.spec, "Gateway Pod spec");
}

function objectField(record: Record<string, unknown>, field: string) {
  return resourceRecord(record[field], field);
}

export const heldFailure: RuntimeFailureEvidence = {
  component: "agent",
  check: "model-probe",
  checkedAt: "2026-10-08T13:00:00.000Z",
  code: "MODEL_PROBE_FAILED",
  cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
};
const { cause: _cause, ...withoutCause } = heldFailure;
export { withoutCause };

export const transportScenarios: readonly ProviderStatusScenario[] = [
  { name: "serving transport", answer: { state: "serving" }, outcome: { ready: true } },
  { name: "starting transport", answer: { state: "starting" }, outcome: { ready: false } },
  {
    name: "held model failure",
    answer: { state: "failed", runtimeFailure: heldFailure },
    outcome: { ready: false, runtimeFailure: heldFailure },
  },
];
export const statusScenarios: readonly ProviderStatusScenario[] = [
  ...transportScenarios,
  {
    name: "redacted provider cause",
    answer: {
      state: "failed",
      runtimeFailure: { ...heldFailure, cause: { kind: "PROVIDER_TEXT", detail: "key sk-123" } },
    },
    outcome: { ready: false, runtimeFailure: withoutCause },
  },
];

export const invalidProviderEvidence: readonly { name: string; runtimeFailure: unknown }[] = [
  { name: "missing evidence", runtimeFailure: undefined },
  { name: "null evidence", runtimeFailure: null },
  { name: "string evidence", runtimeFailure: "MODEL_PROBE_FAILED" },
  { name: "invalid code", runtimeFailure: { ...heldFailure, code: "not a code" } },
  { name: "invalid timestamp", runtimeFailure: { ...heldFailure, checkedAt: "yesterday" } },
];

export async function checkProviderEndpointRequirements(
  factory: typeof providerEndpointFixture,
  preparedEndpoint: PreparedEndpoint,
  admitConfiguration: typeof admitLoggingConfiguration,
  providerUrl: string,
  providerWorkspaceRoot: string,
) {
  let endpointWorkspaceRoot = providerWorkspaceRoot;
  const providerHome = "/private/provider-home";
  const providerHookDirectory = `${providerHome}/.oce-native-hooks`;
  const fixture = factory({
    harnessEndpoint: async () => ({ url: providerUrl, workspaceRoot: endpointWorkspaceRoot }),
  });
  const { driver, revision, provisions } = fixture;
  // Keep the admitted private workspace intact while the separate Gateway uses
  // its own writable path. The main entry takes precedence over defaults.
  const originalAgents = resourceRecord(revision.configuration.agents, "admitted agents");
  const admittedConfiguration = admitConfiguration(
    {
      ...revision.configuration,
      agents: {
        defaults: { ...objectField(originalAgents, "defaults"), workspace: providerWorkspaceRoot },
        entries: { Main: { workspace: providerWorkspaceRoot } },
      },
    },
    "info",
  );
  Object.assign(revision, { configuration: admittedConfiguration });
  const admittedAgents = structuredClone(revision.configuration.agents);
  Object.assign(fixture.sandbox, { harnessHome: providerHome });
  let workspaceValidated = false;
  fixture.sandbox.validateWorkspaceSetup = (harness, configuration) => {
    assert.equal(harness.id, revision.harness.id);
    assert.equal(
      objectField(resourceRecord(configuration.agents, "workspace agents"), "defaults").model,
      "codex/gpt-5",
    );
    workspaceValidated = true;
  };
  driver["validateWorkspaceSetup"](revision.harness, revision.configuration, fixture.sandbox.id);
  assert.equal(workspaceValidated, true);
  workspaceValidated = false;
  const context = {
    ...authContext(revision),
    workspaceSetup: {
      id: "provider-workspace-setup",
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      files: { "USER.md": "private provider workspace profile" },
      completed: false,
    },
  };
  await preparedEndpoint(fixture, context);
  const provision = resourceRecord(provisions[0], "provider provision");
  const requirements = objectField(provision, "requirements");
  const environment = resourceRecords(requirements.environment, "Harness environment");
  assert.deepEqual(requirements.labels, fixture.labels);
  assert.deepEqual(
    environment.find(({ name }) => name === "APP_TOKEN_SHA"),
    {
      name: "APP_TOKEN_SHA",
      value: createHash("sha256").update("test-transport").digest("hex"),
    },
  );
  assert.equal(
    environment.some(({ name }) => name === "APP_SERVER_TOKEN"),
    false,
  );
  assert.equal(JSON.stringify(requirements).includes("test-transport"), false);
  assert.deepEqual(
    environment.find(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
    {
      name: "OPENCLAW_NODE_SETUP_CODE",
      valueFrom: {
        secretKeyRef: {
          name: driver["workspaceNodeName"](revision),
          key: "setupCode",
        },
      },
    },
  );
  const gatewayPod = endpointGatewayPod(fixture);
  const gatewayContainer = resourceRecords(gatewayPod.containers, "Gateway containers")[0];
  assert.ok(gatewayContainer);
  const gatewayEnvironment = resourceRecords(gatewayContainer.env, "Gateway environment");
  assert.equal(
    gatewayEnvironment.find(({ name }) => name === "APP_SERVER_URL")?.value,
    providerUrl,
  );
  assert.equal(
    gatewayEnvironment.find(({ name }) => name === "OPENCLAW_REMOTE_WORKSPACE_ROOT")?.value,
    providerWorkspaceRoot,
  );
  assert.equal(
    gatewayEnvironment.find(({ name }) => name === "OPENCLAW_WORKSPACE_DIR")?.value,
    "/home/node/workspace",
  );
  const gatewayDocument = () => {
    const volume = resourceRecords(endpointGatewayPod(fixture).volumes, "Gateway volumes").find(
      ({ name }) => name === "openclaw-configuration",
    );
    assert.ok(volume);
    const configurationName = objectField(volume, "configMap").name;
    assert.ok(typeof configurationName === "string");
    const configuration = storedEndpointResource(
      fixture,
      "ConfigMap",
      configurationName,
      fixture.gatewayNamespace,
    );
    const source = objectField(configuration, "data")["openclaw.json"];
    assert.ok(typeof source === "string");
    const parsed: unknown = JSON.parse(source);
    return resourceRecord(parsed, "Gateway configuration");
  };
  assert.equal(
    objectField(objectField(gatewayDocument(), "agents"), "defaults").workspace,
    "/home/node/workspace",
  );
  assert.equal(
    objectField(objectField(objectField(gatewayDocument(), "agents"), "entries"), "Main").workspace,
    "/home/node/workspace",
  );
  assert.deepEqual(revision.configuration.agents, admittedAgents);
  assert.deepEqual(
    objectField(objectField(provision, "revision"), "configuration").agents,
    admittedAgents,
  );
  const renderedHookDirectory = () => {
    const plugins = objectField(gatewayDocument(), "plugins");
    const codex = objectField(objectField(plugins, "entries"), "codex");
    return objectField(objectField(objectField(codex, "config"), "appServer"), "nativeHookRelay")
      .credentialDirectory;
  };
  assert.equal(renderedHookDirectory(), providerHookDirectory);
  assert.equal(workspaceValidated, true);
  assert.deepEqual(gatewayPod.hostAliases, [
    { ip: "10.43.0.50", hostnames: ["tenant--sandbox.openshell.localhost"] },
  ]);
  const files = resourceRecords(requirements.files, "Harness files");
  assert.deepEqual(
    files.map(({ name, environmentVariable }) => ({
      name,
      environmentVariable,
    })),
    [
      {
        name: "runtime.json",
        environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      },
      {
        name: "config.toml",
        environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
      },
    ],
  );
  const runtimeFile = files[0];
  assert.ok(runtimeFile);
  assert.ok(typeof runtimeFile.content === "string");
  const runtimeManifest: unknown = JSON.parse(runtimeFile.content);
  assert.deepEqual(runtimeManifest, {
    kind: "codex",
    selections: {},
    modelEndpoint: { baseUrl: "https://api.openai.com/v1", modelProvider: "openai-compatible" },
  });
  await fixture.activate(undefined, context);
  assert.equal(renderedHookDirectory(), providerHookDirectory);
  // The endpoint must keep private relay material outside its file-transfer workspace.
  for (const invalidWorkspace of [
    providerHome,
    providerHookDirectory,
    `${providerHookDirectory}/files`,
    "/",
  ]) {
    endpointWorkspaceRoot = invalidWorkspace;
    for (const lifecycle of ["prepare", "activate"] as const) {
      await assert.rejects(
        fixture[lifecycle](undefined, context),
        /native hook credential directory/,
      );
      assert.equal(renderedHookDirectory(), providerHookDirectory);
    }
  }
  const privateSetup = {
    id: context.workspaceSetup.id,
    secretKeyRef: { name: driver["workspaceSetupSecretName"](revision.agentId), key: "setup.json" },
  };
  assert.deepEqual(requirements.workspaceSetup, privateSetup);
  assert.deepEqual(
    objectField(resourceRecord(fixture.endpoints.at(-1), "provider endpoint"), "requirements")
      .workspaceSetup,
    privateSetup,
  );
  assert.equal(
    JSON.stringify(fixture.endpoints).includes(context.workspaceSetup.files["USER.md"]),
    false,
  );
}

export async function checkProviderExactPeers(fixture: EndpointFixture) {
  const { revision, namespace, read, writes, provisions, peerLookups, gatewayNamespace } = fixture;
  const workspaceNodePolicy = storedEndpointResource(
    fixture,
    "NetworkPolicy",
    "allow-node-gateway",
  );
  const provision = resourceRecord(provisions[0], "provider provision");
  assert.equal(
    selectorMatches(
      podSelector(workspaceNodePolicy),
      resourceLabels(objectField(provision, "requirements").labels, "Harness labels"),
    ),
    true,
    "the provider-fenced Harness must retain exact workspace-node Gateway egress",
  );
  // The supervisor's egress is OpenShell's own (egress to every destination);
  // Compute writes no supervisor-selecting policy (finding 1127).
  assert.equal(
    read("NetworkPolicy", `allow-workspace-node-gateway-${digest(revision.agentId)}`, namespace),
    undefined,
  );
  const gatewayNodePolicy = storedEndpointResource(
    fixture,
    "NetworkPolicy",
    `allow-gateway-workspace-node-${digest(revision.agentId)}`,
    gatewayNamespace,
  );
  // Only this revision's own supervisor, never every supervisor in the namespace.
  const gatewayNodeSpec = specOf(gatewayNodePolicy, "Gateway node policy spec");
  assert.deepEqual(gatewayNodeSpec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": namespace },
          },
          podSelector: { matchLabels: supervisorPeerLabels(revision.id) },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
  // Before the Sandbox existed the policy admitted no relay at all; the policy is
  // re-applied right after provisioning, before the workspace node is awaited.
  const workspaceNodeWrites = writes.filter(
    ({ metadata }) => metadata.name === `allow-gateway-workspace-node-${digest(revision.agentId)}`,
  );
  const firstWrite = workspaceNodeWrites[0];
  assert.ok(firstWrite);
  assert.deepEqual(resourceRecord(firstWrite.spec, "initial node policy spec").ingress, []);
  assert.ok(fixture.policiesAtHarnessObservation.length > 0);
  for (const value of fixture.policiesAtHarnessObservation) {
    const policy = resourceRecord(value, "observed node policy");
    assert.deepEqual(
      objectField(policy, "spec").ingress,
      gatewayNodeSpec.ingress,
      "the exact node policy must exist before every provider Pod observation",
    );
  }
  for (const observed of fixture.provisioningPolicies) {
    const policies = resourceRecords(observed, "provisioning policies");
    assert.equal(
      policies.some(
        ({ metadata }) =>
          resourceRecord(metadata, "policy metadata").name ===
          `allow-agent-auth-${digest(revision.agentId)}`,
      ),
      false,
      "provider-fenced Harnesses receive no Compute authentication egress",
    );
    assert.equal(
      policies.some(
        ({ metadata }) =>
          resourceRecord(metadata, "policy metadata").name ===
          `allow-agent-runtime-${digest(revision.agentId)}`,
      ),
      false,
      "provider-owned transport does not grant direct ingress to the Harness",
    );
  }
  assert.ok(peerLookups.every((id: unknown) => id === revision.id));
  const agentServiceName = `agent-${digest(revision.agentId)}`;
  assert.equal(
    serviceSelector(storedEndpointResource(fixture, "Service", agentServiceName))[
      "app.kubernetes.io/name"
    ],
    `${agentServiceName}-inactive`,
  );
}

export async function checkProviderMalformedActivation(fixture: EndpointFixture) {
  const { hooks, writes } = fixture;
  fixture.observePods([fixture.pod("ready"), null]);
  await assert.rejects(fixture.prepare(), /invalid or incomplete/);
  assert.deepEqual(hooks.slice(-2), ["start", "stop"]);
  const writesBeforeActivation = writes.length;
  await assert.rejects(fixture.activate(), /invalid or incomplete/);
  assert.equal(writes.length, writesBeforeActivation);
}

export async function checkProviderLegacyPolicyActivation(fixture: EndpointFixture) {
  const {
    driver,
    revision,
    namespace,
    objects,
    key,
    read,
    save,
    clients,
    endpoints,
    gatewayNamespace,
  } = fixture;
  const agentServiceName = `agent-${digest(revision.agentId)}`;
  // Finding 861, reverse switch: a plain dedicated predecessor's Harness grant is
  // not one this revision writes, so activation deletes it and keeps the pair.
  const policies = resourceRecords(
    driver["agentNetworkPolicies"](
      { ...revision, id: "plain-predecessor", sandboxDriverId: undefined },
      { name: namespace, plane: "execution" },
    ),
    "predecessor policies",
  );
  const plainRuntime = policies
    .map(({ resource }) => resourceRecord(resource, "predecessor policy"))
    .find(
      ({ metadata }) =>
        resourceRecord(metadata, "predecessor policy metadata").name ===
        `allow-agent-runtime-${digest(revision.agentId)}`,
    );
  assert.ok(plainRuntime);
  const plainMetadata = objectField(plainRuntime, "metadata");
  save({ ...plainRuntime, metadata: { ...plainMetadata, uid: "plain-runtime-uid" } });
  const deletedPolicies: string[] = [];
  Object.assign(clients.networking, {
    async deleteNamespacedNetworkPolicy({ name, namespace: target, body }: DeletePolicy) {
      assert.ok(body?.preconditions);
      assert.equal(
        body.preconditions.uid,
        storedEndpointResource(fixture, "NetworkPolicy", name, target).metadata.uid,
      );
      deletedPolicies.push(name);
      objects.delete(key("NetworkPolicy", name, target));
    },
  });
  // Upgrade: an earlier controller's pair admitted every supervisor Pod in the
  // namespace. Activation replaces the ingress half and deletes the egress half.
  const legacySupervisor = { "openshell.ai/boundary-role": "supervisor" };
  const legacyIngressName = `allow-gateway-workspace-node-${digest(revision.agentId)}`;
  const legacyIngress = storedEndpointResource(fixture, "NetworkPolicy", legacyIngressName);
  save({
    ...legacyIngress,
    spec: {
      ...specOf(legacyIngress, "legacy ingress spec"),
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
              podSelector: { matchLabels: legacySupervisor },
            },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    },
  });
  const legacyEgress = resourceRecord(
    driver["manifest"](
      "networking.k8s.io/v1",
      "NetworkPolicy",
      `allow-workspace-node-gateway-${digest(revision.agentId)}`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: namespace, plane: "execution" },
    ),
    "legacy egress policy",
  );
  const legacyEgressMetadata = objectField(legacyEgress, "metadata");
  assert.ok(typeof legacyEgressMetadata.name === "string");
  save({
    ...legacyEgress,
    metadata: { ...legacyEgressMetadata, uid: "legacy-egress-uid" },
    spec: {
      podSelector: { matchLabels: legacySupervisor },
      policyTypes: ["Egress"],
      egress: [{ ports: [{ protocol: "TCP", port: 8080 }] }],
    },
  });
  fixture.observePods([fixture.pod("ready")]);
  await fixture.activate();
  assert.equal(endpoints.length, 2);
  assert.deepEqual(deletedPolicies, [legacyEgressMetadata.name, plainMetadata.name]);
  assert.equal(read("NetworkPolicy", legacyEgressMetadata.name), undefined);
  assert.deepEqual(
    firstPeerSelector(
      storedEndpointResource(fixture, "NetworkPolicy", legacyIngressName),
      "ingress",
    ),
    {
      matchLabels: supervisorPeerLabels(revision.id),
    },
  );
  assert.equal(
    serviceSelector(storedEndpointResource(fixture, "Service", agentServiceName))[
      "app.kubernetes.io/name"
    ],
    `${agentServiceName}-inactive`,
  );
  const gatewayPolicy = storedEndpointResource(
    fixture,
    "NetworkPolicy",
    `allow-gateway-agent-${digest(revision.agentId)}`,
    gatewayNamespace,
  );
  assert.deepEqual(specOf(gatewayPolicy, "Gateway policy spec").egress, [
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
          },
          podSelector: { matchLabels: { app: "openshell-gateway" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
}

export async function checkProviderPreparationStatus(
  fixture: EndpointFixture,
  scenario: ProviderStatusScenario,
  expected: ExpectedRevision,
) {
  const { revision } = fixture;
  const observations: SandboxHarnessStatusContext[] = [];
  fixture.sandbox.harnessStatus = async (context) => {
    observations.push(context);
    return scenario.answer;
  };
  fixture.observePods([fixture.pod("ready")]);
  assert.deepEqual(await fixture.prepare(), {
    ...expected,
    ...scenario.outcome,
  });
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.ok(observation);
  assert.equal(observation.transportToken, "test-transport");
  assert.equal(observation.revision, revision);
  assert.deepEqual(observation.requirements.labels, fixture.labels);
}

export async function checkProviderInvalidEvidence(
  fixture: EndpointFixture,
  scenario: (typeof invalidProviderEvidence)[number],
) {
  fixture.observePods([fixture.pod("ready")]);
  fixture.sandbox.harnessStatus = async () => ({
    state: "failed",
    runtimeFailure: scenario.runtimeFailure,
  });
  await assert.rejects(fixture.prepare(), /Runtime failure status returned invalid data/);
  assert.deepEqual(fixture.hooks.slice(-2), ["start", "stop"]);
}
