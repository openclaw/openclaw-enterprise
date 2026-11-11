import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { claimIsolatedWork } from "../helpers/postgres-work-claim.mjs";
import { requestCredentialFixture } from "../helpers/request-credential-fixture.ts";
import { createOpenAiStaticProvider } from "../../apps/controller/src/drivers/egress-proxy/openai-provider.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual, promisify } from "node:util";
import type {
  RequestCredentialInput,
  ProxyPlan,
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
  OpenClawController,
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
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { requestId, staticEgressFixture } from "../helpers/static-egress.mjs";
import { listen } from "../helpers/listen.mjs";
import { CREDENTIAL_PROXY_ONE_SOURCE } from "../helpers/refusal-text.mjs";
import { readModelAuditDenials } from "../helpers/openshell-git-installation.mjs";

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
        // The reduction protocol needs distinct upstreams. Only the primary source is a Harness
        // model source; a separate fixture provider owns the auxiliary API destination.
        const auxiliaryOrigin = origin.replace("provider.example.test", "second.example.test");
        const auxiliary = createOpenAiStaticProvider();
        const auxiliaryType = { ...auxiliary.sourceType, type: "auxiliary-inference" };
        delete auxiliaryType.harnessAuth;
        const auxiliaryProvider = {
          ...auxiliary,
          ref: { ...auxiliary.ref, id: "auxiliary-inference" },
          sourceType: auxiliaryType,
          routes(
            source: Parameters<typeof auxiliary.routes>[0],
            binding: Parameters<typeof auxiliary.routes>[1],
          ) {
            return auxiliary.routes(source, binding, {
              modelProvider: {
                protocol: "openai-responses",
                baseUrl: `${auxiliaryOrigin}/v1`,
                supportsStandaloneWebSearch: false,
              },
            });
          },
        };
        // This test-owned catalogue adapter delegates validation and routing to the real provider.
        // Registration remains live through the Proxy; no Gateway copy is invented for this type.
        const gateway = app.controller.selectedDriver("credential_gateway");
        const listTypes = gateway.listSourceTypes.bind(gateway);
        const validate = gateway.validateSourceConfig.bind(gateway);
        t.mock.method(gateway, "listSourceTypes", async (...args: Parameters<typeof listTypes>) => [
          ...(await listTypes(...args)),
          auxiliaryType,
        ]);
        t.mock.method(gateway, "validateSourceConfig", (input: Parameters<typeof validate>[0]) =>
          input.type === auxiliaryType.type
            ? auxiliary.normalizeConfig(input.config)
            : validate(input),
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
          sourceControl: {
            ...original.sourceControl,
            providers: [...original.sourceControl.providers, auxiliaryProvider],
          },
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
          modelProvider: { protocol: "openai-responses", baseUrl: `${origin}/v1` },
        });
        app.controller.registerDriver(compute);
        app.controller.selectDriver("compute", compute.id);
        const createSource = async (name: string, type: string, baseUrl: string) => {
          const result = await app.request("POST", path, {
            body: {
              name,
              type,
              config: { authorized_base_url: `${baseUrl}/v1` },
              secrets: { api_key: secret.ref },
            },
          });
          assert.equal(result.status, 201, JSON.stringify(result.body));
          return result.data;
        };
        const source = await createSource(
          "first-reduced-source",
          "auxiliary-inference",
          auxiliaryOrigin,
        );
        sourceB = (await createSource("harness-inference", "openai", origin)).id;
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

