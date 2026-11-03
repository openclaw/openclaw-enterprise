import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProxyDriver,
  AcceptedEgressAssociation,
  AgentRevision,
  EgressRequest,
  CredentialPolicyReducer,
  CredentialPolicyReduction,
  EgressInstallation,
  EgressRoute,
  Agent,
  Namespace,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  type OpenClawController,
  PostgresPlatformState,
  PostgresWorkQueue,
  reduceCredentialPolicy,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { requestId, staticEgressFixture } from "../helpers/static-egress.mjs";
import { listen } from "../helpers/listen.mjs";
import { CREDENTIAL_PROXY_ONE_SOURCE } from "../helpers/refusal-text.mjs";

test(
  "policy reduction preserves another binding then observes deny-all (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    let state!: PlatformStateStore;
    let pool!: Awaited<ReturnType<typeof postgresApp>>["pool"];
    let api!: Awaited<ReturnType<typeof postgresApp>>["request"];
    let restart!: () => void;
    let sourceB = "";
    let owner!: InstalledDriver;
    let compute!: ReturnType<typeof createTestKubernetesComputeDriver>;
    let reductionVersion: 1 | 2 = 1;
    const fixtureOptions = {
      admitRevision: false,
      driverConfigurations: [
        {
          capability: "sandbox" as const,
          driverId: "policy-reduction-fixture",
          implementation: "policy-reduction-fixture",
          definition: OpenShellSandboxDriver,
        },
      ],
      appFactory: async (context: TestContext, options: object = {}) => {
        // Record deployment work, so a candidate can fail through the real queue.
        const app = await postgresApp(context, { ...options, recordOperations: true });
        api = app.request;
        state = app.state;
        pool = app.pool;
        restart = () => {
          state = new PostgresPlatformState(app.pool);
        };
        return app as unknown as Awaited<ReturnType<typeof createConsoleAppFixture>>;
      },
      async admitSource({
        app,
        agent,
        namespace,
        secret,
        path,
        origin,
        computeAuthentication,
      }: {
        app: Awaited<ReturnType<typeof postgresApp>>;
        agent: Agent;
        namespace: Namespace;
        secret: { ref: SecretReference };
        path: string;
        origin: string;
        computeAuthentication: { mode: "kubeconfig"; kubeconfigPath: string; context: string };
      }) {
        const original = app.controller.selectedDriver("credential_proxy");
        assert.equal(
          original.policyReduction,
          undefined,
          "stock OpenShell is not qualified for policy reduction",
        );
        const sandbox = new Proxy(app.controller.selectedDriver("sandbox"), {
          get(target, key) {
            if (key === "id" || key === "implementation") {
              return "policy-reduction-fixture";
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const proxy: CredentialProxyDriver = {
          id: "policy-reduction-fixture",
          implementation: "policy-reduction-fixture",
          capability: "credential_proxy",
          sourceControl: original.sourceControl,
          get policyReduction(): CredentialPolicyReducer {
            return {
              version: reductionVersion,
              assertAvailable: async () => {},
              apply: (...args) => reducer.apply(...args),
              observe: (...args) => reducer.observe(...args),
            };
          },
          async configureRevision(context) {
            return { plan: context.plan, configuration: {} };
          },
          async wiringStatus() {
            return snapshot();
          },
          async verifyInstallation(_context, installation) {
            return isDeepStrictEqual(installation, snapshot());
          },
          async removeRevision() {
            return false;
          },
        };
        owner = new InstalledDriver(
          { id: proxy.id, implementation: proxy.implementation, configuration: {} },
          { capabilities: { sandbox, credential_proxy: proxy } },
        );
        app.controller.installDriver(owner, ["sandbox", "credential_proxy"]);
        compute = createTestKubernetesComputeDriver("policy-reduction-compute", {
          authentication: computeAuthentication,
          credentialGatewayDriver: app.controller.selectedDriver("credential_gateway"),
          protectedDriver: owner,
          channelRuntime: true,
        });
        app.controller.registerDriver(compute);
        app.controller.selectDriver("compute", compute.id);
        const createSource = async (name: string, baseUrl: string) => {
          const result = await app.request("POST", path, {
            body: {
              name,
              type: "openai",
              config: { base_url: `${baseUrl}/v1` },
              secrets: { api_key: secret.ref },
            },
          });
          assert.equal(result.status, 201, JSON.stringify(result.body));
          return result.data;
        };
        const source = await createSource("first-reduced-source", origin);
        sourceB = (
          await createSource(
            "second-inference",
            origin.replace("provider.example.test", "second.example.test"),
          )
        ).id;
        const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
          body: {
            configurationId: agent.configurationId,
            harnessAuth: { method: "credential_source", sourceId: sourceB },
            credentialSources: [{ sourceId: source.id }, { sourceId: sourceB }],
          },
        });
        assert.equal(bound.status, 200);
        return { agent: bound.data, source };
      },
    };
    const baseFixture = await staticEgressFixture(t, fixtureOptions);
    assert.ok("grant" in baseFixture);
    const secondGrant = await api(
      "POST",
      `/namespaces/${baseFixture.namespace.id}/iam/access-bindings`,
      {
        body: {
          subjectKind: "identity",
          subjectId: baseFixture.agent.servicePrincipalId,
          roleId: baseFixture.grant.roleId,
          resourceKind: "credential_source",
          resourceId: sourceB,
        },
      },
    );
    assert.equal(secondGrant.status, 201);
    // Advertising Git reduction alone must not become static v1 or break ordinary v3.
    reductionVersion = 2;
    const agentPath = `/namespaces/${baseFixture.namespace.id}/agents/${baseFixture.agent.id}`;
    const unsupported = await api("POST", `${agentPath}/deploy`);
    // The deployer may read both sources, so the Installation limit is named (finding 2536).
    assertApiError(unsupported, 409, "RESOURCE_CONFLICT");
    assert.equal(unsupported.body.error.message, CREDENTIAL_PROXY_ONE_SOURCE);
    assert.equal(
      (
        await api("PATCH", agentPath, {
          body: {
            configurationId: baseFixture.agent.configurationId,
            harnessAuth: { method: "credential_source", sourceId: sourceB },
            credentialSources: [{ sourceId: sourceB }],
          },
        })
      ).status,
      200,
    );
    const ordinary = await baseFixture.deployAgent(baseFixture.namespace.id, baseFixture.agent.id);
    const ordinaryRevision = await state.read((view) =>
      view.revisions.findRevision(baseFixture.namespace.id, baseFixture.agent.id, ordinary.id),
    );
    assert.deepEqual(ordinaryRevision?.executionAdmission, { version: 3, mode: "protected" });
    assert.equal(ordinaryRevision?.egressPlan?.policyReductionVersion, undefined);
    reductionVersion = 1;
    assert.equal(
      (
        await api("PATCH", agentPath, {
          body: {
            configurationId: baseFixture.agent.configurationId,
            harnessAuth: { method: "credential_source", sourceId: sourceB },
            credentialSources: [{ sourceId: baseFixture.source.id }, { sourceId: sourceB }],
          },
        })
      ).status,
      200,
    );
    const deployed = await baseFixture.deployAgent(baseFixture.namespace.id, baseFixture.agent.id);
    const revision = await state.read((view) =>
      view.revisions.findRevision(baseFixture.namespace.id, baseFixture.agent.id, deployed.id),
    );
    assert.ok(revision?.egressPlan);
    await baseFixture.activateRevision(baseFixture.namespace.id, baseFixture.agent.id, revision.id);
    const f = { ...baseFixture, revision };
    // Two later candidates admitted with both sources: one whose deployment failed for good,
    // then one still deploying. Neither is the Agent's active revision.
    const failedCandidate = await baseFixture.deployAgent(f.namespace.id, f.agent.id);
    const queue = new PostgresWorkQueue(pool);
    // Retried work becomes due after the candidate's, and exhausted work stops being claimable,
    // so this loop ends.
    for (;;) {
      const claim = await queue.claim();
      assert.ok(claim, "the failed candidate's deployment is claimable");
      if (claim.idempotencyKey === `agent_revision:${failedCandidate.id}:reconcile`) {
        await queue.fail(claim, { code: "CONVERGENCE_DEADLINE_EXCEEDED" });
        break;
      }
      // Other work is only retried.
      await queue.retry(claim, { code: "DEPENDENCY_UNAVAILABLE" });
    }
    const deployingCandidate = await baseFixture.deployAgent(f.namespace.id, f.agent.id);
    const candidates: Readonly<AgentRevision>[] = [];
    for (const { id } of [failedCandidate, deployingCandidate]) {
      const candidate = await state.read((view) =>
        view.revisions.findRevision(f.namespace.id, f.agent.id, id),
      );
      assert.ok(candidate);
      candidates.push(candidate);
    }
    const initial: EgressInstallation = {
      plan: revision.egressPlan,
      sandboxId: randomUUID(),
      sender: owner.require("credential_proxy").sourceControl.sender,
      installedAt: new Date().toISOString(),
      enforcement: {
        instanceId: randomUUID(),
        configurationId: "reference-policy",
        policyHash: "a".repeat(64),
        authorityScope: "execution",
        peerKeyId: "reference-peer",
      },
    };
    let routes: readonly EgressRoute[] = initial.plan.routes;
    let generation = initial.plan.generation;
    let operationId = "";
    let applies = 0;
    let observationFault:
      | "none"
      | "recipient"
      | "missing-recipient"
      | "operation"
      | "hash"
      | "configuration"
      | "policy" = "none";
    const controlAuthorization = `Bearer ${randomUUID()}`;
    let observationAuthorization = controlAuthorization;
    let loseResponse = true;
    let deferApply = false;
    let applyAccepted: (() => void) | undefined;
    const snapshot = (): EgressInstallation => ({
      ...initial,
      plan: { ...initial.plan, routes, generation },
      enforcement: {
        ...initial.enforcement,
        policyHash:
          generation === initial.plan.generation
            ? initial.enforcement.policyHash
            : createHash("sha256").update(JSON.stringify(routes)).digest("hex"),
      },
    });
    // This loopback peer actually enforces its live route set. Control requests compare
    // the entire previous installation; observations read live state, not the request body.
    // It models the new protocol only, not a released OpenShell or OS Sandbox boundary.
    const server = createServer(async (req, res) => {
      if (
        (req.url === "/reduce" || req.url === "/observe") &&
        req.headers.authorization !== controlAuthorization
      ) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "POST" && req.url === "/reduce") {
        applies++;
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        const request = JSON.parse(body) as CredentialPolicyReduction;
        if (
          !isDeepStrictEqual(request.expected, snapshot()) ||
          request.retained.generation !== generation + 1 ||
          !request.retained.routes.every((route) =>
            routes.some((old) => isDeepStrictEqual(old, route)),
          )
        ) {
          res.writeHead(409).end();
          return;
        }
        const apply = () => {
          routes = routes.filter((route) =>
            request.retained.routes.some((retained) => isDeepStrictEqual(route, retained)),
          );
          generation++;
          operationId = request.operationId;
        };
        if (deferApply) {
          applyAccepted = apply;
        } else {
          apply();
        }
        if (loseResponse) {
          req.socket.destroy();
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (req.url === "/observe") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            operationId: observationFault === "operation" ? randomUUID() : operationId,
            installation: {
              ...snapshot(),
              ...(observationFault === "recipient" ? { sandboxId: "replacement" } : {}),
              ...(observationFault === "missing-recipient" ? { sandboxId: undefined } : {}),
              ...(observationFault === "policy" ? { plan: initial.plan } : {}),
              enforcement: {
                ...snapshot().enforcement,
                ...(observationFault === "hash"
                  ? { policyHash: initial.enforcement.policyHash }
                  : {}),
                ...(observationFault === "configuration" ? { configurationId: "" } : {}),
              },
            },
          }),
        );
        return;
      }
      if (
        routes.some(
          (route) =>
            req.method === route.method &&
            req.url === route.path &&
            req.headers.host === new URL(route.origin).host,
        )
      ) {
        res.writeHead(200).end("allowed");
      } else {
        res.writeHead(403).end("denied");
      }
    });
    const base = `http://127.0.0.1:${await listen(t, server)}`;
    let beforeApply = async () => {};
    let afterObserve = async () => {};
    const reducer: CredentialPolicyReducer = {
      version: 1,
      async apply(_context, request) {
        await beforeApply();
        const result = await fetch(`${base}/reduce`, {
          method: "POST",
          headers: { authorization: controlAuthorization },
          body: JSON.stringify(request),
        });
        assert.equal(result.status, 204);
      },
      async observe() {
        const observation = await (
          await fetch(`${base}/observe`, { headers: { authorization: observationAuthorization } })
        ).json();
        await afterObserve();
        return observation;
      },
    };
    await state.transact((unit) => unit.credentialSources.recordEgressInstallation(snapshot()));
    const signal = AbortSignal.timeout(50_000);
    const reduce = async (sourceId: string, coordinated = true, target = revision) => {
      const source = await state.read((view) =>
        view.credentialSources.findCredentialSource(f.namespace.id, sourceId),
      );
      assert.ok(source);
      const result = await compute.withdrawCredentialSource(
        target,
        source,
        signal,
        coordinated
          ? { reducePolicy: (selected) => reduceCredentialPolicy(state, owner, selected, sourceId) }
          : {},
      );
      return result.state;
    };
    let refusal: unknown;
    const platformAllows = async (source: string) => {
      const route = initial.plan.routes.find((item) => item.binding.source.source.id === source)!;
      let association: AcceptedEgressAssociation | undefined;
      const peer = {
        sender: initial.sender,
        sandboxId: initial.sandboxId,
        instanceId: initial.enforcement.instanceId,
        peerKeyId: initial.enforcement.peerKeyId!,
        exchangeId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const exchange = (f.controller as OpenClawController).createCredentialProxy({
        async verify() {
          return peer;
        },
        capture(use) {
          association = {
            execution: use.installation.plan.execution,
            installation: {
              sandboxId: use.installation.sandboxId,
              ...use.installation.enforcement,
              plan: {
                id: use.installation.plan.id,
                generation: use.installation.plan.generation,
              },
            },
            exchangeId: peer.exchangeId,
            custodyId: randomUUID(),
            responseId: randomUUID(),
          };
          return association;
        },
        owns(value) {
          return isDeepStrictEqual(value, association);
        },
      });
      const input: EgressRequest = {
        id: requestId(),
        method: route.method,
        url: route.origin + route.path,
        headers: [["content-type", "application/json"]],
        body: Buffer.from(JSON.stringify({ model: "fixture-model", input: "hello", store: false })),
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        verifiedExecutionPolicyHash: snapshot().enforcement.policyHash,
      };
      const selected = await exchange.resolve("reference-peer", peer.sandboxId, input, signal);
      if (selected.kind !== "ready") {
        refusal = selected;
        return false;
      }
      const decision = await exchange.authorizeSend(
        "reference-peer",
        peer.sandboxId,
        input.id,
        selected.handle,
        selected.evidence,
        selected.injectionDigest,
        input.deadlineAt,
        signal,
      );
      if (decision.kind !== "allow") {
        refusal = decision;
      }
      return decision.kind === "allow";
    };
    const request = async (source: string, expected: number) => {
      const route = initial.plan.routes.find((item) => item.binding.source.source.id === source);
      assert.ok(route);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = httpRequest(
          `${base}${route.path}`,
          {
            method: route.method,
            headers: { host: new URL(route.origin).host },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        outgoing.once("error", reject);
        outgoing.end();
      });
      assert.equal(status, expected);
    };
    const withdraw = async (source: string) => {
      const response = await f.request(
        "POST",
        `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${source}/withdraw`,
      );
      assert.equal(response.status, 202, JSON.stringify(response.body));
    };
    assert.equal(await platformAllows(f.source.id), true, JSON.stringify(refusal));
    assert.equal(await platformAllows(sourceB), true, JSON.stringify(refusal));
    await request(f.source.id, 200);
    await request(sourceB, 200);
    for (const candidate of candidates) {
      // Without a recorded withdrawal, a call is never turned into a retirement request.
      await assert.rejects(reduce(f.source.id, true, candidate), /exact admitted owner/);
    }
    await withdraw(f.source.id);
    await assert.rejects(reduce(f.source.id, false), {
      code: "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
    });
    // Withdrawal also records each later candidate's row (finding 2235). Only the active
    // revision's policy can be reduced, so each candidate asks for runtime retirement: a
    // refusal the worker records once and leaves for a replay, not an error that maintenance
    // re-queues forever. Nothing reaches the peer, and each row stays pending, so egress
    // for the source stays refused on that revision.
    for (const candidate of candidates) {
      await assert.rejects(reduce(f.source.id, true, candidate), {
        code: "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
      });
      const withdrawal = await state.read((view) =>
        view.credentialSources.findCredentialWithdrawal(f.namespace.id, candidate.id, f.source.id),
      );
      const reductions = await state.read((view) =>
        view.credentialSources.listCredentialPolicyReductions(f.namespace.id, candidate.id),
      );
      assert.equal(withdrawal?.state, "pending");
      assert.deepEqual(reductions, [], "a refused companion records no reduction operation");
    }
    assert.equal(applies, 0, "a missing coordinator cannot consume the operation");
    beforeApply = async () => {
      const withdrawal = await state.read((view) =>
        view.credentialSources.findCredentialWithdrawal(f.namespace.id, revision.id, f.source.id),
      );
      assert.ok(withdrawal, "OCC commits withdrawal before the peer receives any reduction");
      const reductions = await state.read((view) =>
        view.credentialSources.listCredentialPolicyReductions(f.namespace.id, revision.id),
      );
      assert.equal(reductions.length, 1, "the original operation is durable before apply");
      assert.equal(await platformAllows(f.source.id), false, "OCC denies A before provider action");
      assert.equal(await platformAllows(sourceB), true, "B retains its exact admission");
    };
    await assert.rejects(reduce(f.source.id), /fetch failed/);
    assert.equal(applies, 1);
    await request(f.source.id, 403);
    await request(sourceB, 200);
    restart();
    observationAuthorization = "Bearer invalid";
    await assert.rejects(reduce(f.source.id), /JSON/);
    assert.equal(applies, 1, "rejected observation cannot cause a second mutation");
    observationAuthorization = controlAuthorization;
    beforeApply = async () => {};
    for (const fault of [
      "missing-recipient",
      "operation",
      "hash",
      "configuration",
      "policy",
    ] as const) {
      observationFault = fault;
      assert.equal(await reduce(f.source.id), "pending", `${fault} is not replacement evidence`);
      assert.equal(applies, 1, "recovery never repeats the mutation");
    }
    observationFault = "recipient";
    assert.equal(
      await reduceCredentialPolicy(
        state,
        owner,
        { namespace: f.namespace, revision, plan: initial.plan, signal },
        f.source.id,
      ),
      "retire-runtime",
    );
    const [pending] = await state.read((view) =>
      view.credentialSources.listCredentialPolicyReductions(f.namespace.id, f.revision.id),
    );
    assert.equal(pending?.request.operationId, operationId);
    assert.equal(pending?.observed, undefined, "a wrong-recipient observation is not proof");
    // The deploying candidate becomes active. The superseded revision keeps its recorded,
    // unobserved operation and asks for retirement without observing or repeating it.
    const deployingRevision = candidates[1];
    assert.ok(deployingRevision);
    assert.ok(
      await state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          f.namespace.id,
          f.agent.id,
          revision.id,
          deployingRevision.id,
        ),
      ),
    );
    await assert.rejects(reduce(f.source.id), {
      code: "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
    });
    assert.equal(applies, 1);
    assert.deepEqual(
      await state.read((view) =>
        view.credentialSources.listCredentialPolicyReductions(f.namespace.id, f.revision.id),
      ),
      [pending],
      "retirement leaves the original operation unobserved",
    );
    assert.ok(
      await state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          f.namespace.id,
          f.agent.id,
          deployingRevision.id,
          revision.id,
        ),
      ),
    );
    observationFault = "none";
    afterObserve = async () => {
      assert.ok(
        await state.transact((unit) =>
          unit.agents.compareAndClearActiveRevision(f.namespace.id, f.agent.id, revision.id),
        ),
      );
    };
    assert.equal(
      await reduce(f.source.id),
      "pending",
      "an observation cannot settle after the execution loses active ownership",
    );
    assert.deepEqual(
      await state.read((view) =>
        view.credentialSources.findRevisionEgressInstallation(f.namespace.id, revision.id),
      ),
      initial,
    );
    afterObserve = async () => {};
    await assert.rejects(reduce(f.source.id), /exact admitted owner/);
    assert.ok(
      await state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(f.namespace.id, f.agent.id, undefined, revision.id),
      ),
    );
    assert.equal(await reduce(f.source.id), "revoked");
    assert.equal(applies, 1, "restart and concurrent retries inspect, never replay");
    assert.equal(
      await platformAllows(sourceB),
      true,
      "B passes both OCC checks under the reduced policy",
    );
    await withdraw(sourceB);

    loseResponse = false;
    deferApply = true;
    assert.deepEqual(
      await Promise.all([reduce(f.source.id), reduce(sourceB), reduce(sourceB)]),
      ["revoked", "pending", "pending"],
      "acknowledgment does not prove policy application",
    );
    assert.equal(
      await platformAllows(sourceB),
      false,
      "platform denies B while provider application is pending",
    );
    await request(sourceB, 200);
    assert.ok(applyAccepted);
    applyAccepted();
    restart();
    assert.equal(await reduce(sourceB), "revoked");
    assert.equal(applies, 2);
    assert.equal(await platformAllows(sourceB), false);
    await request(f.source.id, 403);
    await request(sourceB, 403);
    assert.equal(
      await reduce(f.source.id),
      "revoked",
      "recheck observes the latest reduction without restoring A",
    );
    const final = await state.read((view) =>
      view.credentialSources.findRevisionEgressInstallation(f.namespace.id, f.revision.id),
    );
    assert.equal(final?.sandboxId, initial.sandboxId);
    assert.deepEqual(final?.plan.execution, initial.plan.execution);
    assert.deepEqual(final?.plan.routes, [], "last binding leaves an observed deny-all policy");
    assert.equal(
      (await state.read((view) => view.agents.findAgent(f.namespace.id, f.agent.id)))
        ?.activeRevisionId,
      revision.id,
    );
  },
);

