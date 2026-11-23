import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type {
  CredentialProviderDefinition,
  ComputeDriver,
  CredentialGatewayDriver,
  EgressInstallation,
} from "../../packages/contracts/src/index.ts";
import type {
  OpenClawController,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { CredentialProxy } from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";

function editProviderCatalog(t: TestContext, catalog: readonly CredentialProviderDefinition[]) {
  const providers = catalog as CredentialProviderDefinition[];
  const saved = [...providers];
  t.after(() => providers.splice(0, providers.length, ...saved));
  const original = providers.find((provider) => provider.sourceType.type === "openai");
  assert.ok(original, "the fixture registers an OpenAI provider");
  return { providers, original };
}

function editProviderSlot(t: TestContext, catalog: readonly CredentialProviderDefinition[]) {
  const providers = catalog as CredentialProviderDefinition[];
  const index = providers.findIndex((provider) => provider.sourceType.type === "openai");
  const original = providers[index];
  assert.ok(original, "the fixture registers an OpenAI provider");
  t.after(() => {
    providers[index] = original;
  });
  return { providers, index, original };
}

test("classification diagnostics reject contradictory reports and preserve audit-write refusal", async (t) => {
  // This checks the shared registry's provider and audit ports. The PostgreSQL
  // egress case separately proves signed transport and persisted attribution.
  const f = await syntheticDispatchFixture(t, new EgressSendReceipts(new InMemoryPlatformState()));
  const ports = f.ports;
  const peer = await ports.exchangeOwner.verify("synthetic-peer");
  assert.ok(peer);
  const installed = await ports.installation(peer);
  assert.ok(installed);
  const route = installed.plan.routes[0]!;
  const original = ports.provider(route);
  assert.ok(original && original !== "ambiguous");
  const scenarios = [
    { name: "single report", reports: [[4]], audit: true },
    { name: "zero", reports: [[0]] },
    { name: "above range", reports: [[256]] },
    { name: "noninteger", reports: [[1.5]] },
    { name: "nonfinite", reports: [[NaN]] },
    { name: "repeated", reports: [[4, 4]] },
    { name: "two reporters", reports: [[4], [4]] },
    { name: "competing repeated reporter", reports: [[4], [4, 4]] },
    { name: "competing invalid reporter", reports: [[4], [0]] },
    { name: "report and accept", reports: [[4]], accept: true },
    { name: "audit unavailable", reports: [[4]], audit: true, writeFails: true },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const routes = scenario.reports.map((_, index) => ({
        ...route,
        route: { ...route.route, id: `route-${index}` },
      }));
      const provider: CredentialProviderDefinition = {
        ...original,
        classify(candidate, request, refused) {
          for (const rule of scenario.reports[routes.indexOf(candidate)]!) {
            refused?.(rule);
          }
          return original.classify(candidate, request);
        },
      };
      const observed: { id: string; rule: number }[] = [];
      const proxy = new CredentialProxy({
        ...ports,
        installation: async () => ({ ...installed, plan: { ...installed.plan, routes } }),
        provider: () => provider,
        classificationRefused: async (use, rule) => {
          observed.push({ id: use.id, rule });
          if (scenario.writeFails) {
            throw new Error("Synthetic audit port unavailable");
          }
        },
      });
      const request = {
        ...f.request,
        body: Buffer.from(
          JSON.stringify({ model: "fixture-model", input: "hello", store: !scenario.accept }),
        ),
      };
      const reads = f.reads;
      const result = await proxy.resolve(
        "synthetic-peer",
        peer.sandboxId,
        request,
        AbortSignal.timeout(5_000),
      );
      assert.deepEqual(observed, scenario.audit ? [{ id: request.id, rule: 4 }] : []);
      if (scenario.accept) {
        assert.equal(result.kind, "ready");
        assert.equal(f.reads, reads + 1);
      } else {
        assert.deepEqual(result, {
          kind: "refused",
          error: scenario.writeFails
            ? { kind: "unavailable", code: "authority" }
            : { kind: "denied", code: "unsupported_operation" },
        });
        assert.equal(f.reads, reads);
      }
      assert.equal(f.arrivals, 0);
    });
  }
});