test(
  "online model requests redeem current material once after durable policy authorization (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t, {
      credentialProxyCapacity: {
        operations: 2,
        authenticatingOperations: 2,
        sandboxOperations: 2,
      },
    });
    const { f, exchange, request, grant, revision } = fixture;
    const stored = await f.pool.query<{
      admitted_spec: {
        execution_admission: { mode: string; version: number };
        egress_plan: ProxyPlan;
        harness_auth: { protectedExecutionVersion: number };
      };
    }>("SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1", [revision.id]);
    const baseline = stored.rows[0]!.admitted_spec;
    const plan = baseline.egress_plan;
    // Invalid persisted profiles must fail the database constraint, even outside API validation.
    for (const invalid of [
      { ...baseline, egress_plan: { ...plan, authorization: undefined } },
      {
        ...baseline,
        execution_admission: { mode: "protected", version: 3 },
        harness_auth: { ...baseline.harness_auth, protectedExecutionVersion: 3 },
      },
      { ...baseline, egress_plan: { ...plan, routes: [] } },
      { ...baseline, egress_plan: { ...plan, policyReductionVersion: 1 } },
      {
        ...baseline,
        egress_plan: {
          ...plan,
          routes: [
            ...plan.routes,
            {
              ...plan.routes[0]!,
              binding: {
                ...plan.routes[0]!.binding,
                source: {
                  ...plan.routes[0]!.binding.source,
                  source: { id: `cs_${randomUUID()}`, generation: 1 },
                },
              },
            },
          ],
        },
      },
    ]) {
      const id = `rev_${randomUUID()}`;
      const candidate = {
        ...invalid,
        egress_plan: {
          ...invalid.egress_plan,
          execution: { ...plan.execution, revisionId: id },
          routes: invalid.egress_plan.routes.map((route) => ({
            ...route,
            binding: {
              ...route.binding,
              execution: { ...route.binding.execution, revisionId: id },
            },
          })),
        },
      };
      await assert.rejects(
        f.pool.query(
          `INSERT INTO occ.agent_revisions
        (id,namespace_id,agent_id,revision_number,backend_id,gateway_managed_mode,admitted_spec,admitted_at)
        SELECT $2,namespace_id,agent_id,revision_number+1,backend_id,gateway_managed_mode,$3::jsonb,admitted_at
        FROM occ.agent_revisions WHERE id=$1`,
          [revision.id, id, JSON.stringify(candidate)],
        ),
        { code: "23514", constraint: "agent_revisions_execution_admission" },
      );
    }
    const signal = AbortSignal.timeout(50_000);
    const first = request();
    assert.equal(await exchange.authorizeRequestCredential(first, signal), "credential");

    // Reconstruct the controller and repository wrappers: the approval is durable, not a local map.
    const afterRestart = fixture.restartController().createCredentialProxy({
      async verify() {
        return undefined;
      },
      capture() {
        return undefined;
      },
      owns() {
        return false;
      },
    });
    const beforeRead = f.secretReads;
    const material = await afterRestart.resolveRequestCredential(grant(first), signal);
    assert.equal(material?.value, "synthetic-key-initial");
    assert.ok(material?.version);
    assert.equal(
      f.secretReads,
      beforeRead + 3,
      "two snapshots plus the fenced final observation protect held-read rotation",
    );
    assert.equal(await exchange.resolveRequestCredential(grant(first), signal), undefined);
    assert.equal(
      await exchange.authorizeRequestCredential(first, signal),
      undefined,
      "the consumed request remains a tombstone until expiry",
    );

    const bound = request();
    assert.equal(await exchange.authorizeRequestCredential(bound, signal), "credential");
    assert.equal(
      await afterRestart.resolveRequestCredential(
        { ...grant(bound), recipientId: randomUUID() },
        signal,
      ),
      undefined,
    );
    assert.equal(
      await afterRestart.resolveRequestCredential(
        { ...grant(bound), bindingId: randomUUID() },
        signal,
      ),
      undefined,
    );
    assert.equal(
      await afterRestart.resolveRequestCredential(
        { ...grant(bound), deadlineAt: new Date(0).toISOString() },
        signal,
      ),
      undefined,
    );
    const concurrent = await Promise.all([
      exchange.resolveRequestCredential(grant(bound), signal),
      afterRestart.resolveRequestCredential(grant(bound), signal),
    ]);
    assert.equal(
      concurrent.filter(Boolean).length,
      1,
      "independent authorities can redeem a request only once",
    );

    // Invalid request semantics and foreign identities cannot create a usable approval or read a Secret.
    const foreign = await f.createNamespace(`request-other-${randomUUID().slice(0, 8)}`);
    const readsBeforeDenials = f.secretReads;
    for (const mutate of [
      (input: RequestCredentialInput) => ({ ...input, recipient: { id: randomUUID() } }),
      (input: RequestCredentialInput) => ({ ...input, bindingId: randomUUID() }),
      (input: RequestCredentialInput) => ({
        ...input,
        execution: { ...input.execution, namespaceId: foreign.id },
      }),
      (input: RequestCredentialInput) => ({
        ...input,
        http: { ...input.http, target: { ...input.http.target, path: "/v1/chat/completions" } },
      }),
      (input: RequestCredentialInput) => ({
        ...input,
        http: {
          ...input.http,
          body: Buffer.from(
            JSON.stringify({ model: "another-model", input: "hello", store: false }),
          ),
        },
      }),
    ]) {
      const refused = mutate(request());
      assert.equal(await exchange.authorizeRequestCredential(refused, signal), undefined);
      assert.equal(await exchange.resolveRequestCredential(grant(refused), signal), undefined);
    }
    const saved = fixture.installation;
    fixture.setInstallation({
      ...saved,
      enforcement: { ...saved.enforcement, policyHash: "b".repeat(64) },
    });
    assert.equal(
      await exchange.authorizeRequestCredential(request(), signal),
      undefined,
      "a recipient that still exists cannot reuse an old installation fence",
    );
    fixture.setInstallation(saved);
    assert.equal(f.secretReads, readsBeforeDenials);

    // A held real Kubernetes GET contains the old version; a concurrent API update advances storage.
    const rotating = request();
    assert.equal(await exchange.authorizeRequestCredential(rotating, signal), "credential");
    const barrier = f.pauseNextSecretRead();
    t.after(() => barrier.release());
    const resolving = exchange.resolveRequestCredential(grant(rotating), signal);
    await barrier.reached;
    try {
      const update = await f.request(
        "PATCH",
        `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`,
        {
          body: { value: "synthetic-key-rotated" },
        },
      );
      assert.equal(update.status, 200, JSON.stringify(update.body));
    } finally {
      barrier.release();
    }
    assert.equal(
      await resolving,
      undefined,
      "rotation while the first read is held must refuse release",
    );
    const rotated = request();
    assert.equal(await exchange.authorizeRequestCredential(rotated, signal), "credential");
    assert.equal(
      (await exchange.resolveRequestCredential(grant(rotated), signal))?.value,
      "synthetic-key-rotated",
    );

    // Rotation must win even after both reads selected the old value, including while the
    // final external recipient observation is pending. These barriers do not replace decisions.
    const lateRotations = [];
    for (const stage of ["second-read", "final-verification"] as const) {
      const input = request();
      assert.equal(await exchange.authorizeRequestCredential(input, signal), "credential");
      const firstRead = f.pauseNextSecretRead();
      const pending = exchange.resolveRequestCredential(grant(input), signal);
      await firstRead.reached;
      const secondRead = f.pauseNextSecretRead();
      firstRead.release();
      await secondRead.reached;
      const finalVerification =
        stage === "final-verification" ? fixture.pauseNextVerification() : undefined;
      if (finalVerification) {
        secondRead.release();
        await finalVerification.reached;
      }
      const value = `synthetic-key-${stage}`;
      try {
        const update = await f.request(
          "PATCH",
          `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`,
          { body: { value } },
        );
        assert.equal(update.status, 200, JSON.stringify(update.body));
      } finally {
        secondRead.release();
        finalVerification?.release();
      }
      lateRotations.push({ stage, released: (await pending) !== undefined });
      const fresh = request();
      assert.equal(await exchange.authorizeRequestCredential(fresh, signal), "credential");
      assert.equal((await exchange.resolveRequestCredential(grant(fresh), signal))?.value, value);
    }
    assert.deepEqual(lateRotations, [
      { stage: "second-read", released: false },
      { stage: "final-verification", released: false },
    ]);

    // A dependency that ignores cancellation may stay pending, but may not retain the
    // Namespace lock or free its operation slot until its real I/O finally settles.
    const stalled = request();
    assert.equal(await exchange.authorizeRequestCredential(stalled, signal), "credential");
    const pause = fixture.pauseFinalMaterialRead();
    t.after(() => pause.release());
    const cancelled = new AbortController();
    const stalledRelease = exchange.resolveRequestCredential(grant(stalled), cancelled.signal);
    await pause.reached;
    cancelled.abort();
    assert.equal(await stalledRelease, undefined);
    const updateAfterAbort = await f.request(
      "PATCH",
      `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`,
      { body: { value: "synthetic-key-after-cancel" } },
    );
    assert.equal(updateAfterAbort.status, 200, "abandoned final reads must release policy locks");
    const remainingSlot = exchange.acquireRequestAuthentication();
    assert.ok(remainingSlot);
    assert.equal(exchange.acquireRequestAuthentication(), undefined);
    remainingSlot();
    pause.release();
    await pause.settled;
    // Drain the read's promise continuations before testing the returned slot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const restoredSlots = [
      exchange.acquireRequestAuthentication(),
      exchange.acquireRequestAuthentication(),
    ];
    assert.ok(restoredSlots.every(Boolean), "the settled read returns its capacity slot");
    for (const release of restoredSlots) {
      release?.();
    }

    // Authorization is checked again after durable approval; deleting the exact grant prevents redemption.
    const revoked = request();
    assert.equal(await exchange.authorizeRequestCredential(revoked, signal), "credential");
    assert.equal(
      (await f.request("DELETE", `/namespaces/${f.namespace.id}/iam/access-bindings/${f.grant.id}`))
        .status,
      204,
    );
    const readsBeforeRevocation = f.secretReads;
    assert.equal(await afterRestart.resolveRequestCredential(grant(revoked), signal), undefined);
    assert.equal(f.secretReads, readsBeforeRevocation);
    const restored = await f.request("POST", `/namespaces/${f.namespace.id}/iam/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: f.agent.servicePrincipalId,
        roleId: f.grant.roleId,
        resourceKind: "credential_source",
        resourceId: f.source.id,
      },
    });
    assert.equal(restored.status, 201, JSON.stringify(restored.body));
    const withdrawn = request();
    assert.equal(await exchange.authorizeRequestCredential(withdrawn, signal), "credential");
    // A native approval cannot cross into an authority whose decision is not fenced
    // by this State. Reject before invoking that external dependency or reading material.
    let externalCalls = 0;
    const externalController = fixture.restartController(undefined, async (authorization) => {
      externalCalls += 1;
      return externalController.selectedDriver("iam").authorize(authorization);
    });
    const externalExchange = externalController.createCredentialProxy({
      async verify() {
        return undefined;
      },
      capture() {
        return undefined;
      },
      owns() {
        return false;
      },
    });
    const unsupported = request();
    assert.equal(await exchange.authorizeRequestCredential(unsupported, signal), "credential");
    const beforeUnsupported = f.secretReads;
    const unsupportedApproval = await externalExchange.authorizeRequestCredential(
      request(),
      signal,
    );
    const unsupportedMaterial = await externalExchange.resolveRequestCredential(
      grant(unsupported),
      signal,
    );
    const unsupportedObserved = {
      approved: unsupportedApproval !== undefined,
      released: unsupportedMaterial !== undefined,
      externalCalls,
      secretReads: f.secretReads - beforeUnsupported,
    };

    // Cancellation after the real INSERT must roll it back, not leave a row that a
    // subsequent authenticated redemption could still consume.
    const canceledInput = request();
    const canceledCall = new AbortController();
    const inserted = fixture.pauseNextApprovalCommit();
    t.after(() => inserted.release());
    const canceling = exchange.authorizeRequestCredential(canceledInput, canceledCall.signal);
    await inserted.reached;
    canceledCall.abort();
    inserted.release();
    assert.equal(await canceling, undefined);
    const canceledRows = await f.pool.query(
      "SELECT count(*)::int AS count FROM occ.request_credential_approvals WHERE recipient_id=$1 AND request_id=$2",
      [canceledInput.recipient.id, canceledInput.requestId],
    );
    const canceledMaterial = await exchange.resolveRequestCredential(grant(canceledInput), signal);
    assert.deepEqual(
      {
        unsupportedObserved,
        canceledRows: canceledRows.rows[0].count,
        canceledReleased: canceledMaterial !== undefined,
      },
      {
        unsupportedObserved: { approved: false, released: false, externalCalls: 0, secretReads: 0 },
        canceledRows: 0,
        canceledReleased: false,
      },
    );
    // Admission also refuses the profile before resolving source material. Ordinary
    // administrator authorization is separate from model-request authorization above.
    const beforeAdmission = f.secretReads;
    await assert.rejects(
      externalController.createCredentialSource(fixture.principalId, {
        namespaceId: f.namespace.id,
        name: "unsupported-online-authority",
        type: "openai",
        authorization: "online-request",
        config: { authorized_base_url: `${revision.egressPlan!.routes[0]!.origin}/v1` },
        secrets: { api_key: f.secret.ref },
      }),
      /native IAM Driver/,
    );
    // The source and Agent predate the IAM switch, so source-creation refusal alone
    // cannot protect a new deployment of this otherwise valid execution.
    await assert.rejects(
      externalController.deployAgent(
        fixture.principalId,
        { namespaceId: f.namespace.id, agentId: f.agent.id },
        resolveApprovedHarness,
      ),
      /native IAM Driver/,
    );
    assert.equal(f.secretReads, beforeAdmission);
    assert.equal(await exchange.authorizeRequestCredential(canceledInput, signal), "credential");
    assert.equal(
      (await exchange.resolveRequestCredential(grant(canceledInput), signal))?.value,
      "synthetic-key-after-cancel",
    );
    const withdrawal = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${f.source.id}/withdraw`,
    );
    assert.equal(withdrawal.status, 202, JSON.stringify(withdrawal.body));
    assert.equal(await exchange.resolveRequestCredential(grant(withdrawn), signal), undefined);
    assert.equal(await exchange.authorizeRequestCredential(request(), signal), undefined);
    const audit = await f.pool.query(
      "SELECT details FROM occ.audit_events WHERE actor_id = $1 AND action = 'openclaw.egress.authorize'",
      [f.agent.servicePrincipalId],
    );
    assert.ok(audit.rows.some(({ details }) => details.code === "unauthorized"));
    assert.ok(audit.rows.some(({ details }) => details.code === "stale_material"));
  },
);

