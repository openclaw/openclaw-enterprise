import assert from "node:assert/strict";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TestContext } from "node:test";
import type {
  Agent,
  Namespace,
  SecretReference,
  SecretDriver,
  CredentialProxyDriver,
  EgressInstallation,
  RequestCredentialInput,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  resolveCredentialProxyCapacity,
  OpenClawController,
  PostgresPlatformState,
  type PlatformStateStore,
  type ControllerOptions,
  type CredentialProxyCapacity,
} from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createOpenAiRequestProvider,
  createOpenAiStaticProvider,
} from "../../apps/controller/src/drivers/egress-proxy/openai-provider.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { staticEgressFixture } from "./static-egress.mjs";
import { postgresApp } from "./postgres-egress-app.mjs";

/** Real API/IAM/PostgreSQL/Secret Driver with controlled external runtime observation.
 * No installed OpenShell or workload execution is represented by this fixture. */
export async function requestCredentialFixture(
  t: TestContext,
  configuration: {
    credentialProxyCapacity?: Partial<CredentialProxyCapacity>;
    poolOptions?: { options: string };
    bindExchange?: CredentialProxyDriver["bindExchange"];
  } = {},
) {
  let owner!: InstalledDriver;
  let principalId!: string;
  let state!: PlatformStateStore;
  let pool!: Awaited<ReturnType<typeof postgresApp>>["pool"];
  let live: EgressInstallation | undefined;
  let nextVerification: { reached: () => void; release: Promise<void> } | undefined;
  const sandboxId = randomUUID();
  const options = {
    ...configuration,
    admitRevision: false,
    driverConfigurations: [
      {
        capability: "sandbox" as const,
        driverId: "request-policy-fixture",
        implementation: "request-policy-fixture",
        definition: OpenShellSandboxDriver,
      },
    ],
    appFactory: async (context: TestContext, options: object = {}) => {
      const app = await postgresApp(context, {
        ...options,
        recordOperations: true,
        poolOptions: configuration.poolOptions,
      });
      state = app.state;
      pool = app.pool;
      principalId = app.principal.id;
      return app;
    },
    async admitSource({
      app,
      agent,
      namespace,
      secret,
      path,
      origin,
    }: {
      app: Awaited<ReturnType<typeof postgresApp>>;
      agent: Agent;
      namespace: Namespace;
      secret: { ref: SecretReference };
      path: string;
      origin: string;
    }) {
      const original = app.controller.selectedDriver("credential_proxy");
      const sandbox = new Proxy(app.controller.selectedDriver("sandbox"), {
        get(target, key) {
          if (key === "id" || key === "implementation") {
            return "request-policy-fixture";
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      // This fixture supplies only the external installation/recipient observation.
      // Production provider classification, IAM, approval persistence and Secret reads run below.
      const proxy: CredentialProxyDriver = {
        id: "request-policy-fixture",
        implementation: "request-policy-fixture",
        capability: "credential_proxy",
        ...(configuration.bindExchange && { bindExchange: configuration.bindExchange }),
        sourceControl: {
          ...original.sourceControl,
          providers: [createOpenAiRequestProvider(), ...original.sourceControl.providers],
        },
        requestTimeCredentials: {
          async assertAvailable(signal) {
            assert.equal(signal.aborted, false);
          },
          async verifyRequestInstallation(
            { namespace: ns, revision, plan },
            installation,
            recipient,
          ) {
            const paused = nextVerification;
            nextVerification = undefined;
            paused?.reached();
            await paused?.release;
            return (
              live !== undefined &&
              recipient.id === live.sandboxId &&
              ns.id === live.plan.execution.namespaceId &&
              revision.id === live.plan.execution.revisionId &&
              isDeepStrictEqual(plan, live.plan) &&
              isDeepStrictEqual(installation, live)
            );
          },
        },
        async configureRevision(context) {
          return { plan: context.plan, configuration: {} };
        },
        async wiringStatus() {
          return live;
        },
        async verifyInstallation(context, installation) {
          return (
            isDeepStrictEqual(context.plan, live?.plan) && isDeepStrictEqual(installation, live)
          );
        },
        async removeRevision() {
          return false;
        },
      };
      owner = new InstalledDriver(
        { id: proxy.id, implementation: proxy.implementation, configuration: {} },
        {
          capabilities: { sandbox, credential_proxy: proxy },
          namespaceLifecycleHooks: sandboxNamespaceLifecycleBinding(
            app.controller.selectedDriver("compute"),
            sandbox,
          ).hooks,
        },
      );
      app.controller.installDriver(owner, ["sandbox", "credential_proxy"]);
      const createSource = async (name: string, authorization?: "online-request") => {
        const response = await app.request("POST", path, {
          body: {
            name,
            type: "openai",
            ...(authorization && { authorization }),
            config: { authorized_base_url: `${origin}/v1` },
            secrets: { api_key: secret.ref },
          },
        });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return response.data;
      };
      const strict = await createSource("default-remains-strict");
      const strictSource = await state.read((unit) =>
        unit.credentialSources.findCredentialSource(namespace.id, strict.id),
      );
      assert.deepEqual(
        strictSource?.egress?.key.provider,
        createOpenAiStaticProvider().ref,
        "putting the online provider first must not change default admission",
      );
      const source = await createSource("explicit-online-model", "online-request");
      // Updates retain the admitted provider even when the catalog presents a different profile first.
      for (const [selected, expected] of [
        [strict, createOpenAiStaticProvider().ref],
        [source, createOpenAiRequestProvider().ref],
      ] as const) {
        const updated = await app.request("PATCH", `${path}/${selected.id}`, {
          body: { secrets: { api_key: secret.ref } },
        });
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
        const stored = await state.read((unit) =>
          unit.credentialSources.findCredentialSource(namespace.id, selected.id),
        );
        assert.deepEqual(stored?.egress?.key.provider, expected);
      }
      const result = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: {
          configurationId: agent.configurationId,
          harnessAuth: { method: "credential_source", sourceId: source.id },
          credentialSources: [{ sourceId: source.id }],
        },
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return { agent: result.data, source };
    },
  };
  const f = Object.assign(await staticEgressFixture(t, options), { pool });
  assert.ok("pauseNextSecretRead" in f);
  let materialPause:
    | {
        skip: number;
        reached: () => void;
        release: Promise<void>;
        settled: () => void;
      }
    | undefined;
  const secretDriver: SecretDriver = f.controller.selectedDriver("secret");
  const readMaterial = secretDriver.readCredentialInput!.bind(secretDriver);
  // Preserve the real Secret Driver's result while modeling a dependency that ignores
  // cancellation after its I/O. The controller must still release its policy locks.
  secretDriver.readCredentialInput = async (input) => {
    const result = await readMaterial(input);
    const paused = materialPause;
    if (paused && paused.skip-- === 0) {
      materialPause = undefined;
      paused.reached();
      await paused.release;
      paused.settled();
    }
    return result;
  };
  const deployment = await f.deployAgent(f.namespace.id, f.agent.id);
  const revision = await state.read((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, deployment.id),
  );
  assert.ok(revision?.egressPlan);
  assert.deepEqual(revision.executionAdmission, { mode: "protected", version: 8 });
  assert.equal(revision.egressPlan.authorization, "online-request");
  assert.equal(revision.egressPlan.routes.length, 1);
  const route = revision.egressPlan.routes[0]!;
  live = {
    plan: revision.egressPlan,
    sandboxId,
    sender: owner.require("credential_proxy").sourceControl.sender,
    installedAt: new Date().toISOString(),
    enforcement: {
      instanceId: randomUUID(),
      configurationId: "request-policy",
      policyHash: "a".repeat(64),
      authorityScope: "execution",
    },
  };
  await state.transact((unit) => unit.credentialSources.recordEgressInstallation(live!));
  await f.activateRevision(f.namespace.id, f.agent.id, revision.id);
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
  const exchange = f.controller.createCredentialProxy(transport);
  const request = (): RequestCredentialInput => ({
    requestId: randomUUID(),
    bindingId: route.binding.binding.id,
    recipient: { id: sandboxId },
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    replayUntilAt: new Date(Date.now() + 3_600_000).toISOString(),
    execution: { namespaceId: f.namespace.id, agentId: f.agent.id, revisionId: revision.id },
    http: {
      target: {
        reportedScheme: "https",
        host: new URL(route.origin).hostname,
        port: Number(new URL(route.origin).port || 443),
        method: "POST",
        path: route.path,
        query: "",
      },
      headers: [["content-type", "application/json"]],
      body: Buffer.from(JSON.stringify({ model: "fixture-model", input: "hello", store: false })),
    },
  });
  const grant = (input: RequestCredentialInput) => ({
    recipientId: input.recipient.id,
    requestId: input.requestId,
    bindingId: input.bindingId,
    deadlineAt: input.deadlineAt,
  });
  const restartController = (
    credentialProxyCapacity = configuration.credentialProxyCapacity,
    authorize?: ControllerOptions["authorize"],
    pool = f.pool,
    now?: ControllerOptions["now"],
  ) => {
    const capacity = resolveCredentialProxyCapacity(
      { ...credentialProxyCapacity },
      "requestCapacity",
    );
    assert.ok(capacity.capacity);
    const restartedState = new PostgresPlatformState(pool);
    const restarted = new OpenClawController(f.controller.installation, {
      state: restartedState,
      ...(authorize && { authorize }),
      ...(now && { now }),
      driverConfigurations: options.driverConfigurations,
      credentialProxyCapacity: capacity.capacity,
    });
    const iam = new NativeIAMDriver(restartedState, { id: "request-restarted-iam" });
    restarted.registerDriver(iam);
    restarted.selectDriver("iam", iam.id);
    for (const capability of [
      "compute",
      "configuration",
      "secret",
      "credential_gateway",
    ] as const) {
      const driver = f.controller.selectedDriver(capability);
      restarted.registerDriver(driver);
      restarted.selectDriver(capability, driver.id);
    }
    restarted.installDriver(owner, ["sandbox", "credential_proxy"]);
    return restarted;
  };
  const pauseMaterialRead = (skip = 0) => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    materialPause = {
      skip,
      reached: reached.resolve,
      release: release.promise,
      settled: settled.resolve,
    };
    return { reached: reached.promise, release: release.resolve, settled: settled.promise };
  };
  return {
    f,
    owner,
    revision,
    exchange,
    request,
    grant,
    restartController,
    principalId,
    pauseNextApprovalCommit() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const policyState = state;
      assert.ok(policyState instanceof PostgresPlatformState);
      const original = policyState.transactReadCommitted.bind(policyState);
      let pending = true;
      policyState.transactReadCommitted = (work) =>
        original((unit) =>
          work({
            ...unit,
            requestCredentialApprovals: {
              ...unit.requestCredentialApprovals,
              async insert(...args) {
                const inserted = await unit.requestCredentialApprovals.insert(...args);
                if (pending && inserted) {
                  pending = false;
                  reached.resolve();
                  await release.promise;
                }
                return inserted;
              },
            },
          }),
        );
      return { reached: reached.promise, release: release.resolve };
    },
    pauseFinalPolicyLock() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let checks = 0;
      const policyState = state;
      assert.ok(policyState instanceof PostgresPlatformState);
      for (const method of ["transact", "transactReadCommitted"] as const) {
        const original = policyState[method].bind(policyState);
        policyState[method] = (work) =>
          original((unit) =>
            work({
              ...unit,
              namespaces: {
                ...unit.namespaces,
                async lockNamespace(...args) {
                  // Both real transactions have established their snapshot before this lock.
                  if (++checks === 2) {
                    reached.resolve();
                    await release.promise;
                  }
                  return unit.namespaces.lockNamespace(...args);
                },
              },
            }),
          );
      }
      return { reached: reached.promise, release: release.resolve };
    },
    pauseMaterialRead,
    pauseFinalMaterialRead() {
      return pauseMaterialRead(2);
    },
    pauseNextVerification() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      nextVerification = { reached: reached.resolve, release: release.promise };
      return { reached: reached.promise, release: release.resolve };
    },
    get installation() {
      return live!;
    },
    setInstallation(value: EgressInstallation) {
      live = value;
    },
  };
}
