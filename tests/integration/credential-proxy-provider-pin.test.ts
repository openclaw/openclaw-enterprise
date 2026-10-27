import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  CredentialProviderDefinition,
  EgressInstallation,
  EgressRequest,
} from "../../packages/contracts/src/index.ts";
import type { PlatformStateStore, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import {
  CredentialProxy,
  type EgressAuthorityPorts,
} from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { staticEgressFixture, syntheticDispatchFixture } from "../helpers/static-egress.mjs";

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
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const saved = [...providers];
  t.after(() => providers.splice(0, providers.length, ...saved));
  const original = providers.find((provider) => provider.sourceType.type === "openai")!;
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
  const ports = synthetic.ports as unknown as EgressAuthorityPorts;
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
      ...(synthetic.request as unknown as EgressRequest),
      bindingId: healthyRoute.binding.binding.id,
    },
    AbortSignal.timeout(5_000),
  );
  assert.equal(bound.kind, "ready", "an explicit healthy binding excludes the conflicted route");
  assert.equal(synthetic.reads, 1);
});

test("credential exchange refuses duplicate and substituted providers before material access", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const saved = [...providers];
  t.after(() => providers.splice(0, providers.length, ...saved));
  const original = providers.find((provider) => provider.sourceType.type === "openai")!;
  const duplicate = { ...original, ref: { ...original.ref, label: "conflicting label" } };
  const reads = f.secretReads;
  for (const entries of [
    [original, duplicate],
    [duplicate, original],
  ]) {
    providers.splice(0, providers.length, ...entries);
    assert.ok((await f.resolve(f.capture())).refused);
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
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const index = providers.findIndex((provider) => provider.sourceType.type === "openai");
  const original = providers[index]!;
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
  t.after(() => {
    providers[index] = original;
  });
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
  const registered = providers[index]!;
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
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const index = providers.findIndex((provider) => provider.sourceType.type === "openai");
  const original = providers[index]!;
  t.after(() => {
    providers[index] = original;
  });
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
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const index = providers.findIndex((provider) => provider.sourceType.type === "openai");
  const original = providers[index]!;
  t.after(() => {
    providers[index] = original;
  });
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
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const index = providers.findIndex((provider) => provider.sourceType.type === "openai");
  const original = providers[index]!;
  t.after(() => {
    providers[index] = original;
  });
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

test("an unbound source update keeps its admitted provider when same-type providers reorder", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const saved = [...providers];
  t.after(() => providers.splice(0, providers.length, ...saved));
  const original = providers.find((entry) => entry.sourceType.type === "openai")!;
  const validations: string[] = [];
  const instrument = (id: string): CredentialProviderDefinition => ({
    ...original,
    ref: { ...original.ref, id },
    inject(value) {
      assert.equal(value, "synthetic-key-initial");
      validations.push(this.ref.id);
      return original.inject.call(this, value);
    },
  });
  const a = instrument("source-verifier-a");
  const b = instrument("source-verifier-b");
  providers.splice(0, providers.length, a, b);
  const body = { name: "unbound", type: "openai", secrets: { api_key: f.secret.ref } };
  const created = await f.request("POST", f.path, { body });
  assert.equal(created.status, 201);
  const { id } = created.data;
  const update = () => f.request("PATCH", `${f.path}/${id}`, { body: { secrets: body.secrets } });
  const savedAdmission = () =>
    f.controller.transact(
      async (unit: PlatformUnitOfWork) =>
        (await unit.credentialSources.findCredentialSource(f.namespace.id, id))?.egress?.key,
    );
  assert.deepEqual((await savedAdmission())?.provider, a.ref);
  providers.reverse();
  const reads = f.secretReads;
  const updated = await update();
  assert.equal(updated.status, 200);
  const key = await savedAdmission();
  assert.deepEqual(
    { validations, provider: key?.provider.id, generation: key?.source.generation },
    { validations: [a.ref.id, a.ref.id], provider: a.ref.id, generation: 2 },
  );
  assert.equal(f.secretReads, reads + 1);
  // Same-type B alone cannot replace A. Two registrations for A's key cannot speak for it either.
  for (const entries of [[b], [a, { ...b, ref: a.ref }]]) {
    providers.splice(0, providers.length, ...entries);
    const refused = await update();
    assert.equal(refused.status, 409);
    if (entries.length > 1) {
      assert.deepEqual(refused.body.error, {
        code: "RESOURCE_CONFLICT",
        message:
          "The admitted credential provider has duplicate registrations. Ask an Installation administrator to resolve them.",
      });
    }
    assert.equal(f.secretReads, reads + 1);
    assert.deepEqual(await savedAdmission(), key);
    assert.deepEqual(validations, [a.ref.id, a.ref.id]);
  }
  assert.equal(f.providerRequests.length, 0);
});

test("a source update withholds resolved material after its provider or injector changes", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("egress" in f);
  const providers = f.egress.sourceControl.providers as CredentialProviderDefinition[];
  const index = providers.findIndex((entry) => entry.sourceType.type === "openai");
  const original = providers[index]!;
  t.after(() => {
    providers[index] = original;
  });
  let originalCalls = 0;
  let replacementCalls = 0;
  const a: CredentialProviderDefinition = {
    ...original,
    normalizeConfig(config) {
      assert.equal(this, a);
      return Reflect.apply(original.normalizeConfig, this, [config]);
    },
    inject(value) {
      assert.equal(this, a);
      assert.equal(value, "synthetic-key-initial");
      originalCalls += 1;
      return original.inject.call(this, value);
    },
  };
  const approvedInject = a.inject;
  const approvedNormalize = a.normalizeConfig;
  const b: CredentialProviderDefinition = {
    ...a,
    inject(value) {
      replacementCalls += 1;
      return original.inject.call(this, value);
    },
  };
  providers[index] = a;
  const body = { name: "unbound", type: "openai", secrets: { api_key: f.secret.ref } };
  const created = await f.request("POST", f.path, { body });
  assert.equal(created.status, 201);
  const { id } = created.data;
  const update = () => f.request("PATCH", `${f.path}/${id}`, { body: { secrets: body.secrets } });
  const savedSource = () =>
    f.controller.transact((unit: PlatformUnitOfWork) =>
      unit.credentialSources.findCredentialSource(f.namespace.id, id),
    );
  const before = await savedSource();
  assert.deepEqual(before?.egress?.key.provider, a.ref);
  assert.equal(originalCalls, 1);
  for (const change of ["injector", "registration"]) {
    const reads: number = f.secretReads;
    const release = f.pauseSecretReads();
    const pending = update();
    try {
      const until = Date.now() + 5_000;
      while (f.secretReads === reads && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(f.secretReads, reads + 1);
      if (change === "injector") {
        a.inject = b.inject;
      } else {
        providers[index] = b;
      }
    } finally {
      release();
    }
    const result = await pending;
    assert.deepEqual(
      { status: result.status, originalCalls, replacementCalls },
      { status: 409, originalCalls: 1, replacementCalls: 0 },
      change,
    );
    assert.deepEqual(await savedSource(), before);
    assert.equal(f.providerRequests.length, 0);
    a.inject = approvedInject;
  }
  providers[index] = a;
  a.normalizeConfig = function (config) {
    providers[index] = b;
    return original.normalizeConfig.call(this, config);
  };
  const reads = f.secretReads;
  const name = "refused-create";
  const createRefused = await f.request("POST", f.path, { body: { ...body, name } });
  providers[index] = a;
  const updateRefused = await update();
  for (const result of [createRefused, updateRefused]) {
    assert.equal(result.status, 409);
    assert.deepEqual(result.body.error, {
      code: "RESOURCE_CONFLICT",
      message:
        "The selected credential provider changed during admission. Check the Installation's provider configuration before retrying this credential-source request.",
    });
  }
  const sources = await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.listCredentialSources(f.namespace.id),
  );
  assert.equal(
    sources.some((source: { name: string }) => source.name === name),
    false,
  );
  assert.equal(f.secretReads, reads, "a replacement before access must prevent the Secret read");
  assert.deepEqual([originalCalls, replacementCalls], [1, 0]);
  assert.deepEqual(await savedSource(), before);

  providers[index] = a;
  a.normalizeConfig = approvedNormalize;
  let normalizerCallLookups = 0;
  let injectorCallLookups = 0;
  let materialExposed = false;
  assert.equal(Object.hasOwn(approvedNormalize, "call"), false);
  assert.equal(Object.hasOwn(approvedInject, "call"), false);
  t.after(() => {
    Reflect.deleteProperty(approvedNormalize, "call");
    Reflect.deleteProperty(approvedInject, "call");
  });
  Object.defineProperty(approvedNormalize, "call", {
    configurable: true,
    value(receiver: CredentialProviderDefinition, config: Readonly<Record<string, string>>) {
      normalizerCallLookups += 1;
      return Reflect.apply(approvedNormalize, receiver, [config]);
    },
  });
  const heldReads = f.secretReads;
  const release = f.pauseSecretReads();
  const pending = update();
  try {
    const until = Date.now() + 5_000;
    while (f.secretReads === heldReads && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(f.secretReads, heldReads + 1);
    // The approved function identity is unchanged while its own call property is replaced.
    Object.defineProperty(approvedInject, "call", {
      configurable: true,
      value(_receiver: CredentialProviderDefinition, value: string) {
        injectorCallLookups += 1;
        materialExposed = value === "synthetic-key-initial";
      },
    });
    assert.equal(a.inject, approvedInject);
  } finally {
    release();
  }
  const accepted = await pending;
  assert.deepEqual(
    {
      status: accepted.status,
      originalCalls,
      replacementCalls,
      normalizerCallLookups,
      injectorCallLookups,
      materialExposed,
    },
    {
      status: 200,
      originalCalls: 2,
      replacementCalls: 0,
      normalizerCallLookups: 0,
      injectorCallLookups: 0,
      materialExposed: false,
    },
  );
  assert.equal(f.providerRequests.length, 0);
});