test(
  "model denial diagnostics count only selected before-access audit events (PostgreSQL)",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    assert.ok(databaseUrl);
    const { f, exchange, request, grant, revision } = await requestCredentialFixture(t);
    const startedAt = new Date(Date.now() - 1).toISOString();

    // The real OCC authorization path creates these audit events. The fixture supplies
    // external recipient observation, not the authorization decision or audit rows.
    const approved = request();
    assert.equal(await exchange.authorizeRequestCredential(approved, t.signal), "credential");
    const unsupported = request();
    assert.equal(
      await exchange.authorizeRequestCredential(
        {
          ...unsupported,
          http: { ...unsupported.http, target: { ...unsupported.http.target, method: "GET" } },
        },
        t.signal,
      ),
      undefined,
    );
    assert.equal(
      (await f.request("DELETE", `/namespaces/${f.namespace.id}/iam/access-bindings/${f.grant.id}`))
        .status,
      204,
    );
    assert.equal(await exchange.resolveRequestCredential(grant(approved), t.signal), undefined);
    assert.equal(await exchange.authorizeRequestCredential(request(), t.signal), undefined);
    const endedAt = new Date().toISOString();
    const releaseAudit = await f.pool.query(
      "SELECT details->>'phase' AS phase FROM occ.audit_events WHERE details->>'requestId' = $1",
      [approved.requestId],
    );
    assert.deepEqual(releaseAudit.rows, [{ phase: "before_release" }]);

    const identity = [f.namespace.id, f.source.id, revision.id, f.agent.servicePrincipalId];
    const summarize = async (args: string[]) => {
      // Execute the exact API-container program with the less-privileged application
      // connection. No query or aggregate implementation is recreated in this test.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", readModelAuditDenials, ...args],
        {
          cwd: new URL("../../", import.meta.url),
          env: { ...process.env, OCC_DATABASE_URL: databaseUrl },
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          signal: t.signal,
        },
      );
      return JSON.parse(stdout);
    };
    const empty = {
      state: "observed",
      truncated: false,
      counts: {
        unsupported_authority: 0,
        stale_configuration: 0,
        withdrawn: 0,
        unsupported_operation: 0,
        unauthorized: 0,
        other: 0,
      },
    };
    assert.deepEqual(await summarize([...identity, startedAt, endedAt]), {
      ...empty,
      counts: { ...empty.counts, unsupported_operation: 1, unauthorized: 1 },
    });

    // Each selector must exclude the existing matching rows independently. A
    // before-release denial above must not inflate the before-access count.
    for (let index = 0; index < identity.length; index += 1) {
      const other = [...identity];
      other[index] = randomUUID();
      assert.deepEqual(await summarize([...other, startedAt, endedAt]), empty);
    }
    for (const [start, end] of [
      [
        new Date(Date.parse(startedAt) - 60_000).toISOString(),
        new Date(Date.parse(startedAt) - 1).toISOString(),
      ],
      [
        new Date(Date.parse(endedAt) + 1).toISOString(),
        new Date(Date.parse(endedAt) + 60_000).toISOString(),
      ],
    ] as const) {
      assert.deepEqual(await summarize([...identity, start, end]), empty);
    }
    await assert.rejects(
      summarize([...identity, endedAt, new Date(Date.parse(startedAt) - 1).toISOString()]),
      { code: 1 },
    );
  },
);

