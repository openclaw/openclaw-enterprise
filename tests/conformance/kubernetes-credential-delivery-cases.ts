import type {
  AgentRevision,
  ComputeRevisionContext,
  CredentialGatewayDriver,
  CredentialSource,
  CredentialSourceAttachment,
  CredentialSourceType,
  CredentialWithdrawalContext,
  HarnessAuthSnapshot,
  SandboxDriver,
  SandboxHarnessContext,
} from "../../packages/contracts/src/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { TestContext } from "node:test";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import { checkComputeCredentialCatalog } from "../helpers/compute-credential-catalog.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  KubernetesComputeDriver,
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { CredentialWithdrawalRefusedError } from "../../packages/occ/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { EMBEDDED_API_KEY_REQUIRED } from "../helpers/refusal-text.mjs";
import {
  admitRevisionHarness,
  apiKeyAuth,
  authContext,
  options,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type EnvironmentEntry = NonNullable<
  NonNullable<NonNullable<Deployment["spec"]>["template"]["spec"]>["containers"][number]["env"]
>[number];
type Deployment = Awaited<
  ReturnType<InstanceType<KubernetesSdk["AppsV1Api"]>["readNamespacedDeployment"]>
>;
type CredentialGatewayOperations = Pick<
  CredentialGatewayDriver,
  "listSourceTypes" | "attachForRevision" | "withdraw"
>;

function credentialGatewayFixture(id: string, operations: Partial<CredentialGatewayOperations>) {
  function unexpected(): never {
    return assert.fail("unexpected Credential Gateway operation");
  }
  return {
    id,
    capability: "credential_gateway",
    implementation: "test-credential-gateway",
    listSourceTypes: unexpected,
    validateSourceConfig: unexpected,
    registerSource: unexpected,
    updateSource: unexpected,
    sourceStatus: unexpected,
    removeSource: unexpected,
    attachForRevision: unexpected,
    attachmentStatus: unexpected,
    withdraw: unexpected,
    ...operations,
  } satisfies CredentialGatewayDriver;
}

export async function checkExactSandboxCredentialWithdrawal() {
  const withdrawals: CredentialWithdrawalContext[] = [];
  const sandboxDriver = {
    id: "sandbox-openshell",
    implementation: "openshell",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    harnessResource({ namespace, revision }) {
      return {
        namespaceName: namespace.name,
        resourceName: `os-${revision.id}`,
        agentId: revision.agentId,
        revisionId: revision.id,
      };
    },
    async cleanup() {
      assert.fail("unexpected Sandbox cleanup");
    },
  } satisfies SandboxDriver;
  let reportedSource: string | undefined;
  const credentialGatewayDriver = credentialGatewayFixture("credential-gateway", {
    async withdraw(context) {
      withdrawals.push(context);
      return { sourceId: reportedSource ?? context.sourceId, state: "revoked" };
    },
  });
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const namespace = kubernetesNamespaceName(tenant.id);
  const namespaceResource = {
    ...driver["manifest"]("v1", "Namespace", namespace, { namespaceId: tenant.id }),
    status: { phase: "Active" },
  };
  let namespaceExists = true;
  let foreignNamespace: typeof namespaceResource | undefined;
  const core = {
    async listNamespace() {
      return {
        items:
          namespaceExists && foreignNamespace === undefined
            ? [structuredClone(namespaceResource)]
            : [],
      };
    },
    async readNamespace() {
      if (foreignNamespace !== undefined) {
        return structuredClone(foreignNamespace);
      }
      if (!namespaceExists) {
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      }
      return structuredClone(namespaceResource);
    },
  } satisfies Pick<CoreApi, "listNamespace" | "readNamespace">;
  Object.assign(driver, { apiClients: Promise.resolve({ core }) });
  const source: CredentialSource = {
    id: "cs_00000000-0000-4000-8000-000000000002",
    namespaceId: tenant.id,
    name: "Withdrawn source",
    type: "openai",
    config: {},
    secrets: {},
    state: "ready",
    createdAt: tenant.createdAt,
    ownerCapability: "credential_gateway",
    driverId: credentialGatewayDriver.id,
  };
  const revision: AgentRevision = {
    ...routedRevision(driver),
    id: "rev-withdraw",
    namespaceId: tenant.id,
    agentId: "agent-withdraw",
    compute: { id: driver.id, implementation: driver.implementation },
    sandboxDriverId: sandboxDriver.id,
    credentialSources: [
      { sourceId: source.id, sourceType: source.type, credentialGatewayId: source.driverId },
    ],
    createdAt: "2026-09-28T00:00:00.000Z",
  };
  const signal = AbortSignal.timeout(5_000);

  // Compute hands the gateway the Sandbox provisioning created, in the Namespace's placement.
  assert.deepEqual(await driver.withdrawCredentialSource(revision, source, signal), {
    sourceId: source.id,
    state: "revoked",
  });
  const [withdrawal] = withdrawals;
  assert.ok(withdrawal);
  assert.equal(withdrawal.namespace.name, namespace);
  assert.deepEqual(withdrawal.sandbox, {
    namespaceName: namespace,
    resourceName: "os-rev-withdraw",
    agentId: revision.agentId,
    revisionId: revision.id,
  });
  assert.equal(withdrawal.sourceId, source.id);
  assert.equal(withdrawal.revision, revision);
  assert.equal(withdrawal.recheck, undefined);
  // A recheck of a recorded revocation reaches the gateway as one.
  await driver.withdrawCredentialSource(revision, source, signal, { recheck: true });
  assert.equal(withdrawals[1]?.recheck, true);

  // A gateway answer about another source is not evidence for this withdrawal, and retrying
  // cannot change it, so the worker fails the withdrawal at once.
  reportedSource = "cs_00000000-0000-4000-8000-000000000003";
  await assert.rejects(driver.withdrawCredentialSource(revision, source, signal), (error) => {
    assert.ok(error instanceof CredentialWithdrawalRefusedError);
    assert.equal(error.code, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
    assert.match(error.message, /withdrew another credential source/);
    return true;
  });
  reportedSource = undefined;

  // A SandboxDriver that cannot name the revision's Sandbox can never withdraw from it.
  const unaddressable = new KubernetesComputeDriver(options(), {
    sandboxDriver: {
      id: sandboxDriver.id,
      implementation: sandboxDriver.implementation,
      capability: sandboxDriver.capability,
      supportsHarnessExecutionMode: sandboxDriver.supportsHarnessExecutionMode,
      facets: sandboxDriver.facets,
      cleanup: sandboxDriver.cleanup,
    },
    credentialGatewayDriver,
  });
  withdrawals.length = 0;
  await assert.rejects(
    unaddressable.withdrawCredentialSource(revision, source, signal),
    (error) => {
      assert.ok(error instanceof CredentialWithdrawalRefusedError);
      assert.equal(error.code, "CREDENTIAL_WITHDRAWAL_MISCONFIGURED");
      return true;
    },
  );
  assert.equal(withdrawals.length, 0);

  // A Namespace at the derived name that this Namespace does not own (none claims it by label)
  // is checked before the gateway is asked: retrying cannot change it, so the worker fails the
  // withdrawal at once.
  foreignNamespace = {
    ...driver["manifest"]("v1", "Namespace", namespace, {
      namespaceId: "ns_00000000-0000-4000-8000-000000000009",
    }),
    status: { phase: "Active" },
  };
  await assert.rejects(driver.withdrawCredentialSource(revision, source, signal), (error) => {
    assert.ok(error instanceof CredentialWithdrawalRefusedError, String(error));
    assert.equal(error.code, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
    assert.match(error.message, /Refusing an unowned Kubernetes namespace/);
    return true;
  });
  assert.equal(withdrawals.length, 0);
  foreignNamespace = undefined;

  // A missing Namespace proves nothing about the Sandbox (finding 1693): the gateway's record
  // outlives it, so the gateway still withdraws, in the derived placement, and its answer stands.
  namespaceExists = false;
  withdrawals.length = 0;
  assert.deepEqual(await driver.withdrawCredentialSource(revision, source, signal), {
    sourceId: source.id,
    state: "revoked",
  });
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0]?.namespace.name, namespace);
  assert.equal(withdrawals[0]?.sandbox.resourceName, "os-rev-withdraw");
  await assert.rejects(
    driver.withdrawCredentialSource(
      { ...revision, compute: { id: "other-compute", implementation: driver.implementation } },
      source,
      signal,
    ),
    /another Compute Driver/,
  );
}

export function checkPairedCredentialSourceAuthentication() {
  const sandboxDriver = {
    id: "sandbox-openshell",
    implementation: "openshell",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("unexpected Sandbox provisioning");
    },
    async cleanup() {
      assert.fail("unexpected Sandbox cleanup");
    },
  } satisfies SandboxDriver;
  const credentialGatewayDriver = credentialGatewayFixture("credential-gateway", {});
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const snapshot = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: credentialGatewayDriver.id,
    sourceType: "openai",
    loginMode: "api_key",
  } satisfies HarnessAuthSnapshot;
  const sourceType = {
    type: "openai",
    config: [],
    secrets: [{ name: "api_key", required: true }],
    rotation: "none",
    harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
  } satisfies CredentialSourceType;
  const revision: AgentRevision = {
    ...routedRevision(driver),
    harnessAuth: snapshot,
    configuration: { agents: { defaults: { model: "codex/gpt-5" } } },
  };
  driver.validateHarnessAuth(revision.harness, snapshot, revision.configuration, {}, sourceType);

  const source: CredentialSource = {
    id: snapshot.sourceId,
    namespaceId: tenant.id,
    name: "openai",
    type: "openai",
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: credentialGatewayDriver.id,
    state: "ready",
    createdAt: "2026-09-26T00:00:00.000Z",
  };
  const prepared: {
    credentialSource?: Readonly<CredentialSource>;
    loginMode: string;
    environment: readonly EnvironmentEntry[];
  } = driver["harnessAuthForRevision"](
    revision,
    { harnessAuth: { ...snapshot, source }, secretEnvironment: [] },
    namespace,
  );
  // The Sandbox supplies the credential environment, so Compute projects no model Secret.
  assert.equal(prepared.credentialSource, source);
  assert.equal(prepared.loginMode, "api_key");
  assert.equal(
    prepared.environment.some((entry) => entry.valueFrom?.secretKeyRef !== undefined),
    false,
  );
  assert.equal(
    prepared.environment.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
  );
  assert.deepEqual(
    prepared.environment.find(({ name }) => name === "CODEX_LOGIN_MODE"),
    { name: "CODEX_LOGIN_MODE", value: "api_key" },
  );

  const nativeConfiguration = createHarnessConfiguration("openclaw", "team/model");
  const openai = nativeConfiguration.models.providers.openai;
  assert.ok(openai);
  const nativeRevision: AgentRevision = {
    ...revision,
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "dedicated",
      overrides: {},
      configuration: {},
    },
    configuration: {
      ...nativeConfiguration,
      models: { providers: { openai: { ...openai, api: "openai-completions" } } },
    },
  };
  driver.validateHarnessAuth(
    nativeRevision.harness,
    snapshot,
    nativeRevision.configuration,
    {},
    sourceType,
  );
  const nativePrepared: typeof prepared = driver["harnessAuthForRevision"](
    nativeRevision,
    { harnessAuth: { ...snapshot, source }, secretEnvironment: [] },
    namespace,
  );
  assert.equal(nativePrepared.credentialSource, source);
  assert.equal(nativePrepared.loginMode, "api_key");
  assert.equal(
    nativePrepared.environment.some((entry) => entry.valueFrom?.secretKeyRef !== undefined),
    false,
  );
  assert.equal(
    nativePrepared.environment.some(({ name }) => name === "CODEX_LOGIN_MODE"),
    false,
  );
  assert.deepEqual(
    nativePrepared.environment.find(({ name }) => name === "OPENCLAW_HARNESS_PROVIDER"),
    { name: "OPENCLAW_HARNESS_PROVIDER", value: "openai" },
  );

  // A resolved source must match the frozen snapshot exactly and still be ready.
  for (const changed of [
    { ...source, state: "deleting" },
    { ...source, driverId: "other-gateway" },
    { ...source, type: "anthropic" },
  ] satisfies CredentialSource[]) {
    assert.throws(
      () =>
        driver["harnessAuthForRevision"](
          revision,
          { harnessAuth: { ...snapshot, source: changed }, secretEnvironment: [] },
          namespace,
        ),
      /credential source does not match the admitted source/i,
    );
  }

  const incompatible = /paired Drivers and a matching supported OpenAI login mode/;
  // A PAT source selects native Codex auth storage without projecting its credential.
  const patSnapshot = {
    ...snapshot,
    sourceType: "codex-pat",
    loginMode: "codex_pat",
  } satisfies HarnessAuthSnapshot;
  const patType = {
    ...sourceType,
    type: "codex-pat",
    harnessAuth: { modelProvider: "openai", loginMode: "codex_pat" },
  } satisfies CredentialSourceType;
  driver.validateHarnessAuth(revision.harness, patSnapshot, revision.configuration, {}, patType);
  const patPrepared = driver["harnessAuthForRevision"](
    { ...revision, harnessAuth: patSnapshot },
    {
      harnessAuth: { ...patSnapshot, source: { ...source, type: "codex-pat" } },
      secretEnvironment: [],
    },
    namespace,
  );
  assert.equal(patPrepared.loginMode, "codex_pat");
  assert.deepEqual(patPrepared.environment, [
    { name: "CODEX_LOGIN_MODE", value: "codex_pat" },
    { name: "OCE_CODEX_CREDENTIAL_SOURCE", value: "1" },
    { name: "OPENCLAW_HARNESS_MODEL", value: "codex/gpt-5" },
  ]);
  // Native OpenClaw cannot load Codex PAT storage; reject before replacing a revision.
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        nativeRevision.harness,
        patSnapshot,
        nativeRevision.configuration,
        {},
        patType,
      ),
    incompatible,
  );

  const externalSnapshot = {
    ...snapshot,
    loginMode: "chatgptAuthTokens",
  } satisfies HarnessAuthSnapshot;
  // External auth must match the catalog and can only reach a native Codex receiver.
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        externalSnapshot,
        revision.configuration,
        {},
        sourceType,
      ),
    incompatible,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        nativeRevision.harness,
        externalSnapshot,
        nativeRevision.configuration,
        {},
        {
          ...sourceType,
          harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" },
        },
      ),
    incompatible,
  );
  assert.throws(
    () =>
      new KubernetesComputeDriver(options(), { sandboxDriver }).validateHarnessAuth(
        revision.harness,
        snapshot,
        revision.configuration,
        {},
        sourceType,
      ),
    incompatible,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        snapshot,
        revision.configuration,
        {},
        {
          ...sourceType,
          harnessAuth: { modelProvider: "anthropic", loginMode: "api_key" },
        },
      ),
    incompatible,
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "openclaw", version: "1.0.0", mode: "embedded" },
        snapshot,
        revision.configuration,
        {},
        sourceType,
      ),
    { message: EMBEDDED_API_KEY_REQUIRED },
  );
}

