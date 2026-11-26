import type {
  AgentRevision,
  ComputeRevisionContext,
  HarnessAuthSnapshot,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  SecretBindings,
} from "../../packages/contracts/src/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  KubernetesComputeDriver,
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { CredentialSourceRevisionError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { withNativeAdminGateway } from "../helpers/harness-configuration.mjs";
import {
  admitRevisionHarness,
  apiKeyAuth,
  authContext,
  digest,
  gatewayRouting,
  options,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  observedResource,
  policyRules,
  renderedPolicies,
  resourceRecord,
  resourceRecords,
} from "../helpers/kubernetes-rendered-resources.ts";
import {
  unboundReferenceRefusal,
  unreadableSlackTokenRefusal,
  unsubstitutedFallbackRefusal,
  unsubstitutedReferenceRefusal,
} from "../helpers/refusal-text.mjs";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type Deployment = Awaited<
  ReturnType<InstanceType<KubernetesSdk["AppsV1Api"]>["readNamespacedDeployment"]>
>;

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

export async function checkGatewayCredentialAggregateLimit() {
  const fixture = workspaceSetupFixture(false);
  const driver = concreteComputeDriver(fixture.driver);
  const source = {
    kind: "credential_source" as const,
    namespaceId: fixture.revision.namespaceId,
    id: `cs_${randomUUID()}`,
  };
  // Each Source value is legal, but 17 aliases exceed one Kubernetes Secret.
  const values = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`GW_TOKEN_${index}`, "x".repeat(65_000)]),
  );
  const revision = {
    ...fixture.revision,
    gatewayTokenServiceInstanceId: randomUUID(),
    secretBindings: Object.fromEntries(Object.keys(values).map((name) => [name, { source }])),
  };
  await assert.rejects(
    driver.prepareRevision(revision, {
      ...authContext(revision),
      secretEnvironment: [],
      gatewayStartupCredentials: {
        async authorize() {},
        async resolve() {
          return Object.fromEntries(
            Object.entries(values).map(([name, value]) => [name, { value, sourceVersion: "v1" }]),
          );
        },
      },
    }),
    (error: unknown) => {
      if (!(error instanceof CredentialSourceRevisionError)) {
        return false;
      }
      assert.equal(error.code, "GATEWAY_CREDENTIAL_DELIVERY_REFUSED");
      assert.deepEqual(driver.describePrepareRevisionFailure(error), {
        code: "GATEWAY_CREDENTIAL_DELIVERY_REFUSED",
        stage: "gateway_secret_environment",
        errorClass: "CredentialSourceRevisionError",
        message: "The staged Gateway credentials exceed the Kubernetes Secret limit of 1 MiB.",
      });
      return true;
    },
  );
  assert.equal(
    fixture.records.some(
      ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("gateway-secrets-"),
    ),
    false,
    "oversized credential material must not reach a Kubernetes Secret write",
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

type CredentialWorkspace = {
  driver: Pick<KubernetesComputeDriver, "prepareRevision" | "stopRevision">;
  revision: AgentRevision;
  namespace: string;
  objects: Map<string, ReturnType<typeof observedResource>>;
  records: ReturnType<typeof observedResource>[];
  context: {
    harnessAuth: unknown;
    workspaceSetup: NonNullable<ComputeRevisionContext["workspaceSetup"]>;
  };
};
type ModelCredentialMethod = Extract<
  ComputeRevisionContext["harnessAuth"],
  {
    source: { kind: "secret" };
  }
>["method"];

function modelAuthBindings(fixture: CredentialWorkspace, method: ModelCredentialMethod) {
  assert.equal(fixture.revision.harnessAuth.method, "api_key");
  const harnessAuth =
    method === "api_key"
      ? { ...fixture.revision.harnessAuth }
      : ({ ...fixture.revision.harnessAuth, method } satisfies HarnessAuthSnapshot);
  const backendRef = asRecord(asRecord(fixture.context.harnessAuth)?.backendRef);
  assert.ok(
    typeof backendRef?.namespaceName === "string" &&
      typeof backendRef.name === "string" &&
      typeof backendRef.key === "string" &&
      typeof backendRef.uid === "string",
    "the fixture must resolve the canonical model credential",
  );
  return {
    harnessAuth,
    resolvedHarnessAuth: {
      ...harnessAuth,
      backendRef: {
        namespaceName: backendRef.namespaceName,
        name: backendRef.name,
        key: backendRef.key,
        uid: backendRef.uid,
      },
    } satisfies ComputeRevisionContext["harnessAuth"],
  };
}

export async function checkDedicatedModelCredentialPreparation(method: ModelCredentialMethod) {
  const fixture: CredentialWorkspace = workspaceSetupFixture(false);
  const { namespace, objects, records } = fixture;
  const driver = concreteComputeDriver(fixture.driver);
  const { harnessAuth, resolvedHarnessAuth } = modelAuthBindings(fixture, method);
  const revision = { ...fixture.revision, compute: { ...fixture.revision.compute }, harnessAuth };
  admitRevisionHarness(driver, revision);

  const modelEnvironment = method === "api_key" ? "OPENAI_API_KEY" : "CODEX_ACCESS_TOKEN";
  const controlNamespace = kubernetesNamespaceName(tenant.id);
  const channelUid = "channel-source-uid";
  objects.set(`Secret:${controlNamespace}:channel-source`, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "channel-source",
      namespace: controlNamespace,
      uid: channelUid,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    data: { value: Buffer.from("fixture-channel-token").toString("base64") },
  });
  const source = { kind: "secret", namespaceId: tenant.id, id: "sec_channel" } as const;
  const preparedRevision: AgentRevision = {
    ...revision,
    secretDriverId: "kubernetes-secret",
    secretBindings: { SLACK_BOT_TOKEN: { source } },
  };
  const preparedContext: ComputeRevisionContext = {
    ...fixture.context,
    harnessAuth: resolvedHarnessAuth,
    secretEnvironment: [
      {
        name: "SLACK_BOT_TOKEN",
        namespaceId: tenant.id,
        agentId: revision.agentId,
        secretId: source.id,
        backendRef: {
          name: "channel-source",
          namespaceName: controlNamespace,
          key: "value",
          uid: channelUid,
        },
      },
    ],
  };
  await driver.prepareRevision(preparedRevision, preparedContext);
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  assert.equal(gatewayNamespace, namespace);
  const values = [...objects.values()];
  const gateway = observedResource(
    values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    ),
    "Deployment",
  );
  const harness = observedResource(
    values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    ),
    "Deployment",
  );
  const template = resourceRecord(
    resourceRecord(gateway.spec, "Gateway Deployment spec").template,
    "Gateway Pod template",
  );
  const gatewayPod = resourceRecord(template.spec, "Gateway Pod spec");
  const volumes = resourceRecords(gatewayPod.volumes, "Gateway volumes");
  const configurationVolume = volumes.find(({ name }) => name === "openclaw-configuration");
  const configurationName = asRecord(configurationVolume?.configMap)?.name;
  assert.equal(typeof configurationName, "string");
  const configuration = observedResource(
    values.find(
      ({ kind, metadata }) => kind === "ConfigMap" && metadata.name === configurationName,
    ),
    "ConfigMap",
  );
  const configurationJson = configuration.data?.["openclaw.json"];
  assert.ok(configurationJson);
  const nativeConfiguration: unknown = JSON.parse(configurationJson);
  const plugins = asRecord(asRecord(nativeConfiguration)?.plugins);
  const codex = asRecord(asRecord(plugins?.entries)?.codex);
  const appServer = asRecord(asRecord(codex?.config)?.appServer);
  const endpoint = driver.getGatewayEndpoint(preparedRevision);
  assert.ok(endpoint);
  assert.deepEqual(appServer?.nativeHookRelay, {
    url: endpoint.replace(/^wss:/, "https:") + "/node/__openclaw__/native-hook",
    credentialDirectory: "/home/node/.oce-native-hooks",
  });
  assert.equal(gateway.metadata.namespace, gatewayNamespace);
  assert.equal(harness.metadata.namespace, namespace);
  assert.equal(gatewayPod.automountServiceAccountToken, false);
  assert.equal(
    volumes.some(({ name }) => name === "openclaw-service-principal"),
    false,
  );
  const [gatewayContainer] = resourceRecords(gatewayPod.containers, "Gateway containers");
  const env = Object.fromEntries(
    resourceRecords(gatewayContainer?.env, "Gateway environment").map((entry) => {
      assert.ok(typeof entry.name === "string", "each environment entry has a name");
      return [entry.name, entry] as const;
    }),
  );
  assert.equal(
    env.APP_SERVER_URL?.value,
    `ws://agent-${digest(revision.agentId)}.${namespace}.svc:18790`,
  );
  assert.equal(env.OPENAI_API_KEY, undefined);
  const copied = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === gatewayNamespace &&
        metadata.name.startsWith("transport-"),
    ),
    "Secret",
  );
  assert.ok(copied.data);
  assert.deepEqual(Object.keys(copied.data), ["app-server-token"]);
  assert.equal(
    asRecord(asRecord(env.APP_SERVER_TOKEN?.valueFrom)?.secretKeyRef)?.name,
    copied.metadata.name,
  );
  assert.deepEqual(asRecord(env.SLACK_BOT_TOKEN?.valueFrom)?.secretKeyRef, {
    name: "channel-source",
    key: "value",
    optional: false,
  });
  const material = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === namespace &&
        metadata.name.startsWith("harness-secrets-"),
    ),
    "Secret",
  );
  assert.ok(material.data);
  assert.deepEqual(Object.keys(material.data).sort(), [modelEnvironment, "app-server-token"]);
  assert.equal(JSON.stringify(harness).includes("channel-source"), false);
  assert.equal(JSON.stringify(harness).includes("gateway-password"), false);
  const model = observedResource(objects.get(`Secret:${controlNamespace}:occ-model-key`), "Secret");
  assert.ok(model.data);
  assert.equal(material.data[modelEnvironment], model.data.value);

  // Replacing the canonical Secret invalidates the admitted UID before another Deployment write.
  const writesBefore = records.length;
  model.metadata.uid = "replaced-model-source";
  await assert.rejects(
    driver.prepareRevision(preparedRevision, preparedContext),
    /credential source identity changed/,
  );
  assert.equal(
    records.slice(writesBefore).some(({ kind }) => kind === "Deployment"),
    false,
  );

  const gatewayClaim = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("gateway-state-"),
    ),
    "PersistentVolumeClaim",
  );
  const harnessClaim = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("workspace-"),
    ),
    "PersistentVolumeClaim",
  );
  assert.equal(gatewayClaim.metadata.namespace, gatewayNamespace);
  assert.equal(harnessClaim.metadata.namespace, namespace);
  for (const record of records.filter((item) => item.kind !== "Secret")) {
    assert.equal(JSON.stringify(record).includes("test-transport"), false);
  }

  const policies = renderedPolicies(
    driver["agentNetworkPolicies"](preparedRevision, { name: namespace, plane: "execution" }),
  );
  const egress = policies.find(({ metadata }) => metadata.name.startsWith("allow-gateway-agent-"));
  const ingress = policies.find(({ metadata }) => metadata.name.startsWith("allow-agent-runtime-"));
  assert.ok(egress);
  assert.ok(ingress);
  assert.equal(egress.metadata.namespace, gatewayNamespace);
  assert.equal(ingress.metadata.namespace, namespace);
  const [egressPeer] = resourceRecords(
    policyRules(egress, "egress")[0]?.to,
    "Gateway egress peers",
  );
  const [ingressPeer] = resourceRecords(
    policyRules(ingress, "ingress")[0]?.from,
    "Harness ingress peers",
  );
  assert.deepEqual(asRecord(egressPeer?.namespaceSelector)?.matchLabels, {
    "kubernetes.io/metadata.name": namespace,
  });
  assert.deepEqual(asRecord(ingressPeer?.namespaceSelector)?.matchLabels, {
    "kubernetes.io/metadata.name": gatewayNamespace,
  });
  assert.equal(
    asRecord(asRecord(egressPeer?.podSelector)?.matchLabels)?.["openclaw.dev/revision"],
    revision.id,
  );
  assert.equal(
    asRecord(asRecord(ingressPeer?.podSelector)?.matchLabels)?.["openclaw.dev/agent"],
    revision.agentId,
  );
}