test(
  "online request replay horizons and shared quotas survive API restart (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const a = await requestCredentialFixture(t);
    const b = await requestCredentialFixture(t);
    const c = await requestCredentialFixture(t);
    const { rows } = await a.f.pool.query(
      "SELECT count(*)::int AS retained FROM occ.request_credential_approvals WHERE replay_until_at > now()",
    );
    // Other cases own their correlations. Allocate three additional slots without deleting them.
    const capacity = {
      operations: 16,
      authenticatingOperations: 4,
      sandboxOperations: 8,
      requestIds: rows[0].retained + 3,
      sandboxRequestIds: 2,
    };
    const transport = {
      async verify() {
        return undefined;
      },
      capture() {
        return undefined;
      },
      owns() {
        return false;
      },
    };
    const replica = (fixture: typeof a) =>
      fixture.restartController(capacity).createCredentialProxy(transport);
    const firstApi = replica(a);
    const restartedApi = replica(a);
    const signal = AbortSignal.timeout(40_000);
    const horizon = Date.now() + 8_000;
    const first = {
      ...a.request(),
      deadlineAt: new Date(Date.now() + 1_500).toISOString(),
      replayUntilAt: new Date(horizon).toISOString(),
    };
    assert.equal(await firstApi.authorizeRequestCredential(first, signal), "credential");
    assert.equal(
      (await restartedApi.resolveRequestCredential(a.grant(first), signal))?.value,
      "synthetic-key-initial",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(first.deadlineAt) - Date.now() + 30)),
    );
    const renewed = { ...first, deadlineAt: new Date(horizon).toISOString() };
    const reads = a.f.secretReads;
    assert.equal(
      await restartedApi.authorizeRequestCredential(renewed, signal),
      undefined,
      "a fresh redemption deadline cannot reopen the same authenticated request",
    );
    assert.equal(a.f.secretReads, reads);
    const request = (fixture: typeof a) => ({
      ...fixture.request(),
      deadlineAt: new Date(horizon).toISOString(),
      replayUntilAt: new Date(horizon).toISOString(),
    });
    assert.equal(await restartedApi.authorizeRequestCredential(request(a), signal), "credential");
    assert.equal(
      await firstApi.authorizeRequestCredential(request(a), signal),
      undefined,
      "consumed and pending IDs share the recipient quota across replicas",
    );
    // Different Namespaces have independent policy locks, so only the durable quota lock
    // prevents both API replicas from taking the final global slot.
    const concurrent = await Promise.all([
      replica(b).authorizeRequestCredential(request(b), signal),
      replica(c).authorizeRequestCredential(request(c), signal),
    ]);
    assert.equal(concurrent.filter((result) => result === "credential").length, 1);
    const bounded = await a.f.pool.query(
      "SELECT count(*)::int AS retained FROM occ.request_credential_approvals WHERE replay_until_at > now()",
    );
    assert.equal(bounded.rows[0].retained, capacity.requestIds);

    // Once the authenticated horizon closes, fresh authentication may reuse the correlation,
    // and expired tombstones release both global and recipient capacity.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, horizon - Date.now() + 30)));
    const next = a.request();
    assert.equal(
      await replica(a).authorizeRequestCredential({ ...next, requestId: first.requestId }, signal),
      "credential",
    );
    assert.equal(await replica(b).authorizeRequestCredential(b.request(), signal), "credential");
    assert.equal(await replica(c).authorizeRequestCredential(c.request(), signal), "credential");

    // Online authorization and redemption select READ COMMITTED independently of a
    // pool's default, so quota and policy reads see commits after lock acquisition.
    const snapshot = await requestCredentialFixture(t, {
      poolOptions: { options: "-c default_transaction_isolation=repeatable\\ read" },
    });
    assert.equal(
      (await snapshot.f.pool.query("SHOW default_transaction_isolation")).rows[0]
        .default_transaction_isolation,
      "repeatable read",
    );
    const defaultIsolationInput = snapshot.request();
    assert.equal(
      await snapshot.exchange.authorizeRequestCredential(defaultIsolationInput, signal),
      "credential",
      "online admission must select current-policy isolation instead of the pool default",
    );
    assert.equal(
      (
        await snapshot.exchange.resolveRequestCredential(
          snapshot.grant(defaultIsolationInput),
          signal,
        )
      )?.value,
      "synthetic-key-initial",
    );

    // Approve through an ordinary READ COMMITTED replica, then redeem on a replica
    // whose connection default is REPEATABLE READ. Hold its final policy check after
    // the initial database read; an actual IAM API deletion must invalidate that approval.
    const committedPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => committedPool.end());
    const committedApi = snapshot
      .restartController(undefined, undefined, committedPool)
      .createCredentialProxy(transport);
    const selected = snapshot.request();
    assert.equal(await committedApi.authorizeRequestCredential(selected, signal), "credential");
    const policy = snapshot.pauseFinalPolicyLock();
    t.after(() => policy.release());
    const releasing = snapshot.exchange.resolveRequestCredential(snapshot.grant(selected), signal);
    await policy.reached;
    try {
      const deletion = await snapshot.f.request(
        "DELETE",
        `/namespaces/${snapshot.f.namespace.id}/iam/access-bindings/${snapshot.f.grant.id}`,
      );
      assert.equal(deletion.status, 204, JSON.stringify(deletion.body));
    } finally {
      policy.release();
    }
    assert.equal(
      await releasing,
      undefined,
      "final authorization must observe grant withdrawal committed after its first database read",
    );

    // A contending global quota must not hold the policy locks needed for source withdrawal.
    const quotaOwner = await b.f.pool.connect();
    const contended = b.request();
    const bApi = b.restartController().createCredentialProxy(transport);
    const bReads = b.f.secretReads;
    try {
      await quotaOwner.query("BEGIN");
      await quotaOwner.query("SELECT pg_advisory_xact_lock(1868785008, 0)");
      const attempt = bApi.authorizeRequestCredential(contended, AbortSignal.timeout(100));
      const outcome = await Promise.race([
        attempt,
        new Promise<string>((resolve) => setTimeout(() => resolve("quota wait"), 500)),
      ]);
      assert.equal(
        outcome,
        undefined,
        "quota contention must fail without waiting on policy locks",
      );
      const withdrawalRequest = b.f.request(
        "POST",
        `/namespaces/${b.f.namespace.id}/agents/${b.f.agent.id}/credential-sources/${b.f.source.id}/withdraw`,
      );
      const withdrawal = await Promise.race([
        withdrawalRequest,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
      ]);
      assert.ok(withdrawal, "quota contention must not delay source withdrawal");
      assert.equal(withdrawal.status, 202, JSON.stringify(withdrawal.body));
      assert.equal(await bApi.resolveRequestCredential(b.grant(contended), signal), undefined);
      assert.equal(b.f.secretReads, bReads);
    } finally {
      await quotaOwner.query("ROLLBACK");
      quotaOwner.release();
    }

    // Local identity clocks can disagree. A fast replica must not delete a correlation
    // that is still eligible at the database, and a slow one cannot recreate it after expiry.
    const slowApi = a
      .restartController(undefined, undefined, a.f.pool, () => new Date(Date.now() - 2_000))
      .createCredentialProxy(transport);
    const fastApi = a
      .restartController(undefined, undefined, a.f.pool, () => new Date(Date.now() + 2_000))
      .createCredentialProxy(transport);
    const ordinaryApi = a.restartController().createCredentialProxy(transport);
    const databaseNow = (
      await a.f.pool.query("SELECT clock_timestamp() AS time")
    ).rows[0].time.getTime();
    const skewed = {
      ...a.request(),
      deadlineAt: new Date(databaseNow + 1_000).toISOString(),
      replayUntilAt: new Date(databaseNow + 1_500).toISOString(),
    };
    assert.equal(await slowApi.authorizeRequestCredential(skewed, signal), "credential");
    assert.equal(
      (await ordinaryApi.resolveRequestCredential(a.grant(skewed), signal))?.value,
      "synthetic-key-initial",
    );
    const fastRequest = {
      ...a.request(),
      deadlineAt: new Date(databaseNow + 10_000).toISOString(),
      replayUntilAt: new Date(databaseNow + 20_000).toISOString(),
    };
    assert.equal(await fastApi.authorizeRequestCredential(fastRequest, signal), "credential");
    assert.equal(
      await slowApi.authorizeRequestCredential(skewed, signal),
      undefined,
      "fast replica pruning must preserve a still-valid consumed correlation",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, databaseNow + 1_550 - Date.now())),
    );
    assert.equal(
      await slowApi.authorizeRequestCredential(skewed, signal),
      undefined,
      "the database rejects an expired correlation even when the replica clock lags",
    );
    assert.equal(
      await ordinaryApi.authorizeRequestCredential(
        { ...a.request(), requestId: skewed.requestId },
        signal,
      ),
      "credential",
      "fresh authentication can reuse the ID after the database retention horizon",
    );
  },
);

test(
  "online approval expiry is bounded by database time despite issuer clock skew (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t);
    const transport = {
      async verify() {
        return undefined;
      },
      capture() {
        return undefined;
      },
      owns() {
        return false;
      },
    };
    const fastIssuer = fixture
      .restartController(undefined, undefined, fixture.f.pool, () => new Date(Date.now() + 60_000))
      .createCredentialProxy(transport);
    const input = {
      ...fixture.request(),
      deadlineAt: new Date(Date.now() + 90_000).toISOString(),
      replayUntilAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const signal = AbortSignal.timeout(50_000);
    assert.equal(await fastIssuer.authorizeRequestCredential(input, signal), "credential");
    const observed = await fixture.f.pool.query(
      "SELECT expires_at, replay_until_at, clock_timestamp() AS observed_at FROM occ.request_credential_approvals WHERE recipient_id=$1 AND request_id=$2",
      [input.recipient.id, input.requestId],
    );
    const row = observed.rows[0];
    assert.ok(row);
    assert.equal(row.replay_until_at.toISOString(), input.replayUntilAt);
    const immediate = { ...input, requestId: randomUUID() };
    assert.equal(await fastIssuer.authorizeRequestCredential(immediate, signal), "credential");
    const immediateGrant = {
      ...fixture.grant(immediate),
      deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    };
    const material = await fixture.exchange.resolveRequestCredential(immediateGrant, signal);
    assert.equal(material?.value, "synthetic-key-initial");
    assert.ok(Date.parse(material.usableUntil) <= Date.parse(immediateGrant.deadlineAt));
    const immediateStored = await fixture.f.pool.query(
      "SELECT expires_at FROM occ.request_credential_approvals WHERE recipient_id=$1 AND request_id=$2",
      [immediate.recipient.id, immediate.requestId],
    );
    assert.ok(Date.parse(material.usableUntil) <= immediateStored.rows[0].expires_at.getTime());

    // The stored approval must also control release when the caller's grant lasts longer.
    const limited = fixture.request();
    assert.equal(await fixture.exchange.authorizeRequestCredential(limited, signal), "credential");
    const limitedStored = await fixture.f.pool.query(
      "SELECT expires_at FROM occ.request_credential_approvals WHERE recipient_id=$1 AND request_id=$2",
      [limited.recipient.id, limited.requestId],
    );
    const longerGrant = {
      ...fixture.grant(limited),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const storedDeadline = limitedStored.rows[0].expires_at.toISOString();
    assert.ok(Date.parse(storedDeadline) < Date.parse(longerGrant.deadlineAt));
    const limitedMaterial = await fixture.exchange.resolveRequestCredential(longerGrant, signal);
    assert.equal(limitedMaterial?.value, "synthetic-key-initial");
    assert.equal(limitedMaterial.usableUntil, storedDeadline);

    // Wait real elapsed time; changing only a fixture clock would not prove the database lease.
    // The aligned caller supplies a fresh grant input with its own short deadline.
    await new Promise((resolve) => setTimeout(resolve, 30_100));
    const reads = fixture.f.secretReads;
    assert.equal(
      await fixture.exchange.resolveRequestCredential(
        { ...fixture.grant(input), deadlineAt: new Date(Date.now() + 20_000).toISOString() },
        signal,
      ),
      undefined,
      "an unused approval cannot outlive thirty seconds because its issuer clock is ahead",
    );
    assert.equal(fixture.f.secretReads, reads);
    assert.ok(row.expires_at.getTime() <= row.observed_at.getTime() + 30_000);
    assert.equal(
      await fastIssuer.authorizeRequestCredential(
        { ...input, deadlineAt: input.replayUntilAt },
        signal,
      ),
      undefined,
      "shortening redemption must preserve the original replay tombstone",
    );
    const fresh = fixture.request();
    assert.equal(await fixture.exchange.authorizeRequestCredential(fresh, signal), "credential");
    assert.equal(
      (await fixture.exchange.resolveRequestCredential(fixture.grant(fresh), signal))?.value,
      "synthetic-key-initial",
    );
  },
);

test(
  "online release expires on database time while a slow replica reads Secrets (PostgreSQL)",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t);
    const input = { ...fixture.request(), deadlineAt: new Date(Date.now() + 10_000).toISOString() };
    const signal = AbortSignal.timeout(25_000);
    assert.equal(await fixture.exchange.authorizeRequestCredential(input, signal), "credential");
    const slow = fixture
      .restartController(undefined, undefined, fixture.f.pool, () => new Date(Date.now() - 1_000))
      .createCredentialProxy({
        async verify() {
          return undefined;
        },
        capture() {
          return undefined;
        },
        owns() {
          return false;
        },
      });
    // Delay actual Driver results, including their original observation timestamps, past
    // this replica's clock lag. Its freshness checks remain valid without rewriting evidence.
    let paused = fixture.pauseMaterialRead();
    t.after(() => paused.release());
    const releasing = slow.resolveRequestCredential(fixture.grant(input), signal);
    const waitForRead = async (label: string) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          paused.reached.then(() => "read"),
          releasing.then(() => "resolver completed"),
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("read timed out"), 5_000);
          }),
        ]);
        assert.equal(outcome, "read", `must reach ${label} before the resolver completes`);
      } finally {
        clearTimeout(timeout);
      }
    };
    for (let read = 0; read < 2; read += 1) {
      await waitForRead(`outside-lock read ${read + 1}`);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const previous = paused;
      paused = fixture.pauseMaterialRead();
      previous.release();
      await previous.settled;
    }
    await waitForRead("final read");
    try {
      // Synchronize on the actual final observation before crossing database expiry.
      // Leave ample setup time; a correctly completed resolver must never strand a barrier.
      const remaining = await fixture.f.pool.query(
        "SELECT EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000 AS remaining_ms FROM occ.request_credential_approvals WHERE request_id=$1",
        [input.requestId],
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1_100, Number(remaining.rows[0].remaining_ms) + 100)),
      );
      const expired = await fixture.f.pool.query(
        "SELECT expires_at < clock_timestamp() AS expired FROM occ.request_credential_approvals WHERE request_id=$1",
        [input.requestId],
      );
      assert.equal(expired.rows[0].expired, true);
    } finally {
      paused.release();
    }
    await paused.settled;
    assert.equal(
      await releasing,
      undefined,
      "a slow replica must not release material after the database lease expires during its final read",
    );
    assert.equal(
      await fixture.exchange.resolveRequestCredential(fixture.grant(input), signal),
      undefined,
    );
  },
);