export function checkExactAccountTokenEgress() {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const revision: AgentRevision = {
    ...routedRevision(driver),
    id: "revision-account-token-1",
    namespaceId: tenant.id,
    agentId: "agent-account-token",
    servicePrincipalId: "service-principal-account-token",
    harnessAuth: {
      ...apiKeyAuth,
      method: "api_key",
      source: { ...apiKeyAuth.source, kind: "secret" },
    },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const digest = (value: string, length: number) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  const policy = driver["agentAuthenticationNetworkPolicy"](revision, {
    name: namespace,
    plane: "execution",
  });

  // Login needs public HTTPS before readiness; candidate transport must remain closed until activation.
  assert.equal(policy.metadata.name, `allow-agent-auth-${digest(revision.agentId, 12)}`);
  assert.equal(
    policy.metadata.annotations?.["openclaw.dev/service-principal-id"],
    revision.servicePrincipalId,
  );
  const spec = policy.spec;
  assert.ok(spec);
  assert.deepEqual(spec.podSelector, {
    matchLabels: {
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/network-profile": "broad-egress-v1",
    },
  });
  assert.deepEqual(spec.policyTypes, ["Egress"]);
  assert.equal(spec.ingress, undefined);
  const runtime = driver["agentNetworkPolicies"](revision, {
    name: namespace,
    plane: "execution",
  })[1];
  assert.ok(runtime?.resource.spec);
  assert.deepEqual(spec.egress, runtime.resource.spec.egress);
  assert.deepEqual(spec.egress, [
    {
      ports: [{ protocol: "TCP", port: 443 }],
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            except: [
              "10.0.0.0/8",
              "100.64.0.0/10",
              "172.16.0.0/12",
              "192.168.0.0/16",
              "169.254.0.0/16",
            ],
          },
        },
      ],
    },
  ]);
}