// The admission and successor validators must independently reject authority expansion.
// This protects recovery from a forged or stale stored policy, not just the happy-path reducer.
test("Git reduction v7 preserves earlier admission meanings and rejects widening", async () => {
  const { assertExecutionAdmission } = await import("../../packages/contracts/src/index.ts");
  const { isReducedCredentialPlan } = await import("../../packages/occ/src/index.ts");
  const execution = {
    installationId: "ins_" + randomUUID(),
    namespaceId: "ns_" + randomUUID(),
    agentId: "agt_" + randomUUID(),
    servicePrincipalId: "sp_" + randomUUID(),
    revisionId: "rev_" + randomUUID(),
    executionId: randomUUID(),
  };
  const reference = { id: "controlled-driver", generation: 1 };
  const route: EgressRoute = {
    route: { id: "independent", generation: 1 },
    origin: "https://127.0.0.1:8443",
    path: "/repos/example/independent",
    method: "GET",
    deadlineMs: 5000,
    operationPolicy: reference,
    responsePolicy: reference,
    binding: {
      binding: reference,
      execution,
      isolationId: execution.agentId,
      source: {
        installationId: execution.installationId,
        namespaceId: execution.namespaceId,
        source: { id: "cs_" + randomUUID(), generation: 1 },
        backend: reference,
        provider: reference,
      },
      grant: {
        kind: "credential_free_repository_metadata",
        profile: "metadata-read",
        isolationId: execution.agentId,
        repository: "example/independent",
        repositoryId: "99",
      },
      grantHash: "a".repeat(64),
    },
  };
  const plan: import("../../packages/contracts/src/index.ts").ProxyPlan = {
    id: randomUUID(),
    generation: 1,
    execution,
    sandboxDriverId: reference.id,
    egressDriverId: reference.id,
    driver: { id: reference.id, implementation: "controlled", configurationId: "a".repeat(64) },
    policyReductionVersion: 2,
    repositoryGit: {
      driver: { id: "repo", implementation: "github" },
      deadlineWallMs: Date.now() + 60000,
      bindings: [
        {
          backendId: "repo",
          repositoryRef: "installation",
          profile: "github-installation",
          grant: { providerInstanceId: "provider", repositoryId: "installation", grantId: "grant" },
        },
      ],
    },
    routes: [route],
  };
  assert.doesNotThrow(() =>
    assertExecutionAdmission({
      executionAdmission: { version: 7, mode: "protected" },
      egressPlan: plan,
    }),
  );
  for (const version of [3, 4, 5, 6] as const) {
    assert.throws(
      () =>
        assertExecutionAdmission({
          executionAdmission: { version, mode: "protected" },
          egressPlan: plan,
        }),
      /admitted policy reduction capability/,
    );
  }
  const { repositoryGit, policyReductionVersion, ...ordinary } = plan;
  assert.ok(repositoryGit && policyReductionVersion);
  const reduced = { ...ordinary, policyReductionVersion, generation: 2 };
  assert.equal(isReducedCredentialPlan(plan, reduced), true);
  assert.deepEqual(
    reduced.routes,
    [route],
    "removing Git preserves the independent binding exactly",
  );
  assert.equal(
    isReducedCredentialPlan(plan, {
      ...reduced,
      routes: [{ ...route, path: "/repos/example/another" }],
    }),
    false,
  );
  assert.equal(isReducedCredentialPlan(plan, { ...reduced, routes: [route, route] }), false);
  assert.equal(
    isReducedCredentialPlan(plan, {
      ...reduced,
      execution: { ...execution, executionId: randomUUID() },
    }),
    false,
  );
  assert.equal(isReducedCredentialPlan(plan, { ...reduced, generation: 1 }), false);
  assert.equal(
    isReducedCredentialPlan(reduced, { ...reduced, generation: 3, repositoryGit }),
    false,
    "withdrawn Git cannot be restored",
  );
  assert.equal(
    isReducedCredentialPlan(reduced, { ...reduced, generation: 3, routes: [] }),
    true,
    "last binding reduces to deny-all",
  );
  const legacy = { ...plan, policyReductionVersion: 1 as const };
  assert.equal(
    isReducedCredentialPlan(legacy, { ...reduced, policyReductionVersion: 1 }),
    false,
    "v1 does not acquire Git removal semantics",
  );
  for (const version of [4, 5, 6] as const) {
    const legacyPlan = {
      ...ordinary,
      repositoryGit,
      routes: [],
      ...(version === 5 ? { repositoryGitAuthorization: "online-request" as const } : {}),
      ...(version === 6 ? { repositoryGitAuthorization: "request-hook-observed" as const } : {}),
    };
    assert.doesNotThrow(() =>
      assertExecutionAdmission({
        executionAdmission: { version, mode: "protected" },
        egressPlan: legacyPlan,
      }),
    );
    assert.throws(
      () =>
        assertExecutionAdmission({
          executionAdmission: { version, mode: "protected" },
          egressPlan: { ...legacyPlan, policyReductionVersion: 2 },
        }),
      /admitted policy reduction capability/,
    );
  }
});
