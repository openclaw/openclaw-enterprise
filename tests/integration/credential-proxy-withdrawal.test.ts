import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProxyDriver,
  AcceptedEgressAssociation,
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
  reduceCredentialPolicy,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { requestId, staticEgressFixture } from "../helpers/static-egress.mjs";

test(
  "policy reduction preserves another binding then observes deny-all (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    let state!: PlatformStateStore;
    let api!: Awaited<ReturnType<typeof postgresApp>>["request"];
    let restart!: () => void;
    let sourceB = "";
    let owner!: InstalledDriver;
    let compute!: ReturnType<typeof createTestKubernetesComputeDriver>;
    const fixtureOptions = {
      admitRevision: false,
      appFactory: async (context: TestContext, options: object = {}) => {
        const app = await postgresApp(context, options);
        api = app.request;
        state = app.state;
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
          policyReduction: {
            version: 1,
            apply: (...args) => reducer.apply(...args),
            observe: (...args) => reducer.observe(...args),
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
    const deployed = await baseFixture.deployAgent(baseFixture.namespace.id, baseFixture.agent.id);
    const revision = await state.read((view) =>
      view.revisions.findRevision(baseFixture.namespace.id, baseFixture.agent.id, deployed.id),
    );
    assert.ok(revision?.egressPlan);
    await baseFixture.activateRevision(baseFixture.namespace.id, baseFixture.agent.id, revision.id);
    const f = { ...baseFixture, revision };
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
    let wrongRecipient = false;
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
            operationId,
            installation: {
              ...snapshot(),
              ...(wrongRecipient ? { sandboxId: "replacement" } : {}),
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    let beforeApply = async () => {};
    let afterObserve = async () => {};
    const reducer: CredentialPolicyReducer = {
      version: 1,
      async apply(_context, request) {
        await beforeApply();
        const result = await fetch(`${base}/reduce`, {
          method: "POST",
          body: JSON.stringify(request),
        });
        assert.equal(result.status, 204);
      },
      async observe() {
        const observation = await (await fetch(`${base}/observe`)).json();
        await afterObserve();
        return observation;
      },
    };
    await state.transact((unit) => unit.credentialSources.recordEgressInstallation(snapshot()));
    const signal = AbortSignal.timeout(50_000);
    const reduce = async (sourceId: string, coordinated = true) => {
      const source = await state.read((view) =>
        view.credentialSources.findCredentialSource(f.namespace.id, sourceId),
      );
      assert.ok(source);
      const result = await compute.withdrawCredentialSource(
        revision,
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
    await withdraw(f.source.id);
    await assert.rejects(reduce(f.source.id, false), {
      code: "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
    });
    assert.equal(applies, 0, "a missing coordinator cannot consume the operation");
    beforeApply = async () => {
      const withdrawal = await state.read((view) =>
        view.credentialSources.findCredentialWithdrawal(f.namespace.id, revision.id, f.source.id),
      );
      assert.ok(withdrawal, "OCC commits withdrawal before the peer receives any reduction");
      assert.ok(withdrawal.policyReduction, "the original operation is durable before apply");
      assert.equal(await platformAllows(f.source.id), false, "OCC denies A before provider action");
      assert.equal(await platformAllows(sourceB), true, "B retains its exact admission");
    };
    await assert.rejects(reduce(f.source.id), /fetch failed/);
    assert.equal(applies, 1);
    await request(f.source.id, 403);
    await request(sourceB, 200);
    restart();
    beforeApply = async () => {};
    wrongRecipient = true;
    assert.deepEqual(await Promise.all([reduce(f.source.id), reduce(f.source.id)]), [
      "pending",
      "pending",
    ]);
    const pending = await state.read((view) =>
      view.credentialSources.findCredentialWithdrawal(f.namespace.id, f.revision.id, f.source.id),
    );
    assert.equal(pending?.policyReduction?.request.operationId, operationId);
    assert.equal(
      pending?.policyReduction?.observed,
      undefined,
      "a wrong-recipient observation is not proof",
    );
    wrongRecipient = false;
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
