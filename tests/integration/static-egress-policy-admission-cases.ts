import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ProxyRevisionContext } from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { staticEgressFixture as staticEgressFixtureJs } from "../helpers/static-egress.mjs";

type ConsoleAppFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
export type ConsoleOptions = NonNullable<Parameters<typeof createConsoleAppFixture>[1]>;
type ConsoleResponse = Omit<Awaited<ReturnType<ConsoleAppFixture["request"]>>, "body" | "data"> & {
  body: unknown;
  data: unknown;
};
export type ConsoleFixture = Omit<ConsoleAppFixture, "controller" | "request"> & {
  controller: OpenClawController;
  request: (...args: Parameters<ConsoleAppFixture["request"]>) => Promise<ConsoleResponse>;
};
type JsFixture = Awaited<ReturnType<typeof staticEgressFixtureJs>>;
type JsDeployedFixture = Extract<JsFixture, { fixtureKind: "deployed" }>;
type JsUndeployedFixture = Extract<JsFixture, { fixtureKind: "undeployed" }>;
type DeployedFixture = Pick<
  JsDeployedFixture,
  | "fixtureKind"
  | "namespace"
  | "runtimeNamespace"
  | "attachment"
  | "egress"
  | "installation"
  | "observed"
  | "providerRequests"
  | "secretReads"
  | "sandboxDriver"
  | "capture"
  | "resolve"
  | "authorize"
  | "permitRequest"
> & {
  controller: OpenClawController;
  revision: unknown;
  context: unknown;
  providers: ReadonlyMap<string, unknown>;
  createAgent?: ConsoleAppFixture["createAgent"];
  deployAgent: ConsoleAppFixture["deployAgent"];
};
type UndeployedFixture = Pick<JsUndeployedFixture, "fixtureKind" | "namespace"> & {
  controller: OpenClawController;
  agent: unknown;
  request: (
    ...args: Parameters<ConsoleAppFixture["request"]>
  ) => Promise<{ status: number; body: unknown }>;
};
type AppFactory = (
  context: TestContext,
  options?: ConsoleOptions,
  transportDatabaseUrl?: string,
) => Promise<ConsoleFixture>;
interface StaticEgressFactory {
  (
    context: TestContext,
    options: { admitRevision: false; appFactory: AppFactory },
  ): Promise<UndeployedFixture>;
  (
    context: TestContext,
    options?: { admitRevision?: true; recordInstallation?: boolean; inertProviderRule?: boolean },
  ): Promise<DeployedFixture>;
}
export const staticEgressFixture: StaticEgressFactory = staticEgressFixtureJs;

export async function deployedContext(f: DeployedFixture): Promise<ProxyRevisionContext> {
  const fixture = asRecord(f);
  const controller = fixture?.controller;
  const original = asRecord(fixture?.revision);
  assert.ok(controller instanceof OpenClawController && original, "deployed fixture revision");
  const id = original.id;
  const agentId = original.agentId;
  assert.ok(typeof id === "string" && typeof agentId === "string", "fixture revision identity");
  const revision = await controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, agentId, id),
  );
  assert.ok(revision?.egressPlan, "stored fixture revision with a protected plan");
  assert.deepEqual(revision, original, "the typed state read must preserve the fixture input");
  // Narrow the original JS context against the stored revision before sending it to a Driver.
  const context: unknown = f.context;
  const signal = asRecord(context)?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(context, {
    namespace: f.runtimeNamespace,
    revision,
    plan: revision.egressPlan,
    signal,
  });
  return context;
}

function record(value: unknown, label: string): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, label);
  return result;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function arrayIndex(key: string, length: number, allowAppend: boolean): number {
  assert.match(key, /^(0|[1-9][0-9]*)$/);
  const index = Number(key);
  assert.ok(
    Number.isSafeInteger(index) && index < length + Number(allowAppend),
    "observation array index",
  );
  return index;
}