export async function checkStoppedRevisionCredentialCleanup(embedded: boolean) {
  const fixture: CredentialWorkspace = workspaceSetupFixture(embedded, true, undefined, {
    gatewayRouting,
  });
  const { driver, namespace, objects } = fixture;
  const { harnessAuth, resolvedHarnessAuth } = modelAuthBindings(fixture, "api_key");
  const revision = {
    ...fixture.revision,
    harnessAuth,
    configuration: withNativeAdminGateway(
      fixture.revision.configuration,
      "https://agent.example.test",
    ),
  };
  const context: ComputeRevisionContext = {
    ...fixture.context,
    harnessAuth: resolvedHarnessAuth,
    secretEnvironment: [],
  };
  await driver.prepareRevision(revision, context);
  const agentDigest = digest(revision.agentId);
  const revisionDigest = digest(revision.id);
  const credentialCopy = `Secret:harness-secrets-${agentDigest}-${revisionDigest}`;
  const revisionScoped = () =>
    [...objects.values()]
      .filter(
        ({ kind, metadata }) =>
          (kind === "Secret" || kind === "ConfigMap") && metadata.name.endsWith(revisionDigest),
      )
      .map(({ kind, metadata }) => `${kind}:${metadata.name}`)
      .sort();
  assert.ok(
    revisionScoped().includes(credentialCopy),
    "preparation projects the model credential into a per-revision Secret",
  );
  assert.ok(revisionScoped().includes(`ConfigMap:gateway-${agentDigest}-rev-${revisionDigest}`));
  assert.ok(
    revisionScoped().includes(`Secret:browser-delegation-${agentDigest}-${revisionDigest}`),
  );
  await driver.stopRevision(revision);
  // A stopped revision keeps no copy of its credentials; preparing it again re-projects them.
  assert.deepEqual(revisionScoped(), []);
  assert.ok(objects.has(`Namespace::${namespace}`));
  assert.ok(
    [...objects.values()].some(
      ({ kind, metadata }) => kind === "Secret" && metadata.name === "occ-model-key",
    ),
    "the canonical control-plane source is retained",
  );
  await driver.prepareRevision(revision, context);
  assert.ok(revisionScoped().includes(credentialCopy));
}