test(
  "online release serializes configured role revocation with its final Secret read (PostgreSQL)",
  { ...requiresPostgres, timeout: 20_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t);
    const { f, exchange, request, grant } = fixture;
    const applicationName = `request-role-writer-${randomUUID()}`;
    const writerPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: applicationName,
    });
    t.after(() => writerPool.end());
    const writerState = new PostgresPlatformState(writerPool);
    const writer = (operate: boolean) => {
      const controller = new OpenClawController(f.controller.installation, {
        state: writerState,
        iamConfiguration: {
          roles: [
            {
              id: "request_model",
              permissions: [
                { resourceKind: "credential_source", action: operate ? "operate" : "read" },
              ],
            },
          ],
          defaultUserGroups: [],
          roleBindings: [],
        },
      });
      const iam = new NativeIAMDriver(writerState, { id: "request-role-writer" });
      controller.registerDriver(iam);
      controller.selectDriver("iam", iam.id);
      return controller;
    };
    await writer(true).applyIAMConfiguration();
    // Seed the existing creator binding through Native IAM's production ownership port.
    // The namespace policy HTTP API intentionally cannot bind configured Installation Roles.
    const ownership = new NativeIAMDriver(writerState, { id: "request-owner-fixture" });
    const binding = await writerState.transact(async (unit) => {
      await unit.installations.holdIAMConfiguration("shared");
      return ownership.createOwnerBinding(
        { policy: unit.iamPolicy },
        {
          id: `binding_owner_${f.source.id}`,
          namespaceId: f.namespace.id,
          principalId: f.agent.servicePrincipalId,
          roleId: "role_config_request_model",
          resourceKind: "credential_source",
          resourceId: f.source.id,
        },
      );
    });
    assert.equal(
      (await f.request("DELETE", `/namespaces/${f.namespace.id}/iam/access-bindings/${f.grant.id}`))
        .status,
      204,
    );
    const signal = AbortSignal.timeout(12_000);
    const input = request();
    assert.equal(await exchange.authorizeRequestCredential(input, signal), "credential");
    const held = fixture.pauseFinalMaterialRead();
    t.after(() => held.release());
    const releasing = exchange.resolveRequestCredential(grant(input), signal);
    await held.reached;
    // Only the configured Role changes. The unchanged binding supplies the Agent's
    // sole operate permission, so this writer has no Namespace row to lock.
    let committed = false;
    const changing = writer(false)
      .applyIAMConfiguration()
      .then(() => {
        committed = true;
      });
    let waited = false;
    try {
      const until = Date.now() + 5_000;
      while (!committed && !waited && Date.now() < until) {
        const activity = await f.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
          [applicationName],
        );
        waited = activity.rowCount !== 0;
        if (!waited) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      held.release();
    }
    const material = await releasing;
    await changing;
    assert.equal(
      waited,
      true,
      "configured role revocation must wait for the final material decision",
    );
    assert.equal(material?.value, "synthetic-key-initial");
    const retained = await f.pool.query("SELECT role_id FROM occ.iam_access_bindings WHERE id=$1", [
      binding.id,
    ]);
    assert.equal(retained.rows[0].role_id, "role_config_request_model");
    const reads = f.secretReads;
    assert.equal(
      await exchange.authorizeRequestCredential(request(), signal),
      undefined,
      "the next request must observe the configured Role's revoked operate permission",
    );
    assert.equal(f.secretReads, reads);
  },
);