// Malformed observations can add a leaf or append to an array, but must traverse
// the real fixture's existing containers rather than silently constructing them.
function mutateObservation(
  observation: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const fields = path.split(".");
  const key = fields.pop();
  assert.ok(key);
  let parent: unknown = observation;
  for (const field of fields) {
    if (isUnknownArray(parent)) {
      parent = parent[arrayIndex(field, parent.length, false)];
    } else {
      const object = record(parent, `observation parent ${field}`);
      assert.ok(Object.hasOwn(object, field), `missing observation parent ${field}`);
      parent = object[field];
    }
  }
  if (isUnknownArray(parent)) {
    const index = arrayIndex(key, parent.length, true);
    if (value === undefined) {
      delete parent[index];
    } else {
      parent[index] = value;
    }
  } else {
    const object = record(parent, `observation leaf ${key}`);
    if (value === undefined) {
      delete object[key];
    } else {
      object[key] = value;
    }
  }
}

export function registerPolicyAdmissionCases(): void {
  test("retained Sandbox policy versions are independent of plan generation but still fence installation", async (t) => {
    const f = await staticEgressFixture(t, { recordInstallation: false });
    const context = await deployedContext(f);
    const observed = record(f.observed, "fixture observation");
    const evidence = record(observed.evidence, "fixture enforcement evidence");
    assert.equal(context.plan.generation, 1);
    observed.policyVersion = 4;
    observed.activePolicyVersion = 4;
    evidence.policy_version = 4;
    const installed = await f.egress.wiringStatus(context, f.attachment);
    assert.ok(installed, "matching loaded policy must enroll after retained-Sandbox updates");
    assert.equal(await f.egress.verifyInstallation(context, installed), true);

    // Independent supplier fields must agree; none can borrow the OCE generation
    // or claim readiness for a policy that is still loading or failed.
    for (const change of [
      { policyVersion: 1 },
      { activePolicyVersion: 1 },
      { policyStatus: 1 },
      { policyStatus: 3 },
      { policyVersion: 0, activePolicyVersion: 0 },
    ]) {
      Object.assign(observed, change);
      assert.equal(await f.egress.wiringStatus(context, f.attachment), undefined);
      assert.equal(await f.egress.verifyInstallation(context, installed), false);
      Object.assign(observed, { policyVersion: 4, activePolicyVersion: 4, policyStatus: 2 });
    }
    evidence.policy_version = 1;
    assert.equal(await f.egress.wiringStatus(context, f.attachment), undefined);
    assert.equal(await f.egress.verifyInstallation(context, installed), false);

    // Even unchanged policy content at a new supplier version invalidates the
    // earlier receipt; changing the comparison must not remove that fence.
    observed.policyVersion = 5;
    observed.activePolicyVersion = 5;
    evidence.policy_version = 5;
    assert.equal(await f.egress.verifyInstallation(context, installed), false);
    const replacement = await f.egress.wiringStatus(context, f.attachment);
    assert.ok(replacement);
    assert.notEqual(replacement.enforcement.configurationId, installed.enforcement.configurationId);
    assert.equal(await f.egress.verifyInstallation(context, replacement), true);
  });

  test("V1 permits only the exact inert runtime rule and fences both policies before Secret access and send", async (t) => {
    const f = await staticEgressFixture(t, { inertProviderRule: true });
    const context = await deployedContext(f);
    const observed = record(f.observed, "fixture observation");
    const observation = structuredClone(record(observed.observation, "loaded policy observation"));
    const originalEvidence = structuredClone(
      record(observed.evidence, "fixture enforcement evidence"),
    );
    const source = structuredClone(record(observed.policy, "source policy"));
    const ruleName = observation.inert_provider_rule;
    assert.ok(typeof ruleName === "string", "inert provider rule name");
    assert.notEqual(observation.source_policy_hash, originalEvidence.policy_hash);
    assert.equal(observation.source_policy_hash, observed.policyHash);
    assert.deepEqual(
      record(
        record(observation.effective_policy, "effective policy").network_policies,
        "network policies",
      )[ruleName],
      { name: ruleName },
    );
    assert.equal(await f.egress.verifyInstallation(context, f.installation), true);
    const capture = f.capture();
    const ready = (await f.resolve(capture)).ready;
    assert.ok(ready, "the real consumer accepts the passive source != effective wire fixture");
    assert.ok((await f.authorize(f.permitRequest(capture, ready))).allowed);
    const reads = f.secretReads;
    // Each independently malformed derivation must refuse installation and current
    // authority before the versioned Secret Driver is called.
    const endpoint = { host: "unexpected.example.test", ports: [443] };
    const inert = `effective_policy.network_policies.${ruleName}`;
    const route = "effective_policy.network_policies.oce-egress-0.endpoints";
    const mutations: [string, unknown][] = [
      ["source_policy_hash", "4d".repeat(32)],
      ["effective_policy", undefined],
      ["inert_provider_rule", ""],
      ["inert_provider_rule", `${ruleName}_other`],
      [`${inert}.name`, "other"],
      [`${inert}.endpoints`, [endpoint]],
      [`${inert}.binaries`, [{ path: "/usr/bin/extra" }]],
      [
        inert,
        { name: ruleName, endpoints: [endpoint], binaries: [{ path: "/usr/bin/model-client" }] },
      ],
      [`${route}.1`, endpoint],
      ["effective_policy.network_policies.extra", {}],
      ["effective_policy.process.run_as_user", "0"],
      ["effective_policy.filesystem.read_write", ["/"]],
      ["effective_policy.landlock.compatibility", "best_effort"],
      ["effective_policy.version", 2],
      [`${route}.0.rules`, [Buffer.from([0])]],
      [
        "effective_policy.network_middlewares.oce-egress.config",
        { fields: { enabled: { bool_value: false } } },
      ],
    ];
    for (const [path, value] of mutations) {
      const changed = structuredClone(observation);
      mutateObservation(changed, path, value);
      observed.observation = changed;
      assert.equal(await f.egress.wiringStatus(context, f.attachment), undefined);
      assert.ok((await f.resolve(f.capture())).refused, path);
      assert.equal(f.secretReads, reads, "a widened or stale observation cannot read a Secret");
    }
    observed.observation = structuredClone(observation);
    // Individually valid replacement identities/policies still cannot replace the
    // saved installation fence, even when source and effective change together.
    for (const change of [
      () => {
        record(observed.evidence, "fixture enforcement evidence").policy_hash = "5e".repeat(32);
      },
      () => {
        observed.policyHash = "6f".repeat(32);
        record(observed.observation, "loaded policy observation").source_policy_hash =
          observed.policyHash;
      },
      () => {
        record(record(observed.policy, "source policy").process, "source process").run_as_user =
          "2000";
        record(
          record(
            record(observed.observation, "loaded policy observation").effective_policy,
            "effective policy",
          ).process,
          "effective process",
        ).run_as_user = "2000";
      },
    ]) {
      change();
      assert.ok((await f.resolve(f.capture())).refused);
      assert.equal(f.secretReads, reads);
      observed.evidence = structuredClone(originalEvidence);
      observed.policyHash = observation.source_policy_hash;
      observed.policy = structuredClone(source);
      observed.observation = structuredClone(observation);
    }
    assert.equal(await f.egress.verifyInstallation(context, f.installation), true);
    const sendCapture = f.capture();
    const sendReady = (await f.resolve(sendCapture)).ready;
    assert.ok(sendReady, "Resolve succeeds while the runtime rule is still inert");
    // Widen after material resolution: the fresh send check must reject a usable
    // endpoint even though this operation already holds valid access evidence.
    const liveObservation = record(observed.observation, "loaded policy observation");
    const effective = record(liveObservation.effective_policy, "effective policy");
    const widenedRule = record(
      record(effective.network_policies, "network policies")[ruleName],
      "inert rule",
    );
    const protectedRule = record(
      record(source.network_policies, "source network policies")["oce-egress-0"],
      "protected rule",
    );
    widenedRule.endpoints = structuredClone(protectedRule.endpoints);
    widenedRule.binaries = structuredClone(protectedRule.binaries);
    assert.ok((await f.authorize(f.permitRequest(sendCapture, sendReady))).refused);
    assert.equal(
      f.providerRequests.length,
      0,
      "send-side widening must not permit a provider send",
    );
  });
}