export function checkSlackCredentialBindings(
  driver: Pick<KubernetesComputeDriver, "validateHarnessAuth">,
  revision: Pick<AgentRevision, "harness" | "harnessAuth">,
) {
  const credentialSourceBinding = (id: string): SecretBindings[string] => ({
    source: { kind: "credential_source", namespaceId: tenant.id, id },
    delivery: { type: "env" },
  });
  const secretBindings = Object.freeze({
    SLACK_APP_TOKEN: credentialSourceBinding("cs_00000000-0000-4000-8000-000000000001"),
    SLACK_BOT_TOKEN: credentialSourceBinding("cs_00000000-0000-4000-8000-000000000002"),
  });

  const channelConfiguration = (channels: OpenClawConfigurationDocument) => ({
    agents: { defaults: { model: "codex/gpt-5" } },
    channels,
  });
  function validate(configuration: OpenClawConfigurationDocument, bindings: SecretBindings | null) {
    driver.validateHarnessAuth(revision.harness, revision.harnessAuth, configuration, bindings);
  }
  const envRef = (id: string) => ({ source: "env", provider: "default", id });
  const slackToken = (botToken: OpenClawConfigurationValue) =>
    channelConfiguration({ slack: { appToken: envRef("SLACK_APP_TOKEN"), botToken } });
  const slackAccount = (account: OpenClawConfigurationDocument) =>
    channelConfiguration({ slack: { accounts: { ops: account } } });
  const appBinding = { SLACK_APP_TOKEN: secretBindings.SLACK_APP_TOKEN };
  const unboundBotRefusal = {
    name: "ConfigurationHarnessError",
    message: unboundReferenceRefusal("channels.slack.botToken", "SLACK_BOT_TOKEN"),
  };

  // A stored Configuration may still bind a Namespace Secret. Its presence cannot
  // satisfy a Slack token reference that requires a Credential Source.
  assert.throws(
    () =>
      validate(slackToken(envRef("SLACK_BOT_TOKEN")), {
        ...appBinding,
        SLACK_BOT_TOKEN: {
          source: {
            kind: "secret",
            namespaceId: tenant.id,
            id: "sec_00000000-0000-4000-8000-000000000002",
          },
        },
      }),
    unboundBotRefusal,
  );
  assert.throws(
    () => validate(slackToken(envRef("SLACK_BOT_TOKEN")), appBinding),
    unboundBotRefusal,
  );
  // Agent save passes null bindings: OCC's Configuration save runs the channel binding rule.
  validate(slackToken(envRef("SLACK_BOT_TOKEN")), null);
  // Inherited keys cannot satisfy a binding. Quote non-plain names and shorten long names
  // without losing the setting path prefix or exceeding the diagnostic limit.
  const unboundId = `constructor ${"x".repeat(300)}`;
  for (const [id, shown] of [
    ["constructor", "constructor"],
    [unboundId, `"constructor ${"x".repeat(19)}…"`],
    ["slack-bot", '"slack-bot"'],
    ["SLACK_BOT_TOKEN_FOR_THE_WORKSPACE_ACCOUNT", '"SLACK_BOT_TOKEN_FOR_THE_WORKSPA…"'],
  ] as const) {
    const values = slackAccount({ botToken: envRef(id) });
    validate(values, null);
    assert.throws(
      () => validate(values, {}),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ConfigurationHarnessError");
        // A long name shortens the setting path to fit the cap.
        assert.match(error.message, /^Configuration setting channels\.slack\.accounts/);
        assert.ok(
          error.message.endsWith(
            ` references ${shown} without a Credential Source binding: bind ${shown} to a Credential Source in secretBindings, or remove the reference.`,
          ),
          error.message,
        );
        assert.ok(error.message.length <= 256, error.message);
        return true;
      },
    );
  }
  // Interpolation in any position (2475) and whole bare names in token fields (2476) need
  // bindings, even with a fallback. An escaped interpolation is literal text.
  for (const botToken of [
    "xoxb-${SLACK_BOT_TOKEN}",
    "${SLACK_BOT_TOKEN:-}",
    "${SLACK_APP_TOKEN}${SLACK_BOT_TOKEN:-xoxb-fallback}",
    " $SLACK_BOT_TOKEN ",
  ]) {
    assert.throws(() => validate(slackToken(botToken), appBinding), unboundBotRefusal, botToken);
  }
  for (const botToken of ["xoxb-$${SLACK_BOT_TOKEN}", "$SLACK_APP_TOKEN"]) {
    validate(slackToken(botToken), appBinding);
  }
  // Malformed references reach the runtime as literal text (2477). Even when a binding is
  // supplied, refuse them without disclosing a possible token in the deployment diagnostic.
  const token = "xoxb-1234567890-0987654321-AbCdEfGhIjKl";
  const tokenForm = unsubstitutedReferenceRefusal("channels.slack.botToken");
  for (const [botToken, message] of [
    ["${slack_bot}", unsubstitutedReferenceRefusal("channels.slack.botToken", "${slack_bot}")],
    [
      "${SLACK_BOT_TOKEN-xoxb-fallback}",
      unsubstitutedFallbackRefusal("channels.slack.botToken", "SLACK_BOT_TOKEN"),
    ],
    [`\${${token}}`, tokenForm],
    [`\${${token}`, tokenForm],
    // An identifier-shaped token: only a lowercase name is shown (finding 2485).
    ["${Zr9kq2LmP4xT7vB1nW3c}", tokenForm],
    ["${Zr9kq2LmP4xT7vB1n1234567890}", tokenForm],
  ] as const) {
    assert.throws(
      () =>
        validate(slackToken(botToken), {
          ...appBinding,
          slack_bot: secretBindings.SLACK_BOT_TOKEN,
          SLACK_BOT_TOKEN: secretBindings.SLACK_BOT_TOKEN,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ConfigurationHarnessError");
        assert.equal(error.message, message, botToken);
        assert.equal(error.message.includes("1234567890"), false, botToken);
        return true;
      },
    );
  }
  // Named Slack accounts have the same secret-input fields, nested `relay.authToken` included.
  assert.throws(() => validate(slackAccount({ botToken: "$OPS_BOT" }), {}), {
    name: "ConfigurationHarnessError",
    message: unboundReferenceRefusal("channels.slack.accounts.ops.botToken", "OPS_BOT"),
  });
  assert.throws(() => validate(slackAccount({ relay: { authToken: "${relay}" } }), {}), {
    name: "ConfigurationHarnessError",
    message: unsubstitutedReferenceRefusal(
      "channels.slack.accounts.ops.relay.authToken",
      "${relay}",
    ),
  });
  // Refuse sources the Slack Channel Driver cannot read, just as Configuration save does (2514).
  assert.throws(
    () =>
      validate(
        slackAccount({ botToken: { source: "file", provider: "default", id: "/run/slack/bot" } }),
        {},
      ),
    {
      name: "ConfigurationHarnessError",
      message: unreadableSlackTokenRefusal("channels.slack.accounts.ops.botToken", "secretRef"),
    },
  );
  // Ordinary text fields can contain literal names, malformed references or fallbacks.
  for (const name of ["$OPS", "${x}", "${OPS_NAME:-ops}"]) {
    validate(slackAccount({ name }), {});
  }
}