test(
  "pending model authorization survives recorded readiness deferral (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // Public admission creates the candidate. Only external installation observation is
    // controlled: this does not prove a workload reached readiness or ran a model turn.
    const { f, revision, exchange, request, grant } = await requestCredentialFixture(t, {
      activateRevision: false,
    });
    const queue = new PostgresWorkQueue(f.pool);
    const key = `agent_revision:${revision.id}:reconcile`;
    const path = `/namespaces/${f.namespace.id}/agents/${f.agent.id}`;
    const signal = AbortSignal.timeout(50_000);
    const claim = async () => {
      const selected = await claimIsolatedWork(f.pool, { workId: key });
      assert.equal(selected?.idempotencyKey, key);
      assert.ok(selected);
      return selected;
    };
    const sample = async (
      phase: string,
      expected: { status: string; state: string; leased: boolean; approved: boolean },
    ) => {
      const work = await queue.findWork(key);
      assert.ok(work);
      assert.equal(work.namespaceId, f.namespace.id);
      assert.equal(work.agentId, f.agent.id);
      assert.equal(work.revisionId, revision.id);
      const state = new PostgresPlatformState(f.pool);
      const source = await state.read((unit) =>
        unit.credentialSources.findCredentialSource(f.namespace.id, f.source.id),
      );
      assert.equal(source?.state, "ready");
      const latest = await state.read((unit) =>
        unit.revisions.listRevisionMetadata(f.namespace.id, f.agent.id),
      );
      assert.equal(latest.at(-1)?.id, revision.id);
      assert.equal(work.state, expected.state);
      assert.equal(work.leaseActive, expected.leased);
      const marker = (
        await f.pool.query(
          "SELECT readiness_deferred FROM occ.controller_work WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0].readiness_deferred;
      assert.equal(marker, expected.state === "queued" && expected.approved);
      const agent = await f.request("GET", path);
      assert.equal(agent.status, 200);
      assert.equal(agent.data.status, "active");
      assert.equal(agent.data.desiredRuntimeState, "running");
      assert.equal(agent.data.activeRevisionId ?? null, null);
      const deployment = await f.request("GET", `${path}/deployments/${revision.id}`);
      assert.equal(deployment.status, 200);
      assert.equal(deployment.data.status, expected.status);
      const input = request();
      const counts = async () => {
        const approvals = await f.pool.query(
          "SELECT count(*)::int AS count FROM occ.request_credential_approvals WHERE request_id=$1 AND recipient_id=$2",
          [input.requestId, input.recipient.id],
        );
        const denials = await f.pool.query(
          `SELECT details->>'code' AS code FROM occ.audit_events
           WHERE namespace_id=$1 AND resource_id=$2 AND actor_id=$3
             AND kind='authorization_denial' AND action='openclaw.egress.authorize'
             AND outcome='denied' AND details->>'phase'='before_access'
             AND details->>'revisionId'=$4 AND details->>'requestId'=$5`,
          [f.namespace.id, f.source.id, revision.servicePrincipalId, revision.id, input.requestId],
        );
        return { approvals: approvals.rows[0].count, denials: denials.rows.map((row) => row.code) };
      };
      assert.deepEqual(await counts(), { approvals: 0, denials: [] });
      const before = await f.pool.query("SELECT clock_timestamp() AS at");
      const reads = f.secretReads;
      const result = await exchange.authorizeRequestCredential(input, signal);
      assert.equal(result, expected.approved ? "credential" : undefined, phase);
      const after = await counts();
      const finished = await f.pool.query("SELECT clock_timestamp() AS at");
      assert.deepEqual(after, {
        approvals: expected.approved ? 1 : 0,
        denials: expected.approved ? [] : ["withdrawn"],
      });
      const material = await exchange.resolveRequestCredential(grant(input), signal);
      assert.equal(material?.value, expected.approved ? "synthetic-key-initial" : undefined, phase);
      assert.equal(f.secretReads, reads + (expected.approved ? 3 : 0));
      // Authorization must not change the public deployment view or activate the candidate.
      assert.equal(
        (await f.request("GET", `${path}/deployments/${revision.id}`)).data.status,
        expected.status,
      );
      assert.equal((await f.request("GET", path)).data.activeRevisionId ?? null, null);
      t.diagnostic(
        JSON.stringify({
          phase,
          namespaceId: f.namespace.id,
          agentId: f.agent.id,
          revisionId: revision.id,
          sourceId: f.source.id,
          workId: key,
          requestId: input.requestId,
          databaseAt: before.rows[0].at.toISOString(),
          finishedAt: finished.rows[0].at.toISOString(),
          sourceState: source.state,
          state: work.state,
          leased: work.leaseActive,
          attempts: work.attemptCount,
          status: deployment.data.status,
          progress: deployment.data.progress,
          activeRevisionId: null,
          ...after,
        }),
      );
    };
    await sample("never claimed", {
      status: "queued",
      state: "queued",
      leased: false,
      approved: false,
    });
    const first = await claim();
    await sample("first lease", {
      status: "running",
      state: "claimed",
      leased: true,
      approved: true,
    });
    // Use the same persisted queue transition and evidence code as the Worker's pending
    // runtime result. No SQL work projection or fabricated audit row supplies this evidence.
    await queue.defer(first, { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
    const deferred = await queue.findWork(key);
    assert.equal(deferred?.attemptCount, 0);
    assert.equal(deferred?.claimToken, undefined);
    assert.equal(deferred?.leaseExpiresAt, undefined);
    const view = await f.request("GET", `${path}/deployments/${revision.id}`);
    assert.equal(view.data.progress.lastAttempt.code, "REVISION_INCOMPLETE");
    await sample("readiness deferred", {
      status: "running",
      state: "queued",
      leased: false,
      approved: true,
    });
    const reclaimed = await claim();
    assert.notEqual(reclaimed.claimToken, first.claimToken);
    await sample("reclaimed", {
      status: "running",
      state: "claimed",
      leased: true,
      approved: true,
    });
    await queue.defer(reclaimed, { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
    assert.equal(
      (await queue.findWorkAttempt(key))?.at.toISOString(),
      view.data.progress.lastAttempt.at,
      "duplicate evidence suppression must not remove readiness authority",
    );
    await sample("repeat readiness defer", {
      status: "running",
      state: "queued",
      leased: false,
      approved: true,
    });
    // A retry can use the same code; its failure outcome must override prior success.
    const retryClaim = await claim();
    await queue.retry(retryClaim, { code: "REVISION_INCOMPLETE" });
    await sample("same-code retry", {
      status: "running",
      state: "queued",
      leased: false,
      approved: false,
    });
    // Wait for the real backoff; do not rewrite queue timestamps.
    const retryWork = await queue.findWork(key);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, retryWork!.availableAt.getTime() - Date.now()) + 30),
    );
    const finalClaim = await claim();
    // Terminal work is denied while this is still the latest candidate and its
    // source is still ready, independently of withdrawal or replacement.
    await queue.fail(finalClaim, { code: "CONVERGENCE_DEADLINE_EXCEEDED" });
    await sample("terminal", {
      status: "failed",
      state: "failed_permanent",
      leased: false,
      approved: false,
    });
  },
);

for (const disabling of ["suppressed refusal", "out-of-order history"] as const) {
  test(
    `current queue transition overrides ${disabling} for model credentials (PostgreSQL)`,
    { ...requiresPostgres, timeout: 30_000 },
    async (t) => {
      const { f, revision, exchange, request, grant } = await requestCredentialFixture(t, {
        activateRevision: false,
      });
      const key = `agent_revision:${revision.id}:reconcile`;
      const queue = new PostgresWorkQueue(f.pool, { random: () => 0 });
      const signal = t.signal;
      const claim = async () => {
        const work = await queue.findWork(key);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, work!.availableAt.getTime() - Date.now()) + 20),
        );
        const selected = await claimIsolatedWork(f.pool, { workId: key });
        assert.ok(selected);
        return selected;
      };
      const marker = async () =>
        (
          await f.pool.query(
            "SELECT readiness_deferred FROM occ.controller_work WHERE idempotency_key=$1",
            [key],
          )
        ).rows[0].readiness_deferred;
      await queue.defer(await claim(), { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
      const held = request();
      assert.equal(await exchange.authorizeRequestCredential(held, signal), "credential");
      const events = async () =>
        (
          await f.pool.query(
            "SELECT count(*)::int AS count FROM occ.audit_events WHERE details->>'workId'=$1",
            [key],
          )
        ).rows[0].count;
      const before = await events();
      const next = await claim();
      if (disabling === "suppressed refusal") {
        // The queue accepts this combination. Suppressing audit must not preserve authority.
        await queue.defer(
          next,
          { code: "REVISION_INCOMPLETE", refusal: "CREDENTIAL_WITHDRAWN" },
          { delayMs: 1, recordEvidence: false },
        );
        assert.equal(await events(), before);
      } else {
        await queue.retry(next, { code: "REVISION_INCOMPLETE" });
        // Isolated synthetic negative evidence: a historical success appears later than
        // the real retry. This is not a runtime timestamp or a simulated worker result.
        await f.pool.query(
          `INSERT INTO occ.audit_events
           (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id, outcome, details)
           SELECT $2, clock_timestamp() + interval '1 day', kind, actor_id, action,
             namespace_id, resource_kind, resource_id, outcome, details
           FROM occ.audit_events WHERE details->>'workId'=$1 AND outcome='success' LIMIT 1`,
          [key, `aud_${randomUUID()}`],
        );
      }
      const denied = request();
      const reads = f.secretReads;
      assert.equal(await exchange.authorizeRequestCredential(denied, signal), undefined);
      assert.equal(await exchange.resolveRequestCredential(grant(held), signal), undefined);
      assert.equal(f.secretReads, reads, "disabled readiness refuses before Secret access");
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS count FROM occ.request_credential_approvals WHERE request_id=$1",
            [denied.requestId],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(await marker(), false);
      // Only a new owned claim and plain readiness defer restores queued eligibility.
      await queue.defer(
        await claim(),
        { code: "REVISION_INCOMPLETE" },
        { delayMs: 1, recordEvidence: false },
      );
      assert.equal(await marker(), true);
      const restored = request();
      assert.equal(await exchange.authorizeRequestCredential(restored, signal), "credential");
      assert.equal(
        (await exchange.resolveRequestCredential(grant(restored), signal))?.value,
        "synthetic-key-initial",
      );
      assert.equal(await exchange.resolveRequestCredential(grant(restored), signal), undefined);
      t.diagnostic(
        JSON.stringify({
          disabling,
          workId: key,
          deniedRequestId: denied.requestId,
          restoredRequestId: restored.requestId,
          marker: await marker(),
        }),
      );
    },
  );
}

test(
  "a newer public admission refuses the older model candidate despite its live lease (PostgreSQL)",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const { f, revision, request, exchange, grant } = await requestCredentialFixture(t, {
      activateRevision: false,
    });
    const key = `agent_revision:${revision.id}:reconcile`;
    const claim = await claimIsolatedWork(f.pool, { workId: key });
    assert.equal(claim?.idempotencyKey, key);
    const signal = AbortSignal.timeout(20_000);
    const first = request();
    assert.equal(await exchange.authorizeRequestCredential(first, signal), "credential");
    const replacement = await f.deployAgent(f.namespace.id, f.agent.id);
    assert.notEqual(replacement.id, revision.id);
    // Admission alone supersedes model authority; do not activate either revision,
    // cancel the older claim, or change the old installation or source.
    const older = await new PostgresWorkQueue(f.pool).findWork(key);
    assert.equal(older?.leaseActive, true);
    const input = request();
    assert.equal(await exchange.authorizeRequestCredential(input, signal), undefined);
    const approvals = await f.pool.query(
      "SELECT request_id FROM occ.request_credential_approvals WHERE request_id = ANY($1::text[])",
      [[first.requestId, input.requestId]],
    );
    assert.deepEqual(
      approvals.rows.map((row) => row.request_id),
      [first.requestId],
    );
    const denied = await f.pool.query(
      `SELECT details->>'code' AS code, details->>'phase' AS phase FROM occ.audit_events
       WHERE namespace_id=$1 AND resource_id=$2 AND actor_id=$3
         AND kind='authorization_denial' AND action='openclaw.egress.authorize'
         AND details->>'revisionId'=$4 AND details->>'requestId'=$5`,
      [f.namespace.id, f.source.id, revision.servicePrincipalId, revision.id, input.requestId],
    );
    assert.deepEqual(denied.rows, [{ code: "withdrawn", phase: "before_access" }]);
    const reads = f.secretReads;
    assert.equal(await exchange.resolveRequestCredential(grant(first), signal), undefined);
    assert.equal(f.secretReads, reads, "supersession prevents release of an earlier approval");
    const path = `/namespaces/${f.namespace.id}/agents/${f.agent.id}`;
    assert.equal((await f.request("GET", path)).data.activeRevisionId ?? null, null);
    assert.equal(
      (await f.request("GET", `${path}/deployments/${revision.id}`)).data.status,
      "running",
    );
    t.diagnostic(
      JSON.stringify({
        phase: "newer admission",
        revisionId: revision.id,
        replacementId: replacement.id,
        workId: key,
        requestId: input.requestId,
        leased: true,
        activeRevisionId: null,
        status: "running",
        approvals: 0,
        denials: denied.rows,
      }),
    );
  },
);