test("credential exchange refuses a conflicted eligible provider before route fallback", async (t) => {
  const view: { installation?: (installation: EgressInstallation) => EgressInstallation } = {};
  const f = await staticEgressFixture(t, {
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        wrapState: (state: PlatformStateStore): PlatformStateStore => ({
          read: (work) =>
            state.read((unit) =>
              work({
                ...unit,
                credentialSources: {
                  ...unit.credentialSources,
                  async findEgressInstallation(...args) {
                    const installation = await unit.credentialSources.findEgressInstallation(
                      ...args,
                    );
                    return installation && view.installation
                      ? view.installation(installation)
                      : installation;
                  },
                },
              }),
            ),
          transact: (work) => state.transact(work),
        }),
      }),
  });
  assert.ok("egress" in f);
  const { providers, original } = editProviderCatalog(t, f.egress.sourceControl.providers);
  let classifiers = 0;
  const healthy: CredentialProviderDefinition = {
    ...original,
    classify(...args) {
      classifiers += 1;
      return Reflect.apply(original.classify, this, args);
    },
  };
  const conflicted = { ...healthy, ref: { ...original.ref, id: "alternate-inference" } };
  providers.splice(0, providers.length, healthy, conflicted);
  const routeB = f.installation.plan.routes.find((route) => route.path.endsWith("/responses"));
  assert.ok(routeB);
  // Model an admitted multi-source installation at the storage boundary. The stock fixture
  // Driver deliberately cannot admit one; the controller's lookup and resolution remain real.
  const routeA = {
    ...routeB,
    route: { ...routeB.route, id: randomUUID() },
    binding: {
      ...routeB.binding,
      binding: { ...routeB.binding.binding, id: randomUUID() },
      source: {
        ...routeB.binding.source,
        source: { ...routeB.binding.source.source, id: randomUUID() },
        provider: conflicted.ref,
      },
    },
  };
  view.installation = (installation) => ({
    ...installation,
    plan: { ...installation.plan, routes: [routeA, ...installation.plan.routes] },
  });
  const resolve = () => f.resolve(f.capture());
  const duplicate = { ...conflicted, ref: { ...conflicted.ref, label: "conflicting label" } };
  providers.push(duplicate);
  classifiers = 0;
  const reads = f.secretReads;
  const unbound = await resolve();
  assert.ok(unbound.refused);
  assert.equal(classifiers, 0, "eligible provider conflicts must refuse before classification");
  assert.equal(f.secretReads, reads);
  providers.pop();
  let swaps = 0;
  let replacementClassifiers = 0;
  const replacement = {
    ...healthy,
    classify(...args: Parameters<CredentialProviderDefinition["classify"]>) {
      replacementClassifiers += 1;
      return Reflect.apply(original.classify, this, args);
    },
  };
  conflicted.classify = function (...args) {
    swaps += 1;
    providers[providers.indexOf(healthy)] = replacement;
    return Reflect.apply(original.classify, this, args);
  };
  assert.ok((await resolve()).refused);
  assert.equal(swaps, 1);
  assert.equal(replacementClassifiers, 0);
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);

  // The dispatch fixture supplies a controlled policy decision so this positive control can
  // reach material selection with a multi-route installation and an explicit healthy binding.
  const synthetic = await syntheticDispatchFixture(
    t,
    new EgressSendReceipts(new InMemoryPlatformState()),
  );
  const ports = synthetic.ports;
  const syntheticPeer = await ports.exchangeOwner.verify("synthetic-peer");
  assert.ok(syntheticPeer);
  const installed = await ports.installation(syntheticPeer);
  assert.ok(installed);
  const healthyRoute = installed.plan.routes[0]!;
  const conflictedBinding = randomUUID();
  const explicit = new CredentialProxy({
    ...ports,
    installation: async () => ({
      ...installed,
      plan: {
        ...installed.plan,
        routes: [
          {
            ...healthyRoute,
            binding: {
              ...healthyRoute.binding,
              binding: { ...healthyRoute.binding.binding, id: conflictedBinding },
            },
          },
          healthyRoute,
        ],
      },
    }),
    provider: (route) =>
      route.binding.binding.id === conflictedBinding ? "ambiguous" : ports.provider(route),
  });
  const bound = await explicit.resolve(
    "synthetic-peer",
    syntheticPeer.sandboxId,
    {
      ...synthetic.request,
      bindingId: healthyRoute.binding.binding.id,
    },
    AbortSignal.timeout(5_000),
  );
  assert.equal(bound.kind, "ready", "an explicit healthy binding excludes the conflicted route");
  assert.equal(synthetic.reads, 1);
});