function concreteComputeDriver(driver: Pick<KubernetesComputeDriver, "prepareRevision">) {
  assert.ok(driver instanceof KubernetesComputeDriver);
  return driver;
}

export async function checkExternalChatgptCredentialDelivery(t: TestContext) {
  const account = {
    accountId: "workspace-external",
    planType: "enterprise",
    userId: "user-external",
    email: "agent@example.test",
    isFedramp: false,
  };
  const placeholder = "openshell-placeholder:source/account-1";
  const snapshot = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: "external-credential-gateway",
    sourceType: "external-chatgpt",
    loginMode: "chatgptAuthTokens",
  } satisfies HarnessAuthSnapshot;
  const source: CredentialSource = {
    id: snapshot.sourceId,
    namespaceId: tenant.id,
    name: "ChatGPT connection",
    type: snapshot.sourceType,
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: snapshot.credentialGatewayId,
    state: "ready",
    createdAt: tenant.createdAt,
  };
  const attachment = {
    sourceId: source.id,
    ref: "external-grant-reference",
    externalChatgptAuth: { accessTokenPlaceholder: placeholder, ...account },
  };
  let attachments: readonly CredentialSourceAttachment[] = [attachment];
  const provisions: SandboxHarnessContext[] = [];
  const listSourceTypes = async (): Promise<readonly CredentialSourceType[]> => {
    return [
      {
        type: source.type,
        config: [],
        secrets: [],
        rotation: "external",
        harnessAuth: { modelProvider: "openai", loginMode: snapshot.loginMode },
      },
    ];
  };
  const credentialGatewayDriver = {
    ...credentialGatewayFixture(snapshot.credentialGatewayId, {
      async attachForRevision(context) {
        assert.deepEqual(context.sources, [source]);
        return structuredClone(attachments);
      },
    }),
    listSourceTypes,
  };
  const sandboxDriver = {
    id: "external-sandbox",
    implementation: "openshell",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {
      assert.fail("unexpected Sandbox cleanup");
    },
    // This provider fixture owns private initialization; the Sandbox startup suite
    // proves execution. This case verifies Compute passes only its delivery identity.
    validateWorkspaceSetup(harness) {
      assert.equal(harness.id, "codex");
      assert.equal(harness.mode, "dedicated");
    },
    async provisionHarness(context) {
      provisions.push(context);
      return {
        namespaceName: context.namespace.name,
        resourceName: "external-codex",
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
  } satisfies SandboxDriver;
  const fixture = workspaceSetupFixture(
    false,
    true,
    undefined,
    {},
    { credentialGatewayDriver, sandboxDriver },
  );
  const { namespace, objects, records, state, clients, setup } = fixture;
  const driver = concreteComputeDriver(fixture.driver);
  const revision = {
    ...fixture.revision,
    sandboxDriverId: sandboxDriver.id,
    harnessAuth: snapshot,
  };
  const context: ComputeRevisionContext = {
    ...fixture.context,
    harnessAuth: { ...snapshot, source },
    secretEnvironment: [],
  };
  admitRevisionHarness(driver, revision);
  // Keep the Console's normal workspace initialization in this source-backed path.
  // This admitted source has no model Secret available to Compute. The only
  // credential material supplied by the selected gateway is an opaque placeholder.
  objects.delete(`Secret:${namespace}:occ-model-key`);
  state.ready = true;
  await driver.prepareRevision(revision, context);
  await driver.prepareRevision(revision, context);
  const provision = provisions.at(-1);
  assert.ok(provision, "preparation must reach the selected Sandbox");
  const { requirements } = provision;
  const environment = Object.fromEntries(
    requirements.environment.flatMap((entry) =>
      "value" in entry ? [[entry.name, entry.value]] : [],
    ),
  );
  assert.equal(requirements.loginMode, "chatgptAuthTokens");
  assert.equal(environment.CODEX_ACCESS_TOKEN, placeholder);
  assert.ok(environment.OCE_CODEX_CHATGPT_ACCOUNT);
  assert.deepEqual(JSON.parse(environment.OCE_CODEX_CHATGPT_ACCOUNT), account);
  assert.deepEqual(requirements.credentialAttachments, [attachment]);
  assert.deepEqual(requirements.workspaceSetup, {
    id: setup.id,
    secretKeyRef: { name: driver["workspaceSetupSecretName"](revision.agentId), key: "setup.json" },
  });
  assert.equal(
    JSON.stringify(requirements).includes(setup.files["AGENTS.md"]),
    false,
    "Sandbox requirements carry only private delivery identity, never the workspace documents",
  );
  assert.equal(
    requirements.environment.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
  );
  assert.equal(
    requirements.environment.some(
      (entry) =>
        "valueFrom" in entry && entry.valueFrom.secretKeyRef.name.includes("harness-secrets"),
    ),
    false,
  );
  const gateways = records.filter(
    (entry) => entry.kind === "Deployment" && entry.metadata.name.startsWith("gateway-"),
  );
  assert.ok(gateways.length > 0, "preparation must render the separate Agent Gateway");
  assert.equal(JSON.stringify(gateways).includes(placeholder), false);
  assert.equal(JSON.stringify(gateways).includes(account.accountId), false);
  assert.equal(
    records.some(
      (entry) => entry.kind === "Secret" && entry.metadata.name.startsWith("harness-secrets-"),
    ),
    false,
  );

  const nodeSecret = driver["manifest"](
    "v1",
    "Secret",
    driver["workspaceNodeName"](revision),
    driver["workspaceNodeOwnership"](revision),
    { name: namespace, plane: "execution" },
  );
  assert.equal(nodeSecret.metadata.namespace, namespace);
  const { core } = clients;
  const listPods = core.listNamespacedPod;
  const catalogCore = Object.assign(core, {
    listNamespacedPod: (request: { namespace?: string; labelSelector?: string }) =>
      listPods({ ...request, namespace: request.namespace ?? namespace }),
  });
  try {
    await checkComputeCredentialCatalog(
      t,
      driver,
      revision,
      context,
      credentialGatewayDriver,
      objects,
      { ...nodeSecret, metadata: { ...nodeSecret.metadata, namespace } },
      catalogCore,
      requirements.labels,
    );
  } finally {
    core.listNamespacedPod = listPods;
  }

  await t.test("selects Harness authentication by source ID among multiple attachments", () => {
    const toolAttachment = {
      sourceId: "cs_00000000-0000-4000-8000-000000000002",
      ref: "tool-grant-reference",
    };
    // Tool attachments may precede the model attachment. Only the selected
    // Harness source supplies Codex's local authentication state.
    const environment = driver["credentialSourceEnvironment"](revision, [
      toolAttachment,
      attachment,
    ]);
    assert.deepEqual(environment, [
      { name: "CODEX_ACCESS_TOKEN", value: placeholder },
      { name: "OCE_CODEX_CHATGPT_ACCOUNT", value: JSON.stringify(account) },
    ]);
  });

  // A trusted Driver response still has to match the admitted source and
  // receiver contract before any new Sandbox provisioning occurs.
  for (const [name, invalid, expected] of [
    ["missing attachment", [], /each bound source exactly once/],
    ["duplicate attachment", [attachment, attachment], /each bound source exactly once/],
    [
      "foreign source",
      [{ ...attachment, sourceId: "cs_00000000-0000-4000-8000-000000000002" }],
      /each bound source exactly once/,
    ],
    [
      "unexpected extra source",
      [attachment, { sourceId: "cs_00000000-0000-4000-8000-000000000002", ref: "foreign-grant" }],
      /each bound source exactly once/,
    ],
    ["missing account", [{ sourceId: source.id, ref: attachment.ref }], /invalid external ChatGPT/],
    [
      "empty account",
      [
        {
          ...attachment,
          externalChatgptAuth: { ...attachment.externalChatgptAuth, accountId: "" },
        },
      ],
      /invalid external ChatGPT/,
    ],
  ] satisfies [string, CredentialSourceAttachment[], RegExp][]) {
    await t.test(name, async () => {
      attachments = invalid;
      const before = provisions.length;
      await assert.rejects(driver.prepareRevision(revision, context), expected);
      assert.equal(provisions.length, before);
    });
  }
}

export async function checkCanonicalGatewayChannelSecret() {
  const fixture = workspaceSetupFixture(false);
  const { revision, namespace, objects, records } = fixture;
  const driver = concreteComputeDriver(fixture.driver);
  const target = kubernetesNamespaceName(tenant.id);
  const source = {
    ...driver["manifest"](
      "v1",
      "Secret",
      "channel-source",
      { namespaceId: tenant.id },
      { name: target, plane: "execution" },
    ),
    data: {
      token: Buffer.from("channel-token").toString("base64"),
      unrelated: Buffer.from("not-admitted").toString("base64"),
    },
  };
  source.metadata.uid = "channel-source-uid";
  objects.set(`Secret:${target}:channel-source`, source);
  const projection = {
    name: "SLACK_BOT_TOKEN",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    secretId: "channel-secret",
    backendRef: {
      name: "channel-source",
      namespaceName: target,
      key: "token",
      uid: source.metadata.uid,
    },
  };
  assert.deepEqual(
    await driver["deliverGatewaySecrets"](
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [projection],
    ),
    [projection],
  );
  assert.equal(records.length, 0, "direct references must not create copies");
  source.metadata.uid = "replaced-secret";
  await assert.rejects(
    driver["deliverGatewaySecrets"](
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [projection],
    ),
    /Gateway credential source is unavailable/,
  );
  await assert.rejects(
    driver["deliverGatewaySecrets"](
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [
        {
          ...projection,
          backendRef: { ...projection.backendRef, namespaceName: "another-tenant" },
        },
      ],
    ),
    /outside the admitted scope/,
  );
}

export async function checkPodModelCredentialPlacement(embedded: boolean) {
  const { driver, revision, objects } = workspaceSetupFixture(embedded, false);
  await driver.prepareRevision(revision, { ...authContext(revision), secretEnvironment: [] });
  const workloads = [...objects.values()].filter(({ kind }) => kind === "Deployment");
  assert.equal(workloads.length, embedded ? 1 : 2);
  let modelConsumers = 0;
  for (const workload of workloads) {
    const template = (workload.spec as Deployment["spec"])?.template;
    assert.ok(template?.spec);
    for (const container of template.spec.containers) {
      for (const environment of container.env ?? []) {
        const ref = environment.valueFrom?.secretKeyRef;
        if (!ref) {
          continue;
        }
        const secret = objects.get(`Secret:${workload.metadata.namespace}:${ref.name}`);
        assert.ok(secret, `${environment.name} must resolve in the Pod namespace`);
        assert.ok(ref.key && secret.data?.[ref.key]);
        if (environment.name === "OPENAI_API_KEY") {
          const receiver = embedded ? "gateway" : "agent";
          assert.equal(container.name, receiver);
          assert.equal(template.metadata?.labels?.["openclaw.dev/workload-role"], receiver);
          modelConsumers += 1;
        }
      }
    }
  }
  assert.equal(modelConsumers, 1);
}