test(
  "deferred model authority refuses expired recovered and terminal work before activation (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const { f, revision, exchange, request, grant } = await requestCredentialFixture(t, {
      activateRevision: false,
    });
    const key = `agent_revision:${revision.id}:reconcile`;
    const queue = new PostgresWorkQueue(f.pool);
    const signal = AbortSignal.timeout(50_000);
    const claim = async () => {
      const work = await queue.findWork(key);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, work!.availableAt.getTime() - Date.now()) + 20),
      );
      const selected = await claimIsolatedWork(f.pool, { workId: key });
      assert.ok(selected);
      return selected;
    };
    const approve = async () => {
      const input = request();
      assert.equal(await exchange.authorizeRequestCredential(input, signal), "credential");
      return input;
    };
    const refuse = async (held: ReturnType<typeof request>) => {
      const reads = f.secretReads;
      const input = request();
      assert.equal(await exchange.authorizeRequestCredential(input, signal), undefined);
      assert.equal(await exchange.resolveRequestCredential(grant(held), signal), undefined);
      assert.equal(await exchange.resolveRequestCredential(grant(input), signal), undefined);
      assert.equal(f.secretReads, reads, "refusal must occur before any material read");
    };
    const first = await claim();
    await queue.defer(first, { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
    const held = await approve();
    const expiring = await claim();
    // Real lease expiry after earlier readiness must not fall back to that old success.
    await new PostgresWorkQueue(f.pool, { leaseDurationMs: 1 }).heartbeat(expiring);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await queue.findWork(key))?.leaseActive, false);
    await refuse(held);
    await queue.recoverStale();
    assert.equal((await queue.findWorkAttempt(key))?.code, "LEASE_EXPIRED");
    assert.equal(
      (
        await f.pool.query(
          "SELECT readiness_deferred FROM occ.controller_work WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0].readiness_deferred,
      false,
    );
    await refuse(request());
    const recovered = await claim();
    const recoveredInput = await approve();
    assert.equal(
      (await exchange.resolveRequestCredential(grant(recoveredInput), signal))?.value,
      "synthetic-key-initial",
    );
    // A successful deferral with a different reason is not runtime-readiness authority.
    await queue.defer(recovered, { code: "WORKSPACE_NODE_PENDING" }, { delayMs: 1 });
    await refuse(request());
    const completing = await claim();
    const beforeCompletion = await approve();
    await queue.complete(completing);
    await refuse(beforeCompletion);
    // Terminal work does not revoke a revision that actually became active.
    await f.activateRevision(f.namespace.id, f.agent.id, revision.id);
    const active = await approve();
    assert.equal(
      (await exchange.resolveRequestCredential(grant(active), signal))?.value,
      "synthetic-key-initial",
    );
  },
);

test(
  "queued model approval retains work fencing and observes credential withdrawal on release (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t, { activateRevision: false });
    const { f, revision, exchange, request, grant } = fixture;
    const key = `agent_revision:${revision.id}:reconcile`;
    const queue = new PostgresWorkQueue(f.pool);
    const first = await claimIsolatedWork(f.pool, { workId: key });
    assert.ok(first);
    await queue.defer(first, { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
    const signal = AbortSignal.timeout(50_000);
    const input = request();
    const paused = fixture.pauseNextApprovalCommit();
    const approving = exchange.authorizeRequestCredential(input, signal);
    await paused.reached;
    try {
      // The real claim path skips work held by the approval transaction.
      assert.equal(await claimIsolatedWork(f.pool, { workId: key }), undefined);
    } finally {
      paused.release();
    }
    assert.equal(await approving, "credential");
    const reclaimed = await claimIsolatedWork(f.pool, { workId: key });
    assert.ok(reclaimed);
    await queue.defer(reclaimed, { code: "REVISION_INCOMPLETE" }, { delayMs: 1 });
    // Withdrawal requires an active revision. Keep the genuine work row queued while
    // activating, then use the public withdrawal operation; never invent a candidate API.
    await f.activateRevision(f.namespace.id, f.agent.id, revision.id);
    const materialPause = fixture.pauseMaterialRead();
    const resolving = exchange.resolveRequestCredential(grant(input), signal);
    await materialPause.reached;
    try {
      const withdrawn = await f.request(
        "POST",
        `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${f.source.id}/withdraw`,
      );
      assert.equal(withdrawn.status, 202, JSON.stringify(withdrawn.body));
    } finally {
      materialPause.release();
    }
    assert.equal(await resolving, undefined);
    const reads = f.secretReads;
    assert.equal(await exchange.authorizeRequestCredential(request(), signal), undefined);
    assert.equal(f.secretReads, reads);
    assert.equal((await queue.findWork(key))?.state, "queued");
  },
);

test(
  "candidate credential request survives benign work contention (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t, { activateRevision: false });
    const { f, revision, exchange, request, grant } = fixture;
    const key = `agent_revision:${revision.id}:reconcile`;
    const claim = await claimIsolatedWork(f.pool, { workId: key });
    assert.ok(claim);
    const contender = await f.pool.connect();
    const pause = fixture.pauseCandidateAttempt();
    try {
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '2s'");
      assert.ok(await new PostgresWorkQueue(contender).heartbeat(claim));
      const input = request();
      const signal = AbortSignal.timeout(15_000);
      const approving = exchange.authorizeRequestCredential(input, signal);
      await pause.reached;
      // The worker may acquire its owners after heartbeat, while the request backs
      // off. A retained Namespace lock would deadlock this real worker lock order.
      await contender.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [
        f.namespace.id,
      ]);
      await contender.query("SELECT id FROM occ.agents WHERE id=$1 FOR UPDATE", [f.agent.id]);
      const denials = await f.pool.query(
        "SELECT id FROM occ.audit_events WHERE details->>'requestId'=$1 AND kind='authorization_denial'",
        [input.requestId],
      );
      assert.equal(denials.rowCount, 0, "busy work is not withdrawn");
      assert.equal(
        (
          await f.pool.query(
            "SELECT request_id FROM occ.request_credential_approvals WHERE request_id=$1",
            [input.requestId],
          )
        ).rowCount,
        0,
      );
      await contender.query("COMMIT");
      pause.release();
      assert.equal(await approving, "credential");
      assert.equal(
        (await exchange.resolveRequestCredential(grant(input), signal))?.value,
        "synthetic-key-initial",
      );
      assert.equal(await exchange.resolveRequestCredential(grant(input), signal), undefined);
    } finally {
      pause.release();
      await contender.query("ROLLBACK");
      contender.release();
    }
  },
);