test("static deployment refuses ambiguous or incompatible providers without redirecting its exact binding", async (t) => {
  const f = await staticEgressFixture(t, { admitRevision: false });
  const { providers, original } = editProviderCatalog(t, f.egress.sourceControl.providers);
  const alternate = { ...original, ref: { ...original.ref, id: "another-provider" } };
  const deploy = () =>
    f.request("POST", `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`);
  const controller: OpenClawController = f.controller;
  const reads = f.countSecretReads();

  // Source admission succeeded. A changed catalog cannot redirect the saved reference.
  const incompatible: CredentialProviderDefinition = {
    ...original,
    sourceType: {
      ...original.sourceType,
      harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" },
    },
  };
  const duplicateDuringPlanning: CredentialProviderDefinition = {
    ...original,
    normalizeGrant(...args) {
      const grant = original.normalizeGrant.apply(this, args);
      providers.push(original);
      return grant;
    },
  };
  const changedLifecycle: CredentialProviderDefinition = {
    ...original,
    sourceType: { ...original.sourceType },
    routes(...args) {
      const routes = original.routes.apply(this, args);
      Reflect.set(this.sourceType, "rotation", "refresh");
      return routes;
    },
  };
  // A valid plan must not survive replacement while OCC finishes admission.
  const replacedAfterPlanning = { ...original };
  const compute = controller.selectedDriver("compute");
  const validate = compute.validateExecutionAdmission;
  assert.ok(validate);
  t.after(() => {
    compute.validateExecutionAdmission = validate;
  });
  compute.validateExecutionAdmission = function (...args) {
    validate.apply(this, args);
    if (providers[0] === replacedAfterPlanning) {
      providers[0] = original;
    }
  };
  for (const [reason, entries, status] of [
    ["replaced after plan construction", [replacedAfterPlanning], 409],
    ["duplicated while building the grant", [duplicateDuringPlanning], 409],
    ["incompatible while building routes", [changedLifecycle], 409],
    ["missing", [alternate], 503],
    ["duplicate", [original, { ...original }], 409],
    ["managed login", [incompatible], 409],
    [
      "different type",
      [{ ...original, sourceType: { ...original.sourceType, type: "other" } }],
      409,
    ],
  ] as const) {
    providers.splice(0, providers.length, ...entries);
    const response = await deploy();
    const revisions = await controller.transact((unit) =>
      unit.revisions.listRevisionMetadata(f.namespace.id, f.agent.id),
    );
    assert.deepEqual(
      { status: response.status, revisions: revisions.length, reads: f.countSecretReads() - reads },
      { status, revisions: 0, reads: 0 },
      reason,
    );
  }
  // First deployment can create transport Secrets outside the revision transaction.
  // Change the registration during the real Kubernetes status read, after planning.
  const { placement } = f;
  const provision = t.mock.fn(placement.provisionAgentRuntimeCredentials.bind(placement));
  const binding = { namespace: f.namespace, agent: f.agent };
  const transportConfigured = async () =>
    (await placement.getAgentRuntimeCredentialStatus(binding)).transportConfigured;
  const stored = f.countStoredSecrets();
  let changeProvider = true;
  Object.assign(compute, {
    requiresAgentRuntimeCredentials: true,
    async getAgentRuntimeCredentialStatus(input) {
      const status = await placement.getAgentRuntimeCredentialStatus(input);
      if (changeProvider) {
        providers[0] = replacedAfterPlanning;
      }
      return status;
    },
    provisionAgentRuntimeCredentials: provision,
  } satisfies Partial<ComputeDriver>);
  providers.splice(0, providers.length, original);
  assert.equal(await transportConfigured(), false);
  const refused = await deploy();
  const revisions = await controller.transact((unit) =>
    unit.revisions.listRevisionMetadata(f.namespace.id, f.agent.id),
  );
  assert.deepEqual(
    {
      status: refused.status,
      revisions: revisions.length,
      provisions: provision.mock.callCount(),
      newSecrets: f.countStoredSecrets() - stored,
      transport: await transportConfigured(),
    },
    { status: 409, revisions: 0, provisions: 0, newSecrets: 0, transport: false },
  );
  assert.equal(f.countSecretReads(), reads);
  changeProvider = false;
  providers.splice(0, providers.length, alternate, original);
  const healthy = await deploy();
  assert.equal(healthy.status, 202);
  assert.equal(provision.mock.callCount(), 1);
  assert.equal(await transportConfigured(), true);
  const revision = await controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, healthy.data.id),
  );
  assert.deepEqual(revision?.egressPlan?.routes[0]?.binding.source.provider, original.ref);
});

