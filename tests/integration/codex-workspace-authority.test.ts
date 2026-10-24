import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import { assertExecutionAdmission } from "../../packages/contracts/src/index.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import type { CredentialProviderDefinition } from "../../packages/contracts/src/index.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createServer, request as httpsRequest } from "node:https";
import { buffer } from "node:stream/consumers";
import { selfSigned } from "../helpers/certificates.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { listen } from "../helpers/listen.mjs";
import { requestId, staticEgressFixture } from "../helpers/static-egress.mjs";
import { installEgressAuthority } from "../../apps/controller/src/composition/egress-authority.ts";
import { egressAssociationInstallation } from "../../packages/contracts/src/index.ts";
import type {
  CredentialProxyExchange,
  EgressInstallation,
  CapturedEgressUse,
  AcceptedEgressAssociation,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { openAiStaticProvider } from "../../apps/controller/src/drivers/egress-proxy/openai-provider.ts";
import { createCodexWorkspacePatProvider } from "../../apps/controller/src/drivers/egress-proxy/codex-workspace-provider.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import type { AuditEvent, CredentialSource } from "../../packages/contracts/src/index.ts";

function nativeModel(slug = "fixture-model") {
  return {
    slug,
    base_instructions: "",
    display_name: "Synthetic native model",
    description: "Controlled model",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    default_reasoning_level: "medium",
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    support_verbosity: true,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    context_window: 128000,
  };
}

// This journey uses the real API, IAM, source store and Kubernetes Secret Driver.
// The registered Driver is a controlled admission peer; it does not qualify a native sender.
async function workspaceJourney(t: TestContext, persistence: "memory" | "postgres") {
  const f = await staticEgressFixture(t, {
    admitRevision: false,
    ...(persistence === "postgres"
      ? {
          appFactory: (context: TestContext, options: object) =>
            postgresApp(context, { ...options, recordOperations: true }),
        }
      : {}),
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: "workspace-admission",
        implementation: "controlled-workspace-admission",
        definition: OpenShellSandboxDriver,
      },
    ],
  });
  async function workerRefusal(revisionId: string, expected: string) {
    if (!("pool" in f)) {
      return;
    }
    const worker = new ControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      computeDriver: {
        ...createDevelopmentComputeDriver(),
        capability: "compute",
        validateExecutionAdmission: assertExecutionAdmission,
        async stopRevision() {},
        async prepareRevision() {
          assert.fail("owner refusal must precede Compute preparation");
        },
      },
      proxyDriver: f.egress,
      pollIntervalMs: 10,
    });
    await worker.start();
    try {
      const result = await waitFor("owner refusal", async () => {
        const { rows } = await f.pool.query(
          "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key=$1",
          [`agent_revision:${revisionId}:reconcile`],
        );
        return rows[0]?.state === "failed_permanent" ? rows[0] : undefined;
      });
      assert.equal(result.reason_code, expected);
    } finally {
      await worker.stop();
    }
  }
  // The existing Gateway-owned path must retain its original persisted shape.
  const gatewayDeployment = await f.deployAgent(f.namespace.id, f.agent.id);
  const gatewayRevision = await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, gatewayDeployment.id),
  );
  assert.deepEqual(gatewayRevision?.harnessAuth, {
    method: "credential_source",
    sourceId: f.source.id,
    credentialGatewayId: "openshell-credentials",
    sourceType: "openai",
    loginMode: "api_key",
  });
  await workerRefusal(gatewayDeployment.id, "CREDENTIAL_GATEWAY_MISMATCH");
  let admittedSource: CredentialSource | undefined;
  const nativeProvider = createCodexWorkspacePatProvider({
    workspaceForSource(source) {
      return source.id === admittedSource?.id && source.namespaceId === admittedSource.namespaceId
        ? "11111111-1111-4111-8111-111111111111"
        : undefined;
    },
  });
  let substitutedCatalogModel: string | undefined;
  const provider: CredentialProviderDefinition = {
    ...nativeProvider,
    classify(route, request) {
      const operation = nativeProvider.classify(route, request);
      // A faulty selected provider cannot substitute the immutable route's model.
      return operation?.kind === "workspace_bootstrap" &&
        operation.action === "models" &&
        substitutedCatalogModel
        ? { ...operation, model: substitutedCatalogModel }
        : operation;
    },
  };
  let catalogUse: CapturedEgressUse | undefined;
  const providers: CredentialProviderDefinition[] = [provider];
  const implementation = "controlled-workspace-admission";
  const sandbox = Object.create(f.sandboxDriver);
  Object.defineProperties(sandbox, {
    id: { value: "workspace-admission" },
    implementation: { value: implementation },
  });
  let exchange: CredentialProxyExchange | undefined;
  const peerToken = randomUUID();
  const sandboxId = randomUUID();
  const instanceId = randomUUID();
  const exchangeId = randomUUID();
  const accepted = new Map<string, AcceptedEgressAssociation>();
  const peerExpiresAt = new Date(Date.now() + 30_000).toISOString();
  const transport = {
    async verify(token: string) {
      return token === peerToken
        ? {
            sender: f.egress.sourceControl.sender,
            sandboxId,
            instanceId,
            exchangeId,
            expiresAt: peerExpiresAt,
          }
        : undefined;
    },
    capture(use: CapturedEgressUse) {
      if (use.operation.kind === "workspace_bootstrap" && use.operation.action === "models") {
        catalogUse = use;
      }
      const association = {
        execution: use.route.binding.execution,
        installation: egressAssociationInstallation(use.installation),
        exchangeId,
        responseId: randomUUID(),
        custodyId: randomUUID(),
      };
      accepted.set(use.id, association);
      return association;
    },
    owns(association: AcceptedEgressAssociation, use: CapturedEgressUse) {
      return isDeepStrictEqual(accepted.get(use.id), association);
    },
  };
  const proxy = Object.create(f.egress);
  Object.defineProperties(proxy, {
    id: { value: "workspace-admission" },
    implementation: { value: implementation },
    sourceControl: { value: { ...f.egress.sourceControl, providers } },
    // This adapter observes an in-process controlled installation, not a deployed supervisor.
    verifyInstallation: {
      value: async (_context: unknown, observed: EgressInstallation) =>
        installed !== undefined && isDeepStrictEqual(installed, observed),
    },
    bindExchange: {
      value: async (create: (owner: typeof transport) => CredentialProxyExchange) => {
        exchange = create(transport);
        return {
          close() {
            accepted.clear();
          },
        };
      },
    },
  });
  const owner = new InstalledDriver(
    { id: "workspace-admission", implementation, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  f.controller.registerDriver(owner);
  f.controller.selectDriver("sandbox", sandbox.id);
  f.controller.selectDriver("credential_proxy", proxy.id);
  const result = await f.request("POST", `/namespaces/${f.namespace.id}/credential-sources`, {
    body: { name: "workspace-pat", type: "codex-pat", secrets: { access_token: f.secret.ref } },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.data.ownerCapability, "credential_proxy");
  const source = await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.findCredentialSource(f.namespace.id, result.data.id),
  );
  assert.ok(source?.egress);
  assert.equal(source.egress.adoption, "live");
  assert.equal(source.egress.key.provider.id, provider.ref.id);
  assert.throws(() => provider.normalizeGrant(["fixture-model"], {}, source), /exact-source/);
  admittedSource = source;
  const grant = provider.normalizeGrant(["fixture-model"], {}, source);
  assert.equal(grant.kind, "workspace_inference");
  assert.throws(
    () =>
      provider.normalizeGrant(
        ["fixture-model"],
        {},
        {
          ...source,
          namespaceId: "another-tenant",
        },
      ),
    /exact-source/,
  );
  const draft = await f.createConfiguration(f.namespace.id, {});
  const body = {
    configurationId: draft.id,
    harnessAuth: { method: "credential_source", sourceId: source.id },
    credentialSources: [{ sourceId: source.id }],
  };
  const patch = () =>
    f.request("PATCH", `/namespaces/${f.namespace.id}/agents/${f.agent.id}`, { body });
  // A model-free draft still verifies the exact registered owner.
  assert.equal((await patch()).status, 200, "save a valid workspace draft without a model");
  const missingSource = `cs_${randomUUID()}`;
  assert.equal(
    (
      await f.request("PATCH", `/namespaces/${f.namespace.id}/agents/${f.agent.id}`, {
        body: {
          ...body,
          harnessAuth: { method: "credential_source", sourceId: missingSource },
          credentialSources: [{ sourceId: missingSource }],
        },
      })
    ).status,
    404,
  );
  const { sourceOwnership: _ownership, ...unownedProvider } = provider;
  for (const candidates of [
    [],
    [{ ...provider, ref: { ...provider.ref, generation: 2 } }],
    [provider, provider],
    [unownedProvider],
  ]) {
    providers.splice(0, providers.length, ...candidates);
    const refused = await patch();
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
  }
  providers.splice(0, providers.length, provider);
  const sender = proxy.sourceControl.sender;
  proxy.sourceControl.sender = { ...sender, generation: sender.generation + 1 };
  assert.equal((await patch()).status, 503, "the admitted sender must remain exact");
  proxy.sourceControl.sender = sender;
  f.controller.selectDriver("sandbox", f.sandboxDriver.id);
  f.controller.selectDriver("credential_proxy", f.egress.id);
  assert.equal(
    (await patch()).status,
    503,
    "a different registered owner cannot select this source",
  );
  f.controller.selectDriver("sandbox", sandbox.id);
  f.controller.selectDriver("credential_proxy", proxy.id);
  if ("createNamespaceMember" in f) {
    const member = await f.createNamespaceMember("no-source-authority", f.namespace.id, [
      ["update", "agent"],
      ["read", "configuration"],
    ]);
    // Permit the previous source so this refusal discriminates the newly selected source.
    const role = await f.request("POST", `/namespaces/${f.namespace.id}/iam/roles`, {
      body: {
        name: "previous-source-use",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      },
    });
    assert.equal(role.status, 201);
    const previousAccess = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/iam/access-bindings`,
      {
        body: {
          subjectKind: "identity",
          subjectId: member.principal.id,
          roleId: role.data.id,
          resourceKind: "credential_source",
          resourceId: f.source.id,
        },
      },
    );
    assert.equal(previousAccess.status, 201);
    const session = await f.signIn(member.credentials);
    const denied = await f.request("PATCH", `/namespaces/${f.namespace.id}/agents/${f.agent.id}`, {
      body,
      session,
    });
    assert.equal(denied.status, 403);
  }
  body.configurationId = f.agent.configurationId;
  admittedSource = undefined;
  assert.equal((await patch()).status, 503);
  admittedSource = source;
  const updated = await patch();
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const agent = updated.data;
  const post = async (path: string, body: unknown) => {
    const result = await f.request("POST", `/namespaces/${f.namespace.id}/${path}`, { body });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.data;
  };
  const role = await post("iam/roles", {
    name: "workspace-use",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const access = await post("iam/access-bindings", {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  });
  body.configurationId = draft.id;
  assert.equal((await patch()).status, 200);
  const undeployable = await f.request(
    "POST",
    `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
  );
  assert.equal(undeployable.status, 404, JSON.stringify(undeployable.body));
  body.configurationId = f.agent.configurationId;
  assert.equal((await patch()).status, 200);
  const deployed = await f.deployAgent(f.namespace.id, agent.id);
  const revision = await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.revisions.findRevision(f.namespace.id, agent.id, deployed.id),
  );
  assert.ok(revision?.egressPlan);
  assert.deepEqual(revision.harnessAuth, {
    method: "credential_source",
    sourceId: source.id,
    credentialProxyId: proxy.id,
    sourceType: "codex-pat",
    loginMode: "codex_pat",
    egress: source.egress,
  });
  assert.deepEqual(revision.credentialSources, [
    { sourceId: source.id, credentialProxyId: proxy.id, sourceType: "codex-pat" },
  ]);
  if ("pool" in f) {
    const restored = await new PostgresPlatformState(f.pool).read((view) =>
      view.revisions.findRevision(f.namespace.id, agent.id, deployed.id),
    );
    assert.deepEqual(restored, revision, "a fresh State reader restores the actual Proxy owner");
    const stored: { rows: { admitted_spec: Record<string, unknown> }[] } = await f.pool.query(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1",
      [deployed.id],
    );
    for (const invalid of [
      { ...revision.harnessAuth, sourceId: `cs_${randomUUID()}` },
      { ...revision.harnessAuth, credentialGatewayId: "openshell-credentials" },
      { ...revision.harnessAuth, egress: undefined },
      {
        ...revision.harnessAuth,
        egress: {
          ...source.egress,
          key: { ...source.egress.key, namespaceId: "another-tenant" },
        },
      },
    ]) {
      // Constraints run before duplicate-key handling; the immutable original stays intact.
      await assert.rejects(
        f.pool.query(
          `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
         SELECT id, namespace_id, agent_id, revision_number, backend_id, $2::jsonb, admitted_at
         FROM occ.agent_revisions WHERE id=$1 ON CONFLICT DO NOTHING`,
          [deployed.id, { ...stored.rows[0]!.admitted_spec, harness_auth: invalid }],
        ),
        { code: "23514" },
      );
    }
    await workerRefusal(deployed.id, "EGRESS_PROVIDER_UNAVAILABLE");
    return;
  }
  const installed: EgressInstallation = {
    plan: revision.egressPlan,
    sandboxId,
    sender: proxy.sourceControl.sender,
    installedAt: new Date().toISOString(),
    enforcement: {
      instanceId,
      configurationId: randomUUID(),
      policyHash: "ab".repeat(32),
      authorityScope: "execution",
    },
  };
  await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.recordEgressInstallation(installed!),
  );
  const binding = await installEgressAuthority(f.controller, owner);
  t.after(() => binding?.close());
  assert.ok(exchange);
  const directory = await temporaryDirectory(t, "workspace-origin-");
  const tls = await selfSigned(directory, {
    subjectAltName: "DNS:auth.openai.com,DNS:chatgpt.com",
  });
  let arrivals = 0;
  const identity = {
    chatgpt_user_id: "synthetic-user",
    chatgpt_plan_type: "team",
    chatgpt_account_id: "11111111-1111-4111-8111-111111111111",
    chatgpt_account_is_fedramp: false,
  };
  let originBody: Record<string, unknown> = identity;
  let originStatus = 200;
  const origin = createServer(tls, async (request, response) => {
    arrivals++;
    assert.equal(request.headers.authorization, "Bearer synthetic-key-initial");
    const catalog = request.url === "/backend-api/codex/models?client_version=0.163.0";
    const policy = request.url === "/backend-api/wham/config/bundle";
    assert.equal(request.headers.host, catalog || policy ? "chatgpt.com" : "auth.openai.com");
    if (!catalog && !policy) {
      assert.equal(request.url, "/api/accounts/v1/user-auth-credential/whoami");
    }
    response.statusCode = originStatus;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(originBody));
  });
  const port = await listen(t, origin);
  const request = () => ({
    id: requestId(),
    method: "GET",
    url: "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
    headers: [] as [string, string][],
    body: new Uint8Array(),
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    verifiedExecutionPolicyHash: installed!.enforcement.policyHash,
  });
  const signal = AbortSignal.timeout(20_000);
  // These refusals occur before an authoritative Secret read, including forged workspace headers.
  const beforeInvalid = f.secretReads;
  for (const invalid of [
    { ...request(), url: "https://auth.openai.com/unlisted" },
    {
      ...request(),
      url: "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami?",
    },
    { ...request(), url: "http://auth.openai.com/api/accounts/v1/user-auth-credential/whoami" },
    { ...request(), headers: [["host", "another.example"]] as [string, string][] },
    { ...request(), headers: [["transfer-encoding", "chunked"]] as [string, string][] },
    {
      ...request(),
      headers: [["chatgpt-account-id", "another-workspace"]] as [string, string][],
    },
    {
      ...request(),
      method: "POST",
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: [
        ["content-type", "application/json"],
        ["chatgpt-account-id", "11111111-1111-4111-8111-111111111111"],
      ] as [string, string][],
      body: Buffer.from(
        JSON.stringify({ model: "unadmitted-model", input: "hello", store: false }),
      ),
    },
  ]) {
    assert.equal((await exchange.resolve(peerToken, sandboxId, invalid, signal)).kind, "refused");
  }
  assert.equal(f.secretReads, beforeInvalid);
  const first = request();
  const resolved = await exchange.resolve(peerToken, sandboxId, first, signal);
  assert.ok(resolved.kind === "ready", JSON.stringify(resolved));
  const authorizeSend = exchange.authorizeSend.bind(exchange);
  const authorize = (operation: ReturnType<typeof request>, ready: typeof resolved) =>
    authorizeSend(
      peerToken,
      sandboxId,
      operation.id,
      ready.handle,
      ready.evidence,
      ready.injectionDigest,
      operation.deadlineAt,
      signal,
    );
  const permission = await authorize(first, resolved);
  assert.equal(permission.kind, "allow", JSON.stringify(permission));
  const receive = async (
    headers: readonly (readonly [string, string])[],
    target = first,
  ): Promise<import("../../packages/contracts/src/index.ts").EgressResponse> => {
    const outgoing = httpsRequest({
      hostname: "127.0.0.1",
      port,
      servername: new URL(target.url).hostname,
      ca: tls.cert,
      path: new URL(target.url).pathname + new URL(target.url).search,
      headers: {
        ...Object.fromEntries(target.headers),
        host: new URL(target.url).hostname,
        ...Object.fromEntries(headers),
      },
    });
    const received = once(outgoing, "response");
    outgoing.end();
    const [response] = (await received) as [IncomingMessage];
    return {
      status: response.statusCode!,
      headers: [["content-type", String(response.headers["content-type"])]],
      body: await buffer(response),
      trailers: [],
    };
  };
  const response = await receive(resolved.headers);
  assert.equal(await exchange.beginResponse(peerToken, sandboxId, first.id), resolved.handle);
  assert.equal((await exchange.protectResponse(resolved.handle, response, signal))?.status, 200);
  assert.equal(arrivals, 1);
  const catalogRequest = () => ({
    ...request(),
    url: "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0",
    headers: [["chatgpt-account-id", identity.chatgpt_account_id]] as [string, string][],
  });
  const catalog = catalogRequest();
  const catalogReady = await exchange.resolve(peerToken, sandboxId, catalog, signal);
  assert.equal(catalogReady.kind, "ready");
  assert.deepEqual(catalogUse?.operation, {
    kind: "workspace_bootstrap",
    action: "models",
    workspaceId: identity.chatgpt_account_id,
    model: "fixture-model",
  });
  assert.equal(catalogUse?.route.binding.grant.kind, "workspace_inference");
  if (catalogReady.kind !== "ready") {
    return;
  }
  assert.equal(
    (
      await exchange.authorizeSend(
        peerToken,
        sandboxId,
        catalog.id,
        catalogReady.handle,
        catalogReady.evidence,
        catalogReady.injectionDigest,
        catalog.deadlineAt,
        signal,
      )
    ).kind,
    "allow",
  );
  originBody = { models: [nativeModel("other-model"), nativeModel()] };
  const catalogResponse = await receive(catalogReady.headers, catalog);
  assert.equal(await exchange.beginResponse(peerToken, sandboxId, catalog.id), catalogReady.handle);
  const projected = await exchange.protectResponse(catalogReady.handle, catalogResponse, signal);
  assert.ok(projected);
  assert.deepEqual(JSON.parse(Buffer.from(projected.body).toString()), { models: [nativeModel()] });
  originBody = identity;

  const policyRequest = () => ({
    ...catalogRequest(),
    url: "https://chatgpt.com/backend-api/wham/config/bundle",
  });
  assert.ok(
    installed.plan.routes.some(
      (route) =>
        route.origin === "https://chatgpt.com" &&
        route.path === "/backend-api/wham/config/bundle" &&
        route.method === "GET",
    ),
  );
  const policyReads = f.secretReads;
  const invalidPolicyRequests: Partial<
    import("../../packages/contracts/src/index.ts").EgressRequest
  >[] = [
    { method: "POST" },
    { body: Buffer.from("{}") },
    ...["?", "?a=1", "/", "/../bundle"].map((suffix) => ({ url: policyRequest().url + suffix })),
    { url: "http://chatgpt.com/backend-api/wham/config/bundle" },
    { url: "https://auth.openai.com/backend-api/wham/config/bundle" },
    { url: "https://chatgpt.com:444/backend-api/wham/config/bundle" },
    { headers: [["chatgpt-account-id", "wrong"]] },
    { headers: [...policyRequest().headers, ["host", "wrong"]] },
    { headers: [...policyRequest().headers, ["x-original-url", "/another"]] },
  ];
  for (const changed of invalidPolicyRequests) {
    const invalid = { ...policyRequest(), ...changed };
    assert.equal((await exchange.resolve(peerToken, sandboxId, invalid, signal)).kind, "refused");
  }
  assert.equal(f.secretReads, policyReads);
  const policy = policyRequest();
  const policyReady = await exchange.resolve(peerToken, sandboxId, policy, signal);
  assert.ok(policyReady.kind === "ready");
  assert.equal((await authorize(policy, policyReady)).kind, "allow");
  originBody = {
    config_toml: { enterprise_managed: [] },
    requirements_toml: {
      enterprise_managed: [
        { id: "restriction", name: "Read only", contents: 'allowed_sandbox_modes = ["read-only"]' },
      ],
    },
  };
  const policyResponse = await receive(policyReady.headers, policy);
  assert.equal(await exchange.beginResponse(peerToken, sandboxId, policy.id), policyReady.handle);
  const deliveredPolicy = await exchange.protectResponse(
    policyReady.handle,
    policyResponse,
    signal,
  );
  assert.ok(deliveredPolicy);
  assert.deepEqual(JSON.parse(Buffer.from(deliveredPolicy.body).toString()), originBody);
  originBody = identity;

  const staleCatalog = catalogRequest();
  const staleReady = await exchange.resolve(peerToken, sandboxId, staleCatalog, signal);
  assert.equal(staleReady.kind, "ready");
  if (staleReady.kind !== "ready") {
    return;
  }
  const beforeSubstitution = f.secretReads;
  const beforeCatalogDenials = arrivals;
  substitutedCatalogModel = "other-model";
  assert.equal(
    (
      await exchange.authorizeSend(
        peerToken,
        sandboxId,
        staleCatalog.id,
        staleReady.handle,
        staleReady.evidence,
        staleReady.injectionDigest,
        staleCatalog.deadlineAt,
        signal,
      )
    ).kind,
    "refused",
  );
  assert.equal(
    (await exchange.resolve(peerToken, sandboxId, catalogRequest(), signal)).kind,
    "refused",
  );
  assert.equal(f.secretReads, beforeSubstitution);
  assert.equal(arrivals, beforeCatalogDenials);
  substitutedCatalogModel = undefined;
  // Complete origin replies cannot substitute workspace identity or reflect usable material.
  for (const unsafe of [
    { body: { ...identity, chatgpt_account_id: "another-workspace" }, status: 200 },
    { body: { ...identity, reflected: "synthetic-key-initial" }, status: 200 },
    { body: { ...identity, backend_url: "https://another.example" }, status: 200 },
    { body: identity, status: 302 },
  ]) {
    originBody = unsafe.body;
    originStatus = unsafe.status;
    const captured = request();
    const ready = await exchange.resolve(peerToken, sandboxId, captured, signal);
    assert.ok(ready.kind === "ready", JSON.stringify(ready));
    assert.equal((await authorize(captured, ready)).kind, "allow");
    const received = await receive(ready.headers);
    assert.equal(await exchange.beginResponse(peerToken, sandboxId, captured.id), ready.handle);
    assert.equal(await exchange.protectResponse(ready.handle, received, signal), undefined);
  }
  originBody = identity;
  originStatus = 200;
  const beforeWithdrawal = arrivals;
  // A source authority withdrawal between lookup and release cannot use the earlier grant.
  const mappingHeld = request();
  const mappingReady = await exchange.resolve(peerToken, sandboxId, mappingHeld, signal);
  assert.ok(mappingReady.kind === "ready", JSON.stringify(mappingReady));
  admittedSource = undefined;
  assert.equal((await authorize(mappingHeld, mappingReady)).kind, "refused");
  admittedSource = source;
  const held = policyRequest();
  const ready = await exchange.resolve(peerToken, sandboxId, held, signal);
  assert.ok(ready.kind === "ready", JSON.stringify(ready));
  const withdrawn = await f.request(
    "DELETE",
    `/namespaces/${f.namespace.id}/iam/access-bindings/${access.id}`,
  );
  assert.equal(withdrawn.status, 204);
  assert.equal((await authorize(held, ready)).kind, "refused");
  assert.equal((await exchange.resolve(peerToken, sandboxId, request(), signal)).kind, "refused");
  assert.equal(
    (await exchange.resolve(peerToken, sandboxId, catalogRequest(), signal)).kind,
    "refused",
  );
  assert.equal(
    (await exchange.resolve(peerToken, sandboxId, policyRequest(), signal)).kind,
    "refused",
  );
  // This controlled caller made no further request after authority refused it.
  // Native sender enforcement is outside this fixture's evidence.
  assert.equal(arrivals, beforeWithdrawal);
  const denials = await f.controller.transact((unit: PlatformUnitOfWork) => unit.audit.list());
  assert.ok(
    denials.some(
      (event: AuditEvent) =>
        event.kind === "authorization_denial" && event.actorId === agent.servicePrincipalId,
    ),
  );
  // Removing the owner's mapping must refuse a new operation even while the Secret exists.
  admittedSource = undefined;
  assert.throws(() => provider.normalizeGrant(["fixture-model"], {}, source), /exact-source/);
  const secret = await f.request("GET", `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`);
  assert.equal(secret.status, 200);
}