for (const phase of ["authorization", "consumed approval", "final release"] as const) {
  for (const outcome of [
    "benign",
    "terminal",
    "superseded",
    "withdrawn",
    "aborted",
    "expired",
    "rotated",
    "installation changed",
  ] as const) {
    test(
      `candidate work contention during ${phase}: ${outcome} (PostgreSQL)`,
      { ...requiresPostgres, timeout: 30_000 },
      async (t) => {
        const fixture = await requestCredentialFixture(t, { activateRevision: false });
        const { f, revision, exchange, request, grant } = fixture;
        const key = `agent_revision:${revision.id}:reconcile`;
        const claim = await claimIsolatedWork(f.pool, { workId: key });
        assert.ok(claim);
        const input = {
          ...request(),
          ...(outcome === "expired" && { deadlineAt: new Date(Date.now() + 1500).toISOString() }),
        };
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, t.signal]);
        if (phase !== "authorization") {
          assert.equal(await exchange.authorizeRequestCredential(input, signal), "credential");
        }
        const redemption = {
          ...grant(input),
          deadlineAt: new Date(Date.now() + 25_000).toISOString(),
        };
        const originalExpiry =
          phase === "authorization"
            ? undefined
            : (
                await f.pool.query(
                  "SELECT expires_at FROM occ.request_credential_approvals WHERE request_id=$1",
                  [input.requestId],
                )
              ).rows[0].expires_at;
        if (originalExpiry) {
          assert.ok(originalExpiry.getTime() < Date.parse(redemption.deadlineAt));
        }
        // On final release, preserve both original outside-lock material observations.
        // Stage contention only after the second read has captured the original value.
        const materialPause = phase === "final release" ? fixture.pauseMaterialRead(1) : undefined;
        let operation = materialPause
          ? exchange.resolveRequestCredential(redemption, signal)
          : undefined;
        if (materialPause) {
          await materialPause.reached;
        }
        const pause = fixture.pauseCandidateAttempt();
        const contender = await f.pool.connect();
        try {
          await contender.query("BEGIN");
          await contender.query("SET LOCAL lock_timeout = '2s'");
          const queue = new PostgresWorkQueue(contender);
          assert.ok(await queue.heartbeat(claim));
          operation ??=
            phase === "authorization"
              ? exchange.authorizeRequestCredential(input, signal)
              : exchange.resolveRequestCredential(redemption, signal);
          materialPause?.release();
          await Promise.race([
            pause.reached,
            operation.then(() => {
              throw new Error("request settled before observing contention");
            }),
          ]);
          // The complete policy transaction has rolled back. The worker can now
          // acquire owners in its real work -> Namespace -> Agent order.
          await contender.query("SAVEPOINT owner_lock_proof");
          await contender.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [
            f.namespace.id,
          ]);
          await contender.query("SELECT id FROM occ.agents WHERE id=$1 FOR UPDATE", [f.agent.id]);
          const denials = () =>
            f.pool.query(
              "SELECT details->>'code' AS code, details->>'phase' AS phase FROM occ.audit_events WHERE details->>'requestId'=$1 AND kind='authorization_denial'",
              [input.requestId],
            );
          assert.deepEqual(
            (await denials()).rows,
            [],
            "contention cannot invent withdrawal evidence",
          );
          const approvals = () =>
            f.pool.query(
              "SELECT consumed FROM occ.request_credential_approvals WHERE request_id=$1",
              [input.requestId],
            );
          assert.deepEqual(
            (await approvals()).rows,
            phase === "authorization" ? [] : [{ consumed: true }],
          );
          // Release just the owner-lock proof, retaining the real heartbeat lock.
          await contender.query("ROLLBACK TO SAVEPOINT owner_lock_proof");
          const reads = f.secretReads;
          if (outcome === "aborted" || outcome === "expired") {
            if (outcome === "aborted") {
              controller.abort();
            }
            if (outcome === "expired" && originalExpiry) {
              // Hold the external scheduling barrier past the persisted expiry. This
              // uses real elapsed time; the later grant deadline cannot renew approval.
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, originalExpiry.getTime() - Date.now()) + 30),
              );
            }
            pause.release();
            // The request's real absolute deadline/abort ends the wait while work
            // is still locked. Neither a restarted budget nor a commit releases it.
            assert.equal(await operation, undefined);
            if (outcome === "expired") {
              assert.ok(
                Date.now() >= Date.parse(input.deadlineAt) - 50,
                "busy work must wait for the original deadline, allowing timer rounding",
              );
            }
            assert.deepEqual((await denials()).rows, []);
            assert.equal(f.secretReads, reads);
          } else {
            if (outcome === "terminal") {
              await queue.fail(claim, { code: "CONVERGENCE_DEADLINE_EXCEEDED" });
            }
            await contender.query("COMMIT");
            if (outcome === "superseded") {
              await f.deployAgent(f.namespace.id, f.agent.id);
            } else if (outcome === "withdrawn") {
              await f.activateRevision(f.namespace.id, f.agent.id, revision.id);
              const result = await f.request(
                "POST",
                `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${f.source.id}/withdraw`,
              );
              assert.equal(result.status, 202);
            } else if (outcome === "rotated") {
              const result = await f.request(
                "PATCH",
                `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`,
                { body: { value: "synthetic-key-replacement" } },
              );
              assert.equal(result.status, 200);
            } else if (outcome === "installation changed") {
              fixture.setInstallation({
                ...fixture.installation,
                enforcement: { ...fixture.installation.enforcement, policyHash: "b".repeat(64) },
              });
            }
            pause.release();
            const result = await operation;
            const allowed =
              outcome === "benign" || (outcome === "rotated" && phase !== "final release");
            let expected: string | undefined;
            if (allowed) {
              expected =
                outcome === "rotated" ? "synthetic-key-replacement" : "synthetic-key-initial";
              if (phase === "authorization") {
                expected = "credential";
              }
            }
            assert.equal(typeof result === "object" ? result?.value : result, expected);
            if (outcome === "benign" && originalExpiry && typeof result === "object") {
              assert.ok(result);
              assert.ok(Date.parse(result.usableUntil) <= originalExpiry.getTime());
            }
            if (!allowed && outcome !== "installation changed") {
              assert.equal((await denials()).rowCount, 1);
            }
          }
          if (originalExpiry) {
            const current = (
              await f.pool.query(
                "SELECT expires_at, expires_at <= clock_timestamp() AS expired FROM occ.request_credential_approvals WHERE request_id=$1",
                [input.requestId],
              )
            ).rows[0];
            assert.equal(current.expires_at.getTime(), originalExpiry.getTime());
            if (outcome === "expired") {
              assert.equal(current.expired, true);
              assert.ok(Date.now() < Date.parse(redemption.deadlineAt));
            }
          }
          const expectedApprovals = [];
          if (phase !== "authorization") {
            expectedApprovals.push({ consumed: true });
          } else if (outcome === "benign" || outcome === "rotated") {
            expectedApprovals.push({ consumed: false });
          }
          assert.deepEqual((await approvals()).rows, expectedApprovals);
          if (phase !== "authorization") {
            assert.equal(
              await exchange.resolveRequestCredential(grant(input), AbortSignal.timeout(2000)),
              undefined,
              "consumption is never replayed",
            );
          }
        } finally {
          materialPause?.release();
          pause.release();
          await contender.query("ROLLBACK");
          contender.release();
          await operation;
        }
      },
    );
  }
}

test(
  "active model authorization ignores busy candidate work (PostgreSQL)",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const { f, revision, request, exchange, grant } = await requestCredentialFixture(t);
    const claim = await claimIsolatedWork(f.pool, {
      workId: `agent_revision:${revision.id}:reconcile`,
    });
    assert.ok(claim);
    const contender = await f.pool.connect();
    try {
      await contender.query("BEGIN");
      assert.ok(await new PostgresWorkQueue(contender).heartbeat(claim));
      const input = request();
      const signal = AbortSignal.timeout(2000);
      assert.equal(await exchange.authorizeRequestCredential(input, signal), "credential");
      assert.equal(
        (await exchange.resolveRequestCredential(grant(input), signal))?.value,
        "synthetic-key-initial",
      );
    } finally {
      await contender.query("ROLLBACK");
      contender.release();
    }
  },
);
