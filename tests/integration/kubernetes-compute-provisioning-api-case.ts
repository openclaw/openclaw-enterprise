import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { kubernetesConfigurationName } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import type {
  KubernetesComputeDriver,
  kubernetesNamespaceName as namespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { SecretReference } from "../../packages/contracts/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentDeploymentStatusResponse,
  AgentPluginCatalogResponse,
  AgentPluginDetailsResponse,
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionReadResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  IAMRoleResponse,
  NamespaceResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";
import {
  createScopedController,
  deleteNamespaces,
  gatewayName,
  harnessWorkspaceClaimName,
  hash,
  kubectl,
  missing,
  resource,
  resources,
  revisionName,
  waitFor,
} from "../helpers/kubernetes-compute-real.mjs";
import {
  createProvisioningApiFixture,
  type ProvisioningContext,
  provisioningRequestBody,
  readProvisioningResponse,
} from "../helpers/kubernetes-provisioning-api.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const Uid = Type.Object({ uid: Type.String({ minLength: 1 }) });
const StringRecord = Type.Record(Type.String(), Type.String());
const Secret = Type.Object({ metadata: Uid, data: StringRecord });
const SecretMetadataList = Type.Array(
  Type.Object({
    metadata: Type.Object({
      name: Type.String({ minLength: 1 }),
      labels: Type.Optional(StringRecord),
    }),
  }),
);
const ConfigurationMetadata = Type.Object({
  metadata: Type.Object({ annotations: StringRecord }),
});
const RenderedConfiguration = Type.Object({
  immutable: Type.Boolean(),
  data: Type.Object({ "openclaw.json": Type.String() }),
});
const Claim = Type.Object({
  metadata: Type.Object({ ...Uid.properties, deletionTimestamp: Type.Optional(Type.String()) }),
  spec: Type.Object({
    resources: Type.Object({ requests: Type.Object({ storage: Type.String() }) }),
  }),
});

async function readResource<Schema extends TSchema>(
  schema: Schema,
  kind: string,
  name: string,
  namespace: string,
): Promise<Static<Schema>> {
  const value: unknown = await resource(kind, name, namespace);
  assert.ok(Check(schema, value), `Malformed Kubernetes ${kind} ${namespace}/${name}`);
  return value;
}

function observePreparationFailures(
  context: ProvisioningContext,
  driver: KubernetesComputeDriver,
  agentId: string,
) {
  const prepareRevision = driver.prepareRevision.bind(driver);
  const failures: string[] = [];
  const observation = context.mock.method(
    driver,
    "prepareRevision",
    async (...args: Parameters<typeof prepareRevision>) => {
      try {
        return await prepareRevision(...args);
      } catch (error) {
        if (args[0].agentId === agentId) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    },
  );
  return { failures, restore: () => observation.mock.restore() };
}

// TypeScript declarations omit private method signatures. Preserve the real call and
// inspect only the fields observed by this case, starting from unknown arguments.
function observeDriverCall(
  driver: KubernetesComputeDriver,
  method: "reconcile" | "deleteGatewayPrivateStateClaim",
  observe: (args: readonly unknown[], error?: unknown) => void,
): () => void {
  const original: unknown = driver[method];
  assert.ok(typeof original === "function");
  const own = Object.getOwnPropertyDescriptor(driver, method);
  Object.defineProperty(driver, method, {
    configurable: true,
    value: async (...args: unknown[]) => {
      let result: unknown;
      try {
        result = await Reflect.apply(original, driver, args);
      } catch (error) {
        observe(args, error);
        throw error;
      }
      observe(args);
      return result;
    },
  });
  return () => {
    if (own === undefined) {
      Reflect.deleteProperty(driver, method);
    } else {
      Object.defineProperty(driver, method, own);
    }
  };
}

async function verifyPluginDiscovery(
  context: ProvisioningContext,
  fixture: Awaited<ReturnType<typeof createProvisioningApiFixture>>,
  namespaceId: string,
  secretRef: SecretReference,
  discoveryPat: string,
  rotatedPat: string,
) {
  // The Driver reads Kubernetes-backed PATs. Only the upstream provider is controlled.
  const whoami = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
  const catalogBase = "https://chatgpt.com/backend-api/ps/";
  const catalogPath = new URL(catalogBase).pathname;
  const originalFetch = globalThis.fetch;
  let expectedPat = discoveryPat;
  const observations: {
    endpoint: string;
    method: string;
    account: string | null;
    expectedToken: boolean;
  }[] = [];
  const plugin = {
    id: "fixture-plugin",
    name: "fixture",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Fixture",
      interface: {},
      requires_local_executor: false,
      app_ids: ["fixture-app"],
      app_manifest: null,
      skills: [],
      mcp_servers: [],
    },
  };
  const provider = context.mock.method(
    globalThis,
    "fetch",
    async (...[input, init]: Parameters<typeof fetch>) => {
      const request = new Request(input, init);
      const address = new URL(request.url);
      if (address.origin !== "https://auth.openai.com" && !request.url.startsWith(catalogBase)) {
        return originalFetch(input, init);
      }
      // Assert after the call because the Driver can catch and translate fetch failures.
      const endpoint =
        request.url === whoami
          ? "whoami"
          : request.url.startsWith(catalogBase)
            ? address.pathname.slice(catalogPath.length)
            : "unexpected";
      observations.push({
        endpoint,
        method: request.method,
        account: request.headers.get("ChatGPT-Account-ID"),
        expectedToken: request.headers.get("Authorization") === `Bearer ${expectedPat}`,
      });
      switch (endpoint) {
        case "whoami":
          return Response.json({
            chatgpt_account_id: "fixture-account",
            chatgpt_account_is_fedramp: false,
          });
        case "plugins/list":
          return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
        case "plugins/fixture-plugin":
          return Response.json(plugin);
        case "apps/batch":
          return Response.json({
            apps: [{ id: "fixture-app", status: "ENABLED", tools: [{ name: "search" }] }],
          });
        default:
          return new Response(null, { status: 404 });
      }
    },
  );
  const discoveryPath = `/namespaces/${namespaceId}/agents/plugins`;
  const discoveryBody = { harnessId: "codex", secretRef };
  const expectedIdentity = {
    endpoint: "whoami",
    method: "GET",
    account: null,
    expectedToken: true,
  };
  const expectedList = {
    endpoint: "plugins/list",
    method: "GET",
    account: "fixture-account",
    expectedToken: true,
  };
  try {
    const catalog = await fixture.requestChecked(
      AgentPluginCatalogResponse,
      200,
      "POST",
      discoveryPath,
      discoveryBody,
    );

    assert.equal(catalog.data.plugins[0]?.remoteId, "fixture-plugin");
    const detail = await fixture.requestChecked(
      AgentPluginDetailsResponse,
      200,
      "POST",
      `${discoveryPath}/details`,
      {
        ...discoveryBody,
        pluginId: "fixture-plugin",
      },
    );

    assert.equal(detail.data.tools?.[0]?.id, "fixture-app/search");
    assert.deepEqual(observations, [
      expectedIdentity,
      expectedList,
      expectedIdentity,
      { ...expectedList, endpoint: "plugins/fixture-plugin" },
      { ...expectedList, endpoint: "apps/batch", method: "POST" },
    ]);
    const rotated = await fixture.request(
      "PATCH",
      `/namespaces/${namespaceId}/secrets/${secretRef.id}`,
      { value: rotatedPat },
    );
    assert.equal(rotated.status, 200);
    expectedPat = rotatedPat;
    observations.length = 0;
    const refreshed = await fixture.requestChecked(
      AgentPluginCatalogResponse,
      200,
      "POST",
      discoveryPath,
      discoveryBody,
    );

    assert.deepEqual(observations, [expectedIdentity, expectedList]);
    assert.doesNotMatch(
      JSON.stringify([catalog, detail, refreshed]),
      /at-kubernetes-(fixture|rotated)-/,
    );
  } finally {
    provider.mock.restore();
  }
}

export async function runProvisioningApiCase(
  context: ProvisioningContext,
  {
    driver,
    kubernetesNamespaceName,
    controller,
    platformNamespace,
  }: {
    driver: KubernetesComputeDriver;
    kubernetesNamespaceName: typeof namespaceName;
    controller: Awaited<ReturnType<typeof createScopedController>>;
    platformNamespace: string;
  },
) {
  let handoffWorkerStop: Promise<void> | undefined;
  const fixture = await createProvisioningApiFixture(
    context,
    driver,
    controller.authentication,
    (event) => {
      if (event.code === "PROVISIONING_DEPLOYMENT_PENDING" && handoffWorkerStop === undefined) {
        handoffWorkerStop = fixture.stopWorker();
      }
    },
  );
  context.after(async () => {
    await Promise.all(
      fixture.bootstrapNamespaceIds.map((namespaceId) =>
        deleteNamespaces(kubernetesNamespaceName(namespaceId)),
      ),
    );
  });
  const waitForFailedWork = (description: string, workKey: string) =>
    waitFor(description, async () => {
      const work = await fixture.readWork(workKey);
      return work?.state === "failed_permanent" ? work : undefined;
    });
  const namespaceResponse = await fixture.requestChecked(
    NamespaceResponse,
    201,
    "POST",
    "/namespaces",
    {
      name: `k8s-provision-${randomUUID().slice(0, 8)}`,
    },
  );

  const namespaceOwner = namespaceResponse.data;
  const placement = kubernetesNamespaceName(namespaceOwner.id);
  const namespacePath = `/namespaces/${namespaceOwner.id}`;
  context.after(() => deleteNamespaces(placement));

  await fixture.startWorker();
  await waitFor(`worker to create provisioning namespace ${placement}`, async () =>
    (await missing("namespace", placement)) ? undefined : true,
  );
  await kubectl(
    "create",
    "rolebinding",
    "openclaw-controller",
    "--namespace",
    placement,
    `--clusterrole=${controller.tenantRole}`,
    `--serviceaccount=${platformNamespace}:${controller.account}`,
  );
  await waitFor("provisioning tenant Namespace to become ready", async () => {
    const observed = await fixture.requestChecked(
      NamespaceResponse,
      200,
      "GET",
      `/namespaces/${namespaceOwner.id}`,
    );

    return observed.data.status === "ready" ? observed.data : undefined;
  });
  await fixture.stopWorker();

  const discoveryPat = `at-kubernetes-fixture-${randomUUID()}`;
  const rotatedPat = `at-kubernetes-rotated-${randomUUID()}`;
  const modelSecret = await fixture.requestChecked(
    SecretResponse,
    201,
    "POST",
    `${namespacePath}/secrets`,
    {
      name: `Provisioning model key ${randomUUID().slice(0, 8)}`,
      value: discoveryPat,
    },
  );

  const slackBotSecret = await fixture.requestChecked(
    SecretResponse,
    201,
    "POST",
    `${namespacePath}/secrets`,
    {
      name: `Provisioning Slack bot token ${randomUUID().slice(0, 8)}`,
      value: `xoxb-${randomUUID()}`,
    },
  );

  await verifyPluginDiscovery(
    context,
    fixture,
    namespaceOwner.id,
    modelSecret.data.ref,
    discoveryPat,
    rotatedPat,
  );

  // The regular provisioning API must admit separately identified proxy users
  // without changing the platform's workspace identity. This fixture proves
  // persisted handoff and the Compute-rendered Gateway document, not OIDC login
  // or native Gateway authorization.
  const gatewayAuth = {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-occ-identity",
      allowUsers: ["occ-workspace-files", "oidc:member-01", "oidc:maintainer-02"],
    },
    identityScopes: {
      "occ-workspace-files": ["operator.admin"],
      "oidc:member-01": ["operator.read", "operator.write"],
      "oidc:maintainer-02": ["operator.admin"],
    },
  };
  const body = provisioningRequestBody({
    modelSecretRef: modelSecret.data.ref,
    slackBotSecretRef: slackBotSecret.data.ref,
    authMethod: "codex_pat",
    gatewayAuth,
  });
  assert.equal(
    JSON.stringify(body).includes(rotatedPat),
    false,
    "provisioning must carry only saved Secret references, not Secret values",
  );
  assert.equal(
    JSON.stringify(body).includes("xoxb-"),
    false,
    "provisioning must carry only saved Secret references, not Slack token values",
  );
  // Reject unsafe legacy enrollment and malformed human grants at the real
  // provisioning boundary, before committing an Agent or queuing deployment.
  const invalidGrants: [unknown, string][] = [
    [
      {
        ...gatewayAuth,
        trustedProxy: {
          ...gatewayAuth.trustedProxy,
          deviceAutoApprove: { enabled: true, scopes: [" operator.admin "] },
        },
      },
      "gateway.auth.trustedProxy.deviceAutoApprove.scopes",
    ],
    [
      {
        ...gatewayAuth,
        identityScopes: { ...gatewayAuth.identityScopes, "oidc:member-01": "operator.read" },
      },
      "gateway.auth.identityScopes",
    ],
    ...["operator.reed", " operator.read", "operator.read "].map((scope): [unknown, string] => [
      {
        ...gatewayAuth,
        identityScopes: {
          ...gatewayAuth.identityScopes,
          "oidc:member-01": [scope],
        },
      },
      "gateway.auth.identityScopes",
    ]),
    ...["", " oidc:member-01", "oidc:member-01 ", "oidc:removed-03"].map(
      (identity): [unknown, string] => [
        {
          ...gatewayAuth,
          identityScopes: {
            ...gatewayAuth.identityScopes,
            [identity]: ["operator.admin"],
          },
        },
        "gateway.auth.identityScopes",
      ],
    ),
  ];
  for (const [auth, setting] of invalidGrants) {
    const invalid = {
      ...body,
      configuration: {
        ...body.configuration,
        values: {
          ...body.configuration.values,
          gateway: { ...body.configuration.values.gateway, auth },
        },
      },
    };
    const denied = await fixture.request("POST", `${namespacePath}/agents/provision`, invalid);
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    const { error } = readProvisioningResponse(ErrorResponse, denied);
    assert.equal(error.code, "RESOURCE_CONFLICT");
    assert.ok(error.message.includes(setting));
  }
  const admitted = await fixture.requestChecked(
    AgentProvisioningResponse,
    202,
    "POST",
    `${namespacePath}/agents/provision`,
    body,
  );

  assert.match(admitted.data.provisioning.url, /^\/namespaces\//);
  await fixture.startWorker();
  const provisioned = await waitFor(
    "Kubernetes provisioning to queue its first deployment wait",
    async () => {
      const observed = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        200,
        "GET",
        admitted.data.provisioning.url,
      );

      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed));
      // The handoff commits revisionId while the worker still holds the provisioning lease
      // ("running"); its deployment wait is deferred ("queued") in a later transaction.
      // Inspect the handoff only after that deferral has committed (finding 1253).
      return observed.data.revisionId !== undefined && observed.data.status === "queued"
        ? observed.data
        : undefined;
    },
  );
  // A poll can see "queued" just before the pending event stops the worker; this stop covers it.
  await handoffWorkerStop;
  await fixture.stopWorker();
  assert.equal(provisioned.status, "queued");
  assert.ok(fixture.slackValidations.length > 0 && fixture.slackValidations.every(Boolean));
  assert.ok(provisioned.agentId);
  assert.ok(provisioned.configurationId);
  assert.ok(provisioned.revisionId);

  const revisions = await fixture.requestChecked(
    AgentRevisionListResponse,
    200,
    "GET",
    `${namespacePath}/agents/${provisioned.agentId}/revisions`,
  );

  assert.equal(revisions.data.length, 1);
  const [revision] = revisions.data;
  assert.ok(revision);
  assert.equal(revision.id, provisioned.revisionId);
  // The list returns a summary; the admitted Compute placement is on the exact revision.
  const exactRevision = await fixture.requestChecked(
    AgentRevisionReadResponse,
    200,
    "GET",
    `${namespacePath}/agents/${provisioned.agentId}/revisions/${provisioned.revisionId}`,
  );

  assert.ok("compute" in exactRevision.data);
  assert.equal(exactRevision.data.compute.id, driver.id);
  assert.equal(exactRevision.data.compute.implementation, driver.implementation);
  assert.deepEqual(
    asRecord(asRecord(exactRevision.data.configuration)?.gateway)?.auth,
    gatewayAuth,
  );

  const configuration = await readResource(
    ConfigurationMetadata,
    "configmap",
    kubernetesConfigurationName(revision.configurationId),
    placement,
  );
  assert.equal(
    configuration.metadata.annotations["openclaw.dev/configuration-id"],
    revision.configurationId,
  );
  assert.equal(configuration.metadata.annotations["openclaw.dev/configuration-generation"], "1");

  const secretList: unknown = await resources("secrets", placement);
  assert.ok(Check(SecretMetadataList, secretList), "Malformed Kubernetes Secret list");
  const provisionedSecrets = secretList.filter(
    ({ metadata }) =>
      metadata.labels?.["app.kubernetes.io/managed-by"] === "openclaw-enterprise" &&
      metadata.labels?.["openclaw.dev/namespace"] === namespaceOwner.id &&
      metadata.labels?.["openclaw.dev/secret"] !== undefined,
  );
  assert.equal(
    provisionedSecrets.length,
    2,
    "Console-saved Secrets must be stored through the real Kubernetes Secret Driver",
  );
  const transportName = `transport-${hash(provisioned.agentId)}`;
  const passwordName = `gateway-password-${hash(provisioned.agentId)}`;
  const transport = await readResource(Secret, "secret", transportName, placement);
  const password = await readResource(Secret, "secret", passwordName, placement);
  assert.deepEqual(
    Object.keys(transport.data),
    ["app-server-token"],
    "the canonical app-server credential must be generated before provisioning handoff",
  );
  assert.deepEqual(
    Object.keys(password.data),
    ["gateway-password"],
    "the Gateway password must be a separate canonical credential",
  );
  const canonicalNames = [
    transportName,
    passwordName,
    ...provisionedSecrets.map(({ metadata }) => metadata.name),
  ];
  for (const name of canonicalNames) {
    await readResource(Secret, "secret", name, placement);
  }

  // Seed an owned pre-upgrade RWX workspace without altering any supported Agent.
  // No RWX provisioner is needed: rejection must happen before mounting the claim.
  const legacyConfiguration = await fixture.requestChecked(
    ConfigurationResponse,
    201,
    "POST",
    `${namespacePath}/configurations`,
    {
      kind: "agent",
      values: {
        gateway: body.configuration.values.gateway,
        agents: body.configuration.values.agents,
      },
    },
  );

  const legacy = await fixture.requestChecked(
    AgentResponse,
    201,
    "POST",
    `${namespacePath}/agents`,
    {
      name: `legacy-rwx-${randomUUID()}`,
      configurationId: legacyConfiguration.data.id,
      executionMode: "dedicated",
      harnessAuth: body.harnessAuth,
    },
  );

  const legacyPath = `${namespacePath}/agents/${legacy.data.id}`;
  const role = await fixture.requestChecked(
    IAMRoleResponse,
    201,
    "POST",
    `${namespacePath}/iam/roles`,
    {
      name: `legacy-rwx-secrets-${randomUUID()}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    },
  );

  const legacyGrant = await fixture.request("POST", `${namespacePath}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: legacy.data.servicePrincipalId,
    roleId: role.data.id,
    resourceKind: "secret",
    resourceId: modelSecret.data.id,
  });
  assert.equal(legacyGrant.status, 201, JSON.stringify(legacyGrant.body));
  const credentials = await fixture.request("POST", `${legacyPath}/runtime-credentials`, {});
  assert.equal(credentials.status, 200, JSON.stringify(credentials.body));
  const workspaceName = harnessWorkspaceClaimName(legacy.data.id);
  const gatewayStateName = `gateway-state-${hash(legacy.data.id)}`;
  const claimDirectory = await temporaryDirectory(context, "openclaw-legacy-rwx-");
  const applyClaim = async (
    name: string,
    agentId: string,
    accessMode: "ReadWriteOnce" | "ReadWriteMany",
    storage: string,
  ) => {
    const claimPath = join(claimDirectory, `${name}.json`);
    await writeFile(
      claimPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name,
          namespace: placement,
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": namespaceOwner.id,
            "openclaw.dev/agent": agentId,
          },
          annotations: {
            "openclaw.dev/namespace-id": namespaceOwner.id,
            "openclaw.dev/agent-id": agentId,
          },
        },
        spec: {
          accessModes: [accessMode],
          volumeMode: "Filesystem",
          storageClassName: "local-path",
          resources: { requests: { storage } },
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("apply", "--filename", claimPath);
    return readResource(Claim, "persistentvolumeclaim", name, placement);
  };
  const originalWorkspace = await applyClaim(
    workspaceName,
    legacy.data.id,
    "ReadWriteMany",
    "40Gi",
  );
  const originalGatewayState = await applyClaim(
    gatewayStateName,
    legacy.data.id,
    "ReadWriteOnce",
    "1024Gi",
  );
  // Observe the real Driver failure without replacing its Kubernetes client or behavior.
  // A generic worker failure alone could otherwise pass for an unrelated configuration error.
  const preparation = observePreparationFailures(context, driver, legacy.data.id);
  const deployment = await fixture.requestChecked(
    AgentRevisionResponse,
    202,
    "POST",
    `${legacyPath}/deploy`,
  );

  await fixture.startWorker();
  const failedDeployment = await waitForFailedWork(
    "legacy RWX deployment to fail",
    `agent_revision:${deployment.data.id}:reconcile`,
  );
  preparation.restore();
  assert.deepEqual(
    new Set(preparation.failures),
    new Set([`Refusing invalid PersistentVolumeClaim ${workspaceName}.`]),
  );
  assert.equal(failedDeployment.reason_code, "DEPENDENCY_UNAVAILABLE");
  // Fixture images do not implement the model runtime. Its real deployment failure
  // must close the original provisioning request without creating another Agent.
  const initialFailure = await waitFor(
    "first deployment failure on provisioning status",
    async () => {
      const observed = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        200,
        "GET",
        admitted.data.provisioning.url,
      );

      return observed.data.status === "failed" ? observed.data : undefined;
    },
  );
  assert.equal(initialFailure.agentId, provisioned.agentId);
  assert.equal(initialFailure.revisionId, provisioned.revisionId);
  // Inspect the actual immutable document rendered by Compute through the API/worker
  // path. OCC's saved input alone cannot catch a renderer that drops human grants.
  // Fixture runtime qualification fails later; it does not undo this rendered snapshot.
  const renderedGatewayConfiguration = await readResource(
    RenderedConfiguration,
    "configmap",
    `${gatewayName(provisioned.agentId)}-rev-${hash(provisioned.revisionId)}`,
    placement,
  );
  assert.equal(renderedGatewayConfiguration.immutable, true);
  const renderedGateway: unknown = JSON.parse(renderedGatewayConfiguration.data["openclaw.json"]);
  assert.deepEqual(
    asRecord(asRecord(renderedGateway)?.gateway)?.auth,
    {
      ...gatewayAuth,
      trustedProxy: { ...gatewayAuth.trustedProxy, requiredHeaders: ["x-openclaw-scopes"] },
    },
    "the provisioning worker must preserve human identities and grants in the rendered Gateway ConfigMap",
  );
  const provisionedPath = `${namespacePath}/agents/${provisioned.agentId}`;
  const provisionedClaimName = `gateway-state-${hash(provisioned.agentId)}`;
  const originalClaim = await readResource(
    Claim,
    "persistentvolumeclaim",
    provisionedClaimName,
    placement,
  );
  // Verify the API server round-trip, not just the requested representation.
  // The fixture exercises claim metadata without writing 1Ti of data.
  assert.equal(originalClaim.spec.resources.requests.storage, "1Ti");
  // A second API-admitted revision must reuse state even though these fixture images
  // cannot complete native model enrollment. This is storage proof, not model proof.
  await waitForFailedWork(
    "original fixture deployment work to finish",
    `agent_revision:${provisioned.revisionId}:reconcile`,
  );
  // No other work for this unique Agent is queued during this observation.
  const reconciledClaims: { name: unknown; namespace: unknown }[] = [];
  const restoreReconciliation = observeDriverCall(
    driver,
    "reconcile",
    ([desired, ownership], error) => {
      const claim = asRecord(desired);
      if (
        error === undefined &&
        claim?.kind === "PersistentVolumeClaim" &&
        asRecord(ownership)?.agentId === provisioned.agentId
      ) {
        const metadata = asRecord(claim.metadata);
        reconciledClaims.push({ name: metadata?.name, namespace: metadata?.namespace });
      }
    },
  );
  context.after(restoreReconciliation);
  const replacement = await fixture.requestChecked(
    AgentRevisionResponse,
    202,
    "POST",
    `${provisionedPath}/deploy`,
  );

  assert.notEqual(replacement.data.id, provisioned.revisionId);
  await waitForFailedWork(
    "replacement fixture deployment to finish",
    `agent_revision:${replacement.data.id}:reconcile`,
  );
  restoreReconciliation();
  // ConfigMap creation precedes PVC verification. Only a successful real
  // reconciliation proves this replacement accepted the retained claim.
  assert.ok(
    reconciledClaims.some(
      ({ name, namespace }) => name === provisionedClaimName && namespace === placement,
    ),
  );
  const retainedClaim = await readResource(
    Claim,
    "persistentvolumeclaim",
    provisionedClaimName,
    placement,
  );
  assert.equal(retainedClaim.metadata.uid, originalClaim.metadata.uid);
  assert.deepEqual(retainedClaim.spec, originalClaim.spec);

  const initialDeployment = await fixture.requestChecked(
    AgentDeploymentStatusResponse,
    200,
    "GET",
    `${namespacePath}/agents/${provisioned.agentId}/deployments/${provisioned.revisionId}`,
  );
  assert.equal(initialDeployment.data.status, "failed");
  assert.ok(initialFailure.error);
  assert.equal(initialFailure.error.code, initialDeployment.data.error?.code);
  const undeployed = await fixture.requestChecked(AgentReadResponse, 200, "GET", legacyPath);

  assert.equal(undeployed.data.activeRevisionId, undefined);
  assert.equal(await missing("deployment", revisionName(deployment.data), placement), true);
  assert.equal(await missing("deployment", gatewayName(legacy.data.id), placement), true);
  assert.equal(
    (await readResource(Claim, "persistentvolumeclaim", gatewayStateName, placement)).metadata.uid,
    originalGatewayState.metadata.uid,
  );
  const beforeDelete = await readResource(Claim, "persistentvolumeclaim", workspaceName, placement);
  assert.equal(beforeDelete.metadata.uid, originalWorkspace.metadata.uid);
  assert.deepEqual(beforeDelete.spec, originalWorkspace.spec);

  const deleting = await fixture.request("DELETE", legacyPath);
  assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
  const failedDeletion = await waitForFailedWork(
    "legacy RWX deletion to exhaust its retry budget",
    `agent:${legacy.data.id}:reconcile:deleted`,
  );
  assert.equal(failedDeletion.reason_code, "DEPENDENCY_UNAVAILABLE");
  await fixture.stopWorker();
  const retained = await fixture.requestChecked(AgentReadResponse, 200, "GET", legacyPath);

  assert.equal(retained.data.status, "deleting");
  assert.ok("desiredRuntimeState" in retained.data);
  assert.equal(retained.data.desiredRuntimeState, "stopped");
  const rejectedWorkspace = await readResource(
    Claim,
    "persistentvolumeclaim",
    workspaceName,
    placement,
  );
  assert.equal(rejectedWorkspace.metadata.uid, originalWorkspace.metadata.uid);
  assert.deepEqual(rejectedWorkspace.spec, originalWorkspace.spec);
  assert.equal(rejectedWorkspace.metadata.deletionTimestamp, undefined);
  // Final deletion removes Gateway state before Harness workspace validation.
  // This is why the legacy Agent must be discarded with a compatible release.
  assert.equal(
    await missing("persistentvolumeclaim", gatewayStateName, placement),
    true,
    "Gateway state is removed before final deletion rejects the RWX claim",
  );
  assert.equal(await missing("secret", `transport-${hash(legacy.data.id)}`, placement), true);
  assert.equal(
    await missing("secret", `gateway-password-${hash(legacy.data.id)}`, placement),
    true,
  );
  // The unrelated Agent and its canonical credentials are not deleted.
  assert.equal(
    (await fixture.request("GET", `${namespacePath}/agents/${provisioned.agentId}`)).status,
    200,
  );
  assert.equal(
    (await readResource(Secret, "secret", transportName, placement)).metadata.uid,
    transport.metadata.uid,
  );
  // An owned claim with another request size must fail preparation and final
  // deletion without resizing or replacing data. Unlike the RWX case above,
  // the workspace is valid, so refusal comes from Gateway storage itself.
  const mismatched = await fixture.requestChecked(
    AgentResponse,
    201,
    "POST",
    `${namespacePath}/agents`,
    {
      name: `mismatched-storage-${randomUUID()}`,
      configurationId: legacyConfiguration.data.id,
      executionMode: "dedicated",
      harnessAuth: body.harnessAuth,
    },
  );

  const mismatchedPath = `${namespacePath}/agents/${mismatched.data.id}`;
  const grant = await fixture.request("POST", `${namespacePath}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: mismatched.data.servicePrincipalId,
    roleId: role.data.id,
    resourceKind: "secret",
    resourceId: modelSecret.data.id,
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const sizeCredentials = await fixture.request(
    "POST",
    `${mismatchedPath}/runtime-credentials`,
    {},
  );
  assert.equal(sizeCredentials.status, 200, JSON.stringify(sizeCredentials.body));
  const mismatchedClaimName = `gateway-state-${hash(mismatched.data.id)}`;
  const wrongSizeClaim = await applyClaim(
    mismatchedClaimName,
    mismatched.data.id,
    "ReadWriteOnce",
    "10Gi",
  );
  const sizePreparation = observePreparationFailures(context, driver, mismatched.data.id);
  const sizeDeployment = await fixture.requestChecked(
    AgentRevisionResponse,
    202,
    "POST",
    `${mismatchedPath}/deploy`,
  );

  await fixture.startWorker();
  await waitForFailedWork(
    "mismatched Gateway request to fail deployment",
    `agent_revision:${sizeDeployment.data.id}:reconcile`,
  );
  sizePreparation.restore();
  assert.deepEqual(
    new Set(sizePreparation.failures),
    new Set([`Refusing invalid PersistentVolumeClaim ${mismatchedClaimName}.`]),
  );
  const rejectedSizeClaim = await readResource(
    Claim,
    "persistentvolumeclaim",
    mismatchedClaimName,
    placement,
  );
  assert.equal(rejectedSizeClaim.metadata.uid, wrongSizeClaim.metadata.uid);
  assert.deepEqual(rejectedSizeClaim.spec, wrongSizeClaim.spec);
  assert.equal(rejectedSizeClaim.metadata.deletionTimestamp, undefined);
  assert.equal(await missing("deployment", gatewayName(mismatched.data.id), placement), true);
  // The public credential cleanup boundary sanitizes ownership errors. Observe
  // the real claim deletion underneath it without changing its result or client.
  const deletionFailures: string[] = [];
  const restoreDeletion = observeDriverCall(
    driver,
    "deleteGatewayPrivateStateClaim",
    ([ownership], error) => {
      if (error !== undefined && asRecord(ownership)?.agentId === mismatched.data.id) {
        deletionFailures.push(error instanceof Error ? error.message : String(error));
      }
    },
  );
  context.after(restoreDeletion);
  const sizeDeletion = await fixture.request("DELETE", mismatchedPath);
  assert.equal(sizeDeletion.status, 202, JSON.stringify(sizeDeletion.body));
  await waitForFailedWork(
    "mismatched Gateway request to block final deletion",
    `agent:${mismatched.data.id}:reconcile:deleted`,
  );
  restoreDeletion();
  assert.deepEqual(
    new Set(deletionFailures),
    new Set([`Refusing invalid PersistentVolumeClaim ${mismatchedClaimName}.`]),
  );
  const untouchedClaim = await readResource(
    Claim,
    "persistentvolumeclaim",
    mismatchedClaimName,
    placement,
  );
  assert.equal(untouchedClaim.metadata.uid, wrongSizeClaim.metadata.uid);
  assert.deepEqual(untouchedClaim.spec, wrongSizeClaim.spec);
  assert.equal(untouchedClaim.metadata.deletionTimestamp, undefined);

  // Compatible configured state still follows ordinary Agent deletion. The
  // deliberately incompatible claim is left to this fixture's namespace cleanup.
  const compatibleDeletion = await fixture.request("DELETE", provisionedPath);
  assert.equal(compatibleDeletion.status, 202, JSON.stringify(compatibleDeletion.body));
  await waitFor("configured Agent deletion to complete", async () => {
    const work = await fixture.readWork(`agent:${provisioned.agentId}:reconcile:deleted`);
    assert.notEqual(work?.state, "failed_permanent", JSON.stringify(work));
    // Successful deletion removes the Agent and its Work rows atomically.
    const agent = await fixture.request("GET", provisionedPath);
    assert.ok([200, 404].includes(agent.status), JSON.stringify(agent.body));
    return agent.status === 404 ? true : undefined;
  });
  await waitFor("configured Gateway state claim cleanup", async () =>
    (await missing("persistentvolumeclaim", provisionedClaimName, placement)) ? true : undefined,
  );
}