test("credential exchange refuses duplicate and substituted providers before material access", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const { providers, original } = editProviderCatalog(t, f.egress.sourceControl.providers);
  const duplicate = { ...original, ref: { ...original.ref, label: "conflicting label" } };
  const reads = f.secretReads;
  for (const entries of [
    [original, duplicate],
    [duplicate, original],
  ]) {
    providers.splice(0, providers.length, ...entries);
    assert.ok((await f.resolve(f.capture())).refused);
  }

  // A matching reference alone does not authorize a different credential lifecycle.
  for (const sourceType of [
    { ...original.sourceType, type: "other" },
    {
      ...original.sourceType,
      harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" },
    },
  ] as const) {
    providers.splice(0, providers.length, { ...original, sourceType });
    const result = await f.resolve(f.capture());
    assert.deepEqual(
      { refused: Boolean(result.refused), reads: f.secretReads - reads },
      { refused: true, reads: 0 },
    );
  }

  let substituteClassifications = 0;
  const substitute = {
    ...original,
    classify(...args: Parameters<CredentialProviderDefinition["classify"]>) {
      substituteClassifications += 1;
      return Reflect.apply(original.classify, this, args);
    },
  };
  const selected = {
    ...original,
    classify(...args: Parameters<CredentialProviderDefinition["classify"]>) {
      assert.equal(this, selected);
      providers.splice(0, providers.length, substitute);
      return Reflect.apply(original.classify, this, args);
    },
  };
  providers.splice(0, providers.length, selected);
  assert.ok((await f.resolve(f.capture())).refused);
  assert.equal(substituteClassifications, 0);
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);
});

test("credential exchange refuses provider replacement during a pending Secret read", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const { providers, index, original } = editProviderSlot(t, f.egress.sourceControl.providers);
  let substituteCalls = 0;
  const replacement = {
    ...original,
    classify(...args: Parameters<CredentialProviderDefinition["classify"]>) {
      substituteCalls += 1;
      return Reflect.apply(original.classify, this, args);
    },
    inject(...args: Parameters<CredentialProviderDefinition["inject"]>) {
      substituteCalls += 1;
      return Reflect.apply(original.inject, this, args);
    },
  };
  const reads = f.secretReads;
  const release = f.pauseSecretReads();
  t.after(release);
  const captured = f.capture();
  const pending = f.resolve(captured);
  try {
    const until = Date.now() + 5_000;
    while (f.secretReads === reads && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(f.secretReads, reads + 1, "the real Secret endpoint has received the read");
    providers[index] = replacement;
  } finally {
    release();
  }
  const result = await pending;
  assert.ok(result.refused);
  assert.equal(result.ready, undefined);
  assert.equal(substituteCalls, 0);
  assert.equal(f.providerRequests.length, 0);
});

test("credential exchange withholds a response after provider method replacement", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const index = providers.findIndex((entry) => entry.sourceType.type === "openai");
  const registered = providers[index];
  assert.ok(registered, "the fixture registers an OpenAI provider");
  let classifications = 0;
  let injections = 0;
  const provider: CredentialProviderDefinition = {
    ...registered,
    classify(...args) {
      assert.equal(this, provider);
      classifications += 1;
      return Reflect.apply(registered.classify, this, args);
    },
    inject(...args) {
      assert.equal(this, provider);
      injections += 1;
      return Reflect.apply(registered.inject, this, args);
    },
  };
  providers[index] = provider;
  t.after(() => {
    providers[index] = registered;
  });
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready);
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
  assert.ok(classifications >= 2);
  assert.equal(injections, 1);
  assert.equal(f.providerRequests.length, 0, "permission does not dispatch the request");
  const upstream = await f.send(captured, ready);
  assert.equal(f.providerRequests.length, 1);
  let substituteCalls = 0;
  provider.protectResponse = function (...args) {
    substituteCalls += 1;
    return Reflect.apply(registered.protectResponse, this, args);
  };
  assert.deepEqual(await f.protect(captured, upstream), { blocked: true });
  assert.equal(
    substituteCalls,
    0,
    "a replacement must not receive the upstream response or credential",
  );
});