if (databaseUrl) {
  test("registered workspace PAT exchange persists exact Harness ownership in PostgreSQL", (t) =>
    workspaceJourney(t, "postgres"));
}
test("registered workspace PAT exchange enforces source ownership, response custody and withdrawal", (t) =>
  workspaceJourney(t, "memory"));
test(
  "workspace PAT classifies two-turn message metadata without widening Platform policy",
  classifyTwoTurns,
);

// Abstracted synthetic wire shapes, not captured native-client runtime evidence.
async function classifyTwoTurns(t: TestContext) {
  const provider = createCodexWorkspacePatProvider({ workspaceForSource: () => undefined });
  const ref = { id: "synthetic", generation: 1 };
  const route: import("../../packages/contracts/src/index.ts").EgressRoute = {
    route: ref,
    binding: {
      binding: ref,
      execution: {
        installationId: "i",
        namespaceId: "n",
        agentId: "a",
        servicePrincipalId: "s",
        revisionId: "r",
        executionId: "e",
      },
      source: {
        installationId: "i",
        namespaceId: "n",
        source: ref,
        backend: ref,
        provider: provider.ref,
      },
      grant: {
        kind: "workspace_inference",
        workspaceId: "synthetic-workspace",
        models: ["fixture-model"],
        providerTools: "none",
      },
      grantHash: "synthetic",
      isolationId: "synthetic",
    },
    origin: "https://chatgpt.com",
    path: "/backend-api/codex/responses",
    method: "POST",
    operationPolicy: ref,
    responsePolicy: ref,
    deadlineMs: 30_000,
  };
  await t.test("native bootstrap preserves required metadata and binds account routing", () => {
    const workspace = "synthetic-workspace";
    const token = `local-${randomUUID()}`;
    const identity = {
      chatgpt_account_id: workspace,
      chatgpt_account_is_fedramp: false,
      chatgpt_user_id: "synthetic-user",
      chatgpt_plan_type: "team",
      email: "synthetic@example.invalid",
    };
    const account = {
      id: workspace,
      name: "Synthetic workspace",
      plan_type: "team",
      structure: "workspace",
      workspace_backend_origin: "https://chatgpt.com",
      account_routing_override: "NO_CONSTRAINT",
    };
    const accounts = {
      accounts: [account],
      account_ordering: [workspace],
      default_account_id: workspace,
    };
    const protect = (
      action: "identity" | "accounts" | "models" | "policy",
      body: unknown,
      status = 200,
      headers: [string, string][] = [["content-type", "application/json"]],
    ) => {
      const origin = action === "identity" ? "https://auth.openai.com" : route.origin;
      const path =
        action === "identity"
          ? "/api/accounts/v1/user-auth-credential/whoami"
          : action === "accounts"
            ? "/backend-api/wham/accounts/check"
            : action === "policy"
              ? "/backend-api/wham/config/bundle"
              : "/backend-api/codex/models";
      const request = {
        id: "synthetic-bootstrap",
        method: "GET",
        url: origin + path + (action === "models" ? "?client_version=0.163.0" : ""),
        headers: [["chatgpt-account-id", workspace]] as [string, string][],
        body: Buffer.alloc(0),
        deadlineAt: "2026-10-23T23:59:59.000Z",
      };
      const operation = provider.classify({ ...route, origin, path, method: "GET" }, request);
      assert.ok(operation);
      return provider.protectResponse(
        {
          status,
          headers,
          body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
          trailers: [],
        },
        token,
        request,
        operation,
      );
    };
    for (const [action, body] of [
      ["identity", identity],
      ["accounts", accounts],
    ] as const) {
      const response = protect(action, body);
      assert.ok(response);
      assert.deepEqual(JSON.parse(Buffer.from(response.body).toString()), body);
      assert.equal(protect(action, body, 302), undefined);
      assert.equal(
        protect(action, body, 200, [
          ["content-type", "application/json"],
          ["location", "https://chatgpt.com"],
        ]),
        undefined,
      );
      assert.equal(
        protect(action, body, 200, [
          ["content-type", "application/json"],
          ["upgrade", "websocket"],
        ]),
        undefined,
      );
      assert.equal(protect(action, { ...body, unknown: true }), undefined);
    }
    for (const body of [
      { ...identity, chatgpt_user_id: undefined },
      { ...identity, chatgpt_plan_type: undefined },
      { ...identity, chatgpt_plan_type: ["team"] },
      { ...identity, chatgpt_account_id: "another-workspace" },
      { ...identity, chatgpt_account_is_fedramp: true },
      { ...identity, chatgpt_user_id: token },
      { ...identity, email: token + "@example.invalid" },
    ]) {
      assert.equal(protect("identity", body), undefined);
    }
    for (const changed of [
      { ...account, id: "another-workspace" },
      { ...account, workspace_backend_origin: "https://another.example" },
      { ...account, account_routing_override: "us" },
      { ...account, name: token },
      { ...account, upgrade: "another-model" },
      { ...account, plan_type: ["team"] },
    ]) {
      assert.equal(protect("accounts", { ...accounts, accounts: [changed] }), undefined);
    }
    assert.equal(protect("accounts", { ...accounts, accounts: [account, account] }), undefined);
    assert.equal(
      protect("accounts", { ...accounts, default_account_id: "another-workspace" }),
      undefined,
    );
    assert.equal(
      protect("accounts", { ...accounts, account_ordering: ["another-workspace"] }),
      undefined,
    );
    const emptyPolicy = {
      config_toml: { enterprise_managed: [] },
      requirements_toml: { enterprise_managed: [] },
    };
    const fragments = [
      { id: "first", name: "Policy", contents: 'allowed_sandbox_modes = ["read-only"]' },
      { id: "second", name: "Policy", contents: "# https://example.invalid/policy" },
    ];
    const policy = { ...emptyPolicy, requirements_toml: { enterprise_managed: fragments } };
    for (const body of [emptyPolicy, policy]) {
      const response = protect("policy", body);
      assert.ok(response);
      assert.deepEqual(JSON.parse(Buffer.from(response.body).toString()), body);
      assert.equal(protect("policy", body, 403), undefined);
    }
    assert.equal(
      protect(
        "policy",
        '{"config_toml":{"enterprise_managed":[]},"requirements_toml":{"enterprise_managed":[],"enterprise_managed":[]}}',
      ),
      undefined,
    );
    assert.equal(protect("policy", policy, 302), undefined);
    assert.equal(
      protect("policy", policy, 200, [
        ["content-type", "application/json"],
        ["content-encoding", "gzip"],
      ]),
      undefined,
    );
    const escaped = (value: string) =>
      value.slice(0, 3) +
      "\\u" +
      value.charCodeAt(3).toString(16).padStart(4, "0") +
      value.slice(4);
    const tomlForms = [
      (value: string) => `value = "${escaped(value)}"`,
      (value: string) =>
        `value = "${value.slice(0, 3)}\\U${value.charCodeAt(3).toString(16).padStart(8, "0")}${value.slice(4)}"`,
      (value: string) => 'value = """' + value.slice(0, 3) + "\\\r\n  \t" + value.slice(3) + '"""',
      (value: string) => `value = """${value.slice(0, 3)}\\
${value.slice(3)}"""`,
      (value: string) => `"${escaped(value)}" = "safe"`,
      (value: string) => `values = [{ nested = ["${escaped(value)}"] }]`,
      (value: string) => `["__proto__"]
constructor = "${escaped(value)}"`,
    ];
    const policyWith = (key: string, contents: string) => ({
      ...emptyPolicy,
      [key]: { enterprise_managed: [{ id: "local", name: "Local", contents }] },
    });
    for (const key of ["config_toml", "requirements_toml"]) {
      for (const form of tomlForms) {
        for (const secret of [
          token,
          encodeURIComponent(token),
          Buffer.from(token).toString("base64"),
          Buffer.from(token).toString("base64url"),
        ]) {
          assert.equal(protect("policy", policyWith(key, form(secret))), undefined);
        }
        const original =
          " \n" + JSON.stringify(policyWith(key, form("harmless-local-value")), null, 2) + "\n";
        const clean = protect("policy", original);
        assert.ok(clean);
        assert.equal(
          Buffer.from(clean.body).toString(),
          original,
          "retain original JSON and TOML bytes",
        );
      }
      for (const invalid of [
        "a = 1\na = 2",
        "a = 1\n[a]\nb = 2",
        'value = "\\uZZZZ"',
        "a = " + "[".repeat(40) + "0" + "]".repeat(40),
        "a = [" + Array(4097).fill("0").join(",") + "]",
        "[" + Array(40).fill("a").join(".") + "]\nb = 1",
      ])
        assert.equal(protect("policy", policyWith(key, invalid)), undefined);
      const scalars = policyWith(
        key,
        'date = 1979-05-27T07:32:00Z\ntime = 07:32:00\ninteger = 9223372036854775807\nfloat = inf\n"__proto__" = "safe"\n"constructor" = "safe"',
      );
      assert.ok(protect("policy", scalars));
    }
    const wideContents = "values = [" + Array(2100).fill("0").join(",") + "]";
    const wideConfig = policyWith("config_toml", wideContents);
    const wideRequirements = policyWith("requirements_toml", wideContents);
    assert.ok(protect("policy", wideConfig));
    assert.ok(protect("policy", wideRequirements));
    assert.equal(
      protect("policy", { ...wideConfig, requirements_toml: wideRequirements.requirements_toml }),
      undefined,
    );
    for (const key of ["config_toml", "requirements_toml"]) {
      for (const layer of [
        undefined,
        null,
        {},
        { enterprise_managed: null },
        { enterprise_managed: {} },
        { enterprise_managed: [{ id: "a", name: "missing content" }] },
        { enterprise_managed: [fragments[0], fragments[0]] },
        { enterprise_managed: [{ id: "a", name: "policy", contents: token }] },
        { enterprise_managed: [{ id: "a", name: "policy", contents: "x".repeat(65536) }] },
        { enterprise_managed: fragments, unknown: true },
      ])
        assert.equal(protect("policy", { ...policy, [key]: layer }), undefined);
    }
    const catalog = protect("models", { models: [nativeModel("other-model"), nativeModel()] });
    assert.ok(catalog);
    assert.deepEqual(JSON.parse(Buffer.from(catalog.body).toString()), { models: [nativeModel()] });
    assert.equal(protect("models", { models: [nativeModel("other-model")] }), undefined);
    assert.equal(protect("models", { models: [nativeModel(), nativeModel()] }), undefined);
    assert.equal(protect("models", { models: [nativeModel()], workspace_id: "other" }), undefined);
    assert.equal(
      protect("models", { models: [nativeModel()] }, 200, [
        ["content-type", "application/json"],
        ["chatgpt-account-id", "other"],
      ]),
      undefined,
    );
    for (const change of [
      { upgrade: { model: "other-model" } },
      { experimental_supported_tools: ["web_search"] },
      { base_instructions: "Use an alternate endpoint" },
      { context_window: -1 },
      { display_name: "https://another.example" },
      { description: "See https://another.example" },
      { description: "file:///synthetic" },
      { description: token },
      { description: Buffer.from(token).toString("base64") },
      { unknown: true },
      { supported_reasoning_levels: [{ effort: "medium", description: "Medium", extra: true }] },
      { truncation_policy: { mode: "tokens", limit: 10000, extra: true } },
    ]) {
      assert.equal(protect("models", { models: [{ ...nativeModel(), ...change }] }), undefined);
    }
  });
  const stamp = { turn_id: "01234567-89ab-7000-8000-0123456789ab", create_time: 1792782919.916 };
  const message = (role: string, kind: string, metadata = {}, type = "input_text") => ({
    type: "message",
    id: "synthetic-message",
    role,
    content: [{ type, text: "Synthetic" }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: [kind], ...metadata },
  });
  const developer = message("developer", "model.base_instructions");
  const managedDeveloper = message("developer", "generic.developer_instructions");
  const user = message("user", "user.text", stamp);
  const assistant = message("assistant", "unknown", { turn_id: stamp.turn_id }, "output_text");
  const request = (input: unknown) => ({
    id: stamp.turn_id,
    deadlineAt: "2026-10-23T23:59:59.000Z",
    method: "POST",
    url: route.origin + route.path,
    headers: [
      ["content-type", "application/json"],
      ["host", "chatgpt.com"],
      ["chatgpt-account-id", "synthetic-workspace"],
    ] as [string, string][],
    body: Buffer.from(JSON.stringify({ model: "fixture-model", store: false, input })),
  });
  const expected = {
    kind: "inference",
    action: "generate",
    model: "fixture-model",
    workspaceId: "synthetic-workspace",
  };
  const platformRoute = {
    ...route,
    binding: { ...route.binding, grant: openAiStaticProvider.normalizeGrant(["fixture-model"]) },
  };
  for (const input of [
    [developer, user],
    [developer, user, assistant, user],
  ]) {
    await t.test(input.length === 2 ? "first turn" : "second turn", () => {
      assert.deepEqual(provider.classify(route, request(input)), expected);
      assert.equal(openAiStaticProvider.classify(platformRoute, request(input)), undefined);
    });
  }
  assert.equal(
    openAiStaticProvider.classify(platformRoute, request("Synthetic"))?.kind,
    "inference",
  );
  assert.deepEqual(provider.classify(route, request("Synthetic")), expected);
  // The native annotation describes text already allowed by the same model grant.
  const plainDeveloper = { role: "developer", content: managedDeveloper.content };
  assert.deepEqual(provider.classify(route, request([plainDeveloper, user])), expected);
  assert.deepEqual(provider.classify(route, request([managedDeveloper, user])), expected);
  assert.equal(
    openAiStaticProvider.classify(platformRoute, request([managedDeveloper, user])),
    undefined,
  );
  const nativeMetadata = {
    mcp_attribution: JSON.stringify({ status: "none" }),
    "x-codex-turn-metadata": JSON.stringify({ reasoning_effort: "medium" }),
  };
  const metadataRequest = (metadata: unknown) => ({
    ...request("Synthetic"),
    body: Buffer.from(
      JSON.stringify({
        model: "fixture-model",
        store: false,
        input: "Synthetic",
        client_metadata: metadata,
      }),
    ),
  });
  assert.deepEqual(provider.classify(route, metadataRequest(nativeMetadata)), expected);
  assert.equal(
    openAiStaticProvider.classify(platformRoute, metadataRequest(nativeMetadata)),
    undefined,
  );
  for (const mcp of [
    "not json",
    '{"status":"none","status":"none"}',
    JSON.stringify({ status: "complete" }),
    JSON.stringify({ status: "none", sources: [] }),
    JSON.stringify({ status: "none", origin: "https://another.example" }),
  ]) {
    assert.equal(
      provider.classify(route, metadataRequest({ ...nativeMetadata, mcp_attribution: mcp })),
      undefined,
    );
  }
  assert.equal(
    provider.classify(
      route,
      metadataRequest({
        ...nativeMetadata,
        "x-codex-turn-metadata": JSON.stringify({ reasoning_effort: "arbitrary" }),
      }),
    ),
    undefined,
  );
  const localTools = {
    ...request("Synthetic"),
    body: Buffer.from(
      JSON.stringify({
        model: "fixture-model",
        store: false,
        input: "Synthetic",
        tools: [
          { type: "function", name: "local", parameters: { type: "object", properties: {} } },
        ],
      }),
    ),
  };
  assert.deepEqual(provider.classify(route, localTools), expected);
  assert.equal(openAiStaticProvider.classify(platformRoute, localTools)?.kind, "inference");

  for (const invalid of [
    message("system", "model.base_instructions"),
    message("system", "generic.developer_instructions"),
    message("user", "generic.developer_instructions"),
    message(
      "assistant",
      "generic.developer_instructions",
      { turn_id: stamp.turn_id },
      "output_text",
    ),
    message("developer", "generic.developer_instructions", {}, "output_text"),
    message("developer", "generic.developer_instructions", { authority: "workspace" }),
    message("developer", "managed_config.developer_instructions"),
    { ...managedDeveloper, id: undefined },
    { ...managedDeveloper, content: [...managedDeveloper.content, ...managedDeveloper.content] },
    message("developer", "user.text"),
    message("user", "unknown"),
    message("assistant", "user.text", { turn_id: stamp.turn_id }, "output_text"),
    message("assistant", "unknown", { turn_id: stamp.turn_id }),
    message("assistant", "unknown", {}, "output_text"),
    message("assistant", "unknown", stamp, "output_text"),
    message(
      "assistant",
      "unknown",
      { turn_id: "01234567-89ab-4000-8000-0123456789ab" },
      "output_text",
    ),
    message("user", "user.text", { turn_id: stamp.turn_id }),
    message("user", "user.text", { ...stamp, create_time: -1 }),
    message("user", "user.text", { executed_tool_calls: [] }),
    message(
      "assistant",
      "unknown",
      { turn_id: stamp.turn_id, executed_tool_calls: [] },
      "output_text",
    ),
    { ...user, content: [...user.content, ...user.content] },
    { ...user, extra: true },
    { ...user, id: undefined },
    { ...user, content: [] },
    {
      ...user,
      content: Array(17).fill(user.content[0]),
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: Array(17).fill("user.text"),
      },
    },
    {
      type: "function_call",
      call_id: "call",
      name: "tool",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: {},
    },
  ]) {
    assert.equal(provider.classify(route, request([developer, invalid, user])), undefined);
  }
  for (const developerMessage of [developer, managedDeveloper]) {
    const valid = request([developerMessage, user, assistant, user]);
    for (const invalid of [
      { ...valid, url: "https://auth.openai.com" + route.path },
      { ...valid, url: valid.url + "?extra=1" },
      { ...valid, method: "GET" },
      ...["host", "chatgpt-account-id"].map((name) => ({
        ...valid,
        headers: valid.headers.map(([key, value]): [string, string] => [
          key,
          key === name ? "wrong" : value,
        ]),
      })),
      ...[
        ["transfer-encoding", "chunked"],
        ["content-encoding", "gzip"],
        ["x-openai-account-routing-override", "us"],
        ["content-length", "1"],
        ["content-type", "application/json"],
      ].map(([name, value]) => ({
        ...valid,
        headers: [...valid.headers, [name!, value!] as [string, string]],
      })),
      {
        ...valid,
        body: Buffer.from(JSON.stringify({ model: "other", store: false, input: [user] })),
      },
      {
        ...valid,
        body: Buffer.from(
          JSON.stringify({
            model: "fixture-model",
            store: false,
            input: [user],
            tools: [{ type: "web_search" }],
          }),
        ),
      },
      {
        ...valid,
        body: Buffer.from(
          '{"model":"fixture-model","model":"fixture-model","store":false,"input":[]}',
        ),
      },
    ]) {
      assert.equal(provider.classify(route, invalid), undefined);
    }
    for (const path of [
      "/backend-api/wham/settings/user",
      "/backend-api/codex/responses",
      "/v1/models",
    ]) {
      assert.equal(
        provider.classify(
          { ...route, path, method: "GET" },
          { ...valid, method: "GET", url: route.origin + path, body: Buffer.alloc(0) },
        ),
        undefined,
      );
    }
  }
}
