import { randomUUID } from "node:crypto";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";

const fixtures = new WeakMap();

/** Real memory State for Driver protocol tests; production queue authority is tested separately. */
export async function namespaceLifecycleFixture(driver, namespace, target = "ready") {
  let namespaces = fixtures.get(driver);
  if (namespaces === undefined) {
    namespaces = new Map();
    fixtures.set(driver, namespaces);
  }
  let saved = namespaces.get(namespace.id);
  if (saved === undefined) {
    const state = new InMemoryPlatformState();
    const record = await state.transact(async (unit) => {
      await unit.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "Namespace lifecycle fixture",
        createdAt: namespace.createdAt,
      });
      await unit.namespaces.createNamespace(namespace);
      const initial = await unit.namespaces.findLifecycle(namespace.id);
      return unit.namespaces.bindLifecycle(namespace.id, initial.lifecycleId, driver);
    });
    saved = { state, record };
    namespaces.set(namespace.id, saved);
  }
  const { state, record } = saved;
  return {
    lifecycleId: record.lifecycleId,
    target,
    signal: new AbortController().signal,
    read: () =>
      state.transact(async (unit) => {
        const current = await unit.namespaces.findLifecycle(namespace.id);
        return { revision: current.revision, data: current.data };
      }),
    checkpoint: (expected, data) =>
      state.transact(async (unit) => {
        const current = await unit.namespaces.checkpointLifecycle(
          namespace.id,
          record.lifecycleId,
          expected,
          data,
        );
        if (current === undefined) {
          throw new Error("Fixture Namespace checkpoint revision changed.");
        }
        return { revision: current.revision, data: current.data };
      }),
  };
}

/** Public target identities supplied by controlled Kubernetes SDK fixtures, not live cluster proof. */
export function namespaceLifecycleClients(clients, plane = "execution") {
  return {
    ...clients,
    lifecycleTarget: { server: `https://${plane}.example.test`, trust: `fixture-${plane}-trust` },
  };
}

/** Seed an earlier completed preparation, like the existing prepared revision fixtures.
 * This is a persisted-state fixture, not proof of preparation or provider behavior.
 */
export async function preparedKubernetesNamespaceLifecycle(
  driver,
  namespace,
  physical,
  { infrastructure = [], gateway } = {},
) {
  const originalIds = new Map(
    [physical, ...infrastructure, ...(gateway === undefined ? [] : [gateway])].map((resource) => {
      resource.metadata.uid ??= `fixture-original-${resource.kind}-${resource.metadata.name}`;
      resource.metadata.resourceVersion ??= "1";
      return [resource, resource.metadata.uid];
    }),
  );
  const { KubernetesNamespaceJournal } =
    await import("../../apps/controller/src/drivers/compute/kubernetes/namespace-lifecycle.ts");
  const lifecycle = await namespaceLifecycleFixture(driver, namespace, "ready");
  const execution = await driver.clients("execution");
  const control = await driver.clients("control");
  execution.lifecycleTarget ??= {
    server: "https://execution.example.test",
    trust: "fixture-execution-trust",
  };
  control.lifecycleTarget ??= {
    server: "https://control.example.test",
    trust: "fixture-control-trust",
  };
  const sandbox = driver.sandboxDriver;
  const placement = {
    name: physical.metadata.name,
    plane: "execution",
    external: namespace.existingNamespace !== undefined,
  };
  const journal = await KubernetesNamespaceJournal.open(lifecycle, {
    execution: execution.lifecycleTarget,
    control: control.lifecycleTarget,
    placement,
    ...(sandbox === undefined
      ? {}
      : { sandbox: { id: sandbox.id, implementation: sandbox.implementation } }),
  });
  const identify = (resource) => {
    resource.metadata.uid ??= `fixture-original-${resource.kind}-${resource.metadata.name}`;
    resource.metadata.resourceVersion ??= "1";
    resource.metadata.annotations = {
      ...resource.metadata.annotations,
      "openclaw.dev/lifecycle-id": lifecycle.lifecycleId,
    };
    return { nonce: lifecycle.lifecycleId, uid: originalIds.get(resource) };
  };
  await journal.save({
    namespace: {
      ...identify(physical),
      ...(namespace.existingNamespace === undefined ? {} : { claim: "complete" }),
    },
    ...(gateway === undefined ? {} : { gateway: identify(gateway) }),
    infrastructure: infrastructure.map((resource) => ({
      kind: resource.kind,
      name: resource.metadata.name,
      uid: identify(resource).uid,
    })),
  });
  if (sandbox !== undefined) {
    const child = journal.sandboxContext(sandbox);
    const current = await child.read();
    await child.checkpoint(current.revision, { fixturePrepared: true });
  }
  return { ...lifecycle, target: "deleted" };
}