test("credential exchange preserves the original possible-send receipt after provider drift", async (t) => {
  const hooks: { afterAuthorize?: () => void } = {};
  let attempt: Parameters<PlatformUnitOfWork["egressSendReceipts"]["find"]>[0] | undefined;
  const f = await staticEgressFixture(t, {
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        wrapState: (state: PlatformStateStore): PlatformStateStore => ({
          read: (work) => state.read(work),
          transact: (work) =>
            state.transact((unit) =>
              work({
                ...unit,
                egressSendReceipts: {
                  ...unit.egressSendReceipts,
                  async authorize(...args) {
                    const receipt = await unit.egressSendReceipts.authorize(...args);
                    attempt = args[0];
                    hooks.afterAuthorize?.();
                    return receipt;
                  },
                },
              }),
            ),
        }),
      }),
  });
  assert.ok("egress" in f);
  const { providers, index, original } = editProviderSlot(t, f.egress.sourceControl.providers);
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready);
  const reads = f.secretReads;
  hooks.afterAuthorize = () => {
    providers[index] = { ...original };
  };
  const result = await f.authorize(f.permitRequest(captured, ready));
  assert.ok(result.refused);
  assert.equal(result.allowed, undefined);
  assert.ok(attempt);
  const receipt = await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.egressSendReceipts.find(attempt!),
  );
  assert.ok(receipt?.authorization);
  assert.equal(receipt.settled, false);
  assert.deepEqual(receipt.outcome, { kind: "uncertain", dispatch: "possible" });
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);
});

test("credential exchange withholds an observed response after provider replacement", async (t) => {
  const hooks: { afterObservation?: () => void } = {};
  const f = await staticEgressFixture(t, {
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        wrapState: (state: PlatformStateStore): PlatformStateStore => ({
          read: (work) => state.read(work),
          transact: (work) =>
            state.transact((unit) =>
              work({
                ...unit,
                egressSendReceipts: {
                  ...unit.egressSendReceipts,
                  async save(...args) {
                    const receipt = await unit.egressSendReceipts.save(...args);
                    hooks.afterObservation?.();
                    return receipt;
                  },
                },
              }),
            ),
        }),
      }),
  });
  assert.ok("egress" in f);
  const { providers, index, original } = editProviderSlot(t, f.egress.sourceControl.providers);
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready);
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
  const upstream = await f.send(captured, ready);
  let observations = 0;
  hooks.afterObservation = () => {
    observations += 1;
    providers[index] = { ...original };
  };
  assert.deepEqual(await f.protect(captured, upstream), { blocked: true });
  assert.equal(observations, 1);
  assert.equal(f.providerRequests.length, 1);
});

test("credential exchange cuts a cached stream lease after provider replacement", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const { providers, index, original } = editProviderSlot(t, f.egress.sourceControl.providers);
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready);
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
  await f.send(captured, ready);
  const progress = { head_received: true, body_bytes: 1 };
  assert.ok("renew_by" in (await f.progress(captured, progress)));
  providers[index] = { ...original };
  assert.deepEqual(await f.progress(captured, progress), { refused: true });
  assert.equal(f.providerRequests.length, 1);
});

test("capability discovery omits only conflicting static provider types", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const { providers, original } = editProviderCatalog(t, f.egress.sourceControl.providers);
  const gateway: CredentialGatewayDriver = f.controller.selectedDriver("credential_gateway");
  const catalog = await gateway.listSourceTypes({ signal: AbortSignal.timeout(1000) });
  const model = catalog.find((entry) => entry.type === "openai")!;
  t.mock.method(gateway, "listSourceTypes", async () => [
    ...catalog,
    { ...model, type: "healthy-model" },
  ]);
  providers.push(
    { ...original },
    {
      ...original,
      ref: { ...original.ref, id: "healthy-model" },
      sourceType: { ...original.sourceType, type: "healthy-model" },
    },
  );
  for (const path of ["/installation", `/namespaces/${f.namespace.id}/agent-capabilities`]) {
    const response = await f.request("GET", path);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const types = response.data.capabilities.credentialSources.types.map(
      (entry: { type: string }) => entry.type,
    );
    assert.equal(types.includes("openai"), false);
    assert.equal(types.includes("healthy-model"), true);
  }
});

test("capability discovery omits Gateway lifecycle mismatches", async (t) => {
  const f = await staticEgressFixture(t);
  const gateway: CredentialGatewayDriver = f.controller.selectedDriver("credential_gateway");
  const catalog = await gateway.listSourceTypes({ signal: AbortSignal.timeout(1000) });
  const original = catalog.find((entry) => entry.type === "openai")!;
  for (const changed of [
    { ...original, rotation: "refresh" as const },
    { ...original, deviceAuthorization: { harnessId: "codex" } },
    {
      ...original,
      harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" as const },
    },
  ]) {
    const mock = t.mock.method(gateway, "listSourceTypes", async () =>
      catalog.map((entry) => (entry.type === "openai" ? changed : entry)),
    );
    const visible = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
    assert.equal(visible.status, 200);
    assert.equal(
      visible.data.capabilities.credentialSources.types.some(
        (entry: { type: string }) => entry.type === "openai",
      ),
      false,
    );
    mock.mock.restore();
  }
});
