import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  loseHelmResponseWithCompletedHook,
  recoverHelm,
} from "../helpers/production-upgrade-completed-hook.ts";
import {
  assertHelmIntent,
  assertPrivateReceipt,
  evidenceFiles,
  runWithInjectedFault,
} from "../helpers/production-upgrade-recovery-evidence.ts";
import type {
  RecoveryFixture,
  RecoveryFixtureFactory,
} from "../helpers/production-upgrade-recovery-fixture.ts";
import { yamlFile } from "../helpers/production-upgrade-recovery-render.ts";
import {
  list,
  requireRecoveryPreflight,
  type RecoveryState,
} from "../helpers/production-upgrade-recovery-state.ts";
import {
  controller,
  injectedFault,
  newController,
} from "../helpers/production-upgrade-recovery-tools.ts";
import { loadYaml } from "../helpers/qa-utils.mjs";

type ContainerPlacement = "containers" | "initContainers";
type FixtureOptions = NonNullable<Parameters<RecoveryFixtureFactory>[1]>;

function requiredRecord(value: unknown, message: string) {
  const record = asRecord(value);
  assert.ok(record, message);
  return record;
}

function preflightCount(state: RecoveryState) {
  const preflight = requireRecoveryPreflight(state);
  return list(preflight.created, "preflight creation history").length;
}

function resource(state: RecoveryState, key: string) {
  return requiredRecord(
    asRecord(state.recoveryResources)?.[key],
    `expected the live recovery resource ${key}`,
  );
}

function templateSpec(spec: unknown) {
  const template = asRecord(asRecord(spec)?.template);
  return requiredRecord(template?.spec, "expected the workload Pod template spec");
}

function array(value: unknown, message: string): unknown[] {
  assert.ok(Array.isArray(value), message);
  return value;
}

function firstContainer(spec: unknown, placement: ContainerPlacement) {
  const containers = array(asRecord(spec)?.[placement], `expected Pod ${placement}`);
  return requiredRecord(containers[0], `expected a container in ${placement}`);
}

function apiEnvironment(state: RecoveryState) {
  const api = resource(state, "Deployment/openclaw-enterprise-api");
  return array(
    firstContainer(templateSpec(api.spec), "containers").env,
    "expected the API container environment",
  );
}

// These cases run the upgrade script against controlled Helm and Kubernetes
// responses. The disposable-cluster proof checks Helm itself.
export function registerHelmRollbackCases({ fixture }: { fixture: RecoveryFixtureFactory }): void {
  async function interruptedUpgradeWithCompletedHook(
    t: TestContext,
    initializationResources?: FixtureOptions["initializationResources"],
  ) {
    const f = await fixture(t, {
      recoveryHooks: true,
      ...(initializationResources === undefined ? {} : { initializationResources }),
    });
    const state = await loseHelmResponseWithCompletedHook(f);
    return { f, state };
  }

  async function assertRecoveryRefusedBeforeRollback(
    f: RecoveryFixture,
    state: RecoveryState,
    refusal: RegExp,
    run: (...args: string[]) => Promise<unknown> = f.run,
  ) {
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const created = preflightCount(state);
    await assert.rejects(run(...recoverHelm), refusal);
    assert.equal(preflightCount(await f.state()), created);
    assert.equal((await f.state()).rollbackSubmissions, undefined);
    assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
  }

  // Clearing this proxy is an allowed candidate-values change. Stock Helm can
  // leave its old NetworkPolicy behind when interrupted before ordinary updates.
  async function interruptedProxyRemoval(t: TestContext, selectedProxy = "") {
    const f = await fixture(t, { recoveryHooks: true });
    const values = requiredRecord(
      await yamlFile(join(f.directory, "values.json")),
      "expected Helm values",
    );
    values.api = { ...asRecord(values.api), channelDirectoryProxyUrl: "http://198.51.100.25:3128" };
    for (const file of ["values.json", "live-values"]) {
      await writeFile(join(f.directory, file), JSON.stringify(values));
    }
    const candidate = structuredClone(values);
    requiredRecord(
      candidate.api,
      "expected API values after staging the predecessor",
    ).channelDirectoryProxyUrl = selectedProxy;
    const candidatePath = join(f.directory, "remove-proxy.json");
    await writeFile(candidatePath, JSON.stringify(candidate), { mode: 0o600 });
    const policy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "openclaw-enterprise-api-channel-directory-egress",
        namespace: "system",
        uid: "old-egress-policy",
        resourceVersion: "1",
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ ipBlock: { cidr: "198.51.100.25/32" } }],
            ports: [{ protocol: "TCP", port: 3128 }],
          },
        ],
      },
    };
    const state = await f.state();
    state.recoveryBaselineResources = selectedProxy ? [] : [policy];
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const run = (...args: string[]) => f.run("--candidate-values", candidatePath, ...args);
    const pending = await loseHelmResponseWithCompletedHook(f, run);
    return { f, run, pending, policy, key: `${policy.kind}/${policy.metadata.name}` };
  }

  test("same-candidate recovery refuses retained predecessor resources and checks their absence on resume", async (t) => {
    const { f, run, pending, policy, key } = await interruptedProxyRemoval(t);
    const originalIntent = await f.readEvidence("helm-started");
    for (const mode of ["live", "deleting", "keep", "forbidden"]) {
      await t.test(mode, async () => {
        const state = structuredClone(pending);
        const retired = structuredClone(policy);
        state.recoveryResources[key] = retired;
        const metadata: Record<string, unknown> = retired.metadata;
        if (mode === "deleting") {
          metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
        } else if (mode === "keep") {
          metadata.annotations = { "helm.sh/resource-policy": "keep" };
        } else if (mode === "forbidden") {
          delete state.recoveryResources[key];
          state.retiredResourceReadError = true;
        }
        await assertRecoveryRefusedBeforeRollback(
          f,
          state,
          mode === "forbidden"
            ? /Helm evidence command failed/
            : /predecessor-only resource still exists/,
          run,
        );
      });
    }
    const withRetiredEnv = structuredClone(pending);
    const oldEnv = { name: "OCC_CHANNEL_DIRECTORY_PROXY_URL", value: "http://198.51.100.25:3128" };
    apiEnvironment(withRetiredEnv).push(oldEnv);
    await assertRecoveryRefusedBeforeRollback(f, withRetiredEnv, /live environment differs/, run);
    // Explicit operator reconciliation removes the retired policy and env entry. If a later
    // acceptance step fails, its recreation must also block ordinary resume.
    await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
    await f.failNext("fail-rollout-api");
    await assert.rejects(run(...recoverHelm), injectedFault);
    assert.ok(existsSync(join(f.evidence, "helm-recovery", "acknowledged.json")));
    const recovered = await f.state();
    const resources = requiredRecord(
      recovered.recoveryResources,
      "expected acknowledged live recovery resources",
    );
    resources[key] = policy;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(recovered));
    await assert.rejects(run("--resume"), /predecessor-only resource still exists/);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    delete resources[key];
    const apiEnv = apiEnvironment(recovered);
    apiEnv.push(oldEnv);
    await writeFile(join(f.directory, "state.json"), JSON.stringify(recovered));
    await assert.rejects(run("--resume"), /live environment differs/);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    apiEnv.pop();
    await writeFile(join(f.directory, "state.json"), JSON.stringify(recovered));
    await run("--resume");
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    assert.equal(await f.readEvidence("helm-started"), originalIntent);
  });

  test("same-candidate recovery verifies a changed retained environment selection after rollback", async (t) => {
    const { f, run, pending } = await interruptedProxyRemoval(t, "http://198.51.100.26:3128");
    // A retained scalar can legitimately differ before rollback. This protocol
    // fault keeps its old value afterward; it must not receive acknowledgement.
    const entries = apiEnvironment(pending);
    const proxy = asRecord(
      entries.find((entry) => asRecord(entry)?.name === "OCC_CHANNEL_DIRECTORY_PROXY_URL"),
    );
    assert.ok(proxy, "expected the candidate directory proxy variable");
    proxy.value = "http://198.51.100.25:3128";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
    await assert.rejects(run(...recoverHelm), /live environment differs/);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal(existsSync(join(f.evidence, "helm-recovery", "acknowledged.json")), false);
  });

  for (const [stage, rollbacks] of [
    ["before dispatch", 0],
    ["after rollback", 1],
  ] as const) {
    test(`same-candidate recovery refuses a predecessor resource recreated ${stage}`, async (t) => {
      const { f, run, pending, key, policy } = await interruptedProxyRemoval(t);
      const originalIntent = await f.readEvidence("helm-started");
      pending.retiredResourceRecreation = { stage, key, resource: policy };
      await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
      await assert.rejects(run(...recoverHelm), /predecessor-only resource still exists/);
      assert.equal((await f.state()).rollbackSubmissions ?? 0, rollbacks);
      assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
      assert.equal(await f.readEvidence("helm-started"), originalIntent);
      assert.ok(existsSync(join(f.evidence, "helm-recovery", "intent.json")));
      assert.equal(existsSync(join(f.evidence, "helm-recovery", "acknowledged.json")), false);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
    });
  }

  test("same-candidate recovery refuses a retired regular worker placement", async (t) => {
    const f = await fixture(t, { recoveryHooks: true });
    // Chart change 24ae029557 moves the broker-enabled worker to a restartable
    // init container. A same-candidate patch cannot remove its old placement.
    const worker = { name: "worker", image: controller, args: ["apps/controller/src/worker.mjs"] };
    const previous = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "broker-worker", namespace: "system" },
      spec: { template: { spec: { containers: [worker] } } },
    };
    const candidate = {
      ...structuredClone(previous),
      spec: {
        template: {
          spec: {
            initContainers: [{ ...worker, restartPolicy: "Always" }],
            containers: [{ name: "repository-credentials", image: controller }],
          },
        },
      },
    };
    const initial = await f.state();
    initial.recoveryBaselineResources = [previous];
    initial.recoveryCandidateResources = [candidate];
    await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
    const pending = await loseHelmResponseWithCompletedHook(f);
    const candidateContainers = array(
      templateSpec(resource(pending, "Deployment/broker-worker").spec).containers,
      "expected the candidate worker Pod containers",
    );
    candidateContainers.push(worker);
    await assertRecoveryRefusedBeforeRollback(
      f,
      pending,
      /retired container placement still exists/,
    );
    candidateContainers.pop();
    await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
    await runWithInjectedFault(f, "fail-rollout-api", ...recoverHelm);
    const acknowledged = await f.state();
    const liveContainers = array(
      templateSpec(resource(acknowledged, "Deployment/broker-worker").spec).containers,
      "expected the acknowledged worker Pod containers",
    );
    liveContainers.push(worker);
    await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
    await assert.rejects(f.run("--resume"), /retired container placement still exists/);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    liveContainers.pop();
    await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
    await f.run("--resume");
    assert.equal((await f.state()).rollbackSubmissions, 1);
  });

  test("same-candidate recovery requires changed custom-resource specs already reconciled", async (t) => {
    const f = await fixture(t, { recoveryHooks: true });
    // The real EnvoyProxy shape added node placement in chart change 78131ffa33.
    // This controlled protocol proves admission, not a running Envoy controller.
    const previous = {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "EnvoyProxy",
      metadata: { name: "gateway", namespace: "system" },
      spec: {
        provider: {
          type: "Kubernetes",
          kubernetes: { envoyService: { name: "gateway", type: "ClusterIP" } },
        },
      },
    };
    const candidate = {
      ...structuredClone(previous),
      spec: {
        provider: {
          ...previous.spec.provider,
          kubernetes: {
            ...previous.spec.provider.kubernetes,
            envoyDeployment: { pod: { nodeSelector: { "oce-role": "control" } } },
          },
        },
      },
    };
    const initial = await f.state();
    initial.recoveryBaselineResources = [previous];
    initial.recoveryCandidateResources = [candidate];
    await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
    const pending = await loseHelmResponseWithCompletedHook(f);
    requiredRecord(
      resource(pending, "EnvoyProxy/gateway").metadata,
      "expected recovery resource metadata",
    ).uid = "envoy-proxy-uid";
    for (const spec of [previous.spec, { ...candidate.spec, admissionDefault: true }]) {
      const state = structuredClone(pending);
      resource(state, "EnvoyProxy/gateway").spec = spec;
      await assertRecoveryRefusedBeforeRollback(
        f,
        state,
        /changed custom-resource spec is not reconciled/,
      );
    }
    await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
    await runWithInjectedFault(f, "fail-rollout-api", ...recoverHelm);
    const acknowledged = await f.state();
    resource(acknowledged, "EnvoyProxy/gateway").spec = previous.spec;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
    await assert.rejects(f.run("--resume"), /changed custom-resource spec is not reconciled/);
    resource(acknowledged, "EnvoyProxy/gateway").spec = candidate.spec;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
    await f.run("--resume");
    assert.equal((await f.state()).rollbackSubmissions, 1);
  });

  test("same-candidate recovery uses completed attempt-bound hooks and never repeats an acknowledged rollback", async (t) => {
    const f = await fixture(t, { recoveryHooks: true });
    // Recovery cannot act before the operator supplies both required attestations.
    await assert.rejects(
      f.run("--resume", "--recover-helm"),
      /requires --resume --migration-history-checked --recovery-reviewed/,
    );
    await assert.rejects(f.run("--recovery-reviewed"), /requires --recover-helm/);
    assert.deepEqual(await f.events(), []);
    await loseHelmResponseWithCompletedHook(f);
    const original = await f.readEvidence("helm-started");
    // A new rollback can restart the candidate writers. A refused application
    // observation must block dispatch, even though the hook already completed.
    const pending = await f.state();
    pending.preflightResults = {
      api: {
        phase: "Failed",
        log: "Candidate application database does not identify the incumbent Installation.\n",
      },
    };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
    await assert.rejects(f.run(...recoverHelm), /does not identify the incumbent Installation/);
    assert.equal((await f.state()).rollbackSubmissions, undefined);
    assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
    assert.equal(await f.readEvidence("helm-started"), original);
    const corrected = await f.state();
    delete corrected.preflightResults;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(corrected));
    // Rollback is acknowledged but ordinary acceptance is interrupted. Resume
    // must finish acceptance without rerunning migration or rollback.
    await runWithInjectedFault(f, "fail-rollout-api", ...recoverHelm);
    assert.equal((await f.state()).version, 3);
    const acknowledged = await f.state();
    const created = preflightCount(acknowledged);
    for (const key of [
      "Deployment/openclaw-enterprise-api",
      "Deployment/openclaw-enterprise-worker",
      "Job/oce-initialization",
      "Pod/initializer-pod",
    ]) {
      const changed = structuredClone(acknowledged);
      const actual = resource(changed, key);
      const metadata = requiredRecord(actual.metadata, "expected acknowledged resource metadata");
      const uid = metadata.uid;
      assert.ok(typeof uid === "string", "expected the acknowledged resource UID");
      metadata.uid = uid + "-replacement";
      await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
      await assert.rejects(f.run("--resume"), /recovery resource identity changed/);
      assert.equal((await f.state()).rollbackSubmissions, 1);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
    }
    // Rollout changes resource versions without replacing the acknowledged objects.
    const resources = requiredRecord(
      acknowledged.recoveryResources,
      "expected acknowledged live recovery resources",
    );
    for (const actual of Object.values(resources)) {
      requiredRecord(
        asRecord(actual)?.metadata,
        "expected acknowledged resource metadata",
      ).resourceVersion = "later-version";
    }
    await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
    await f.run("--resume");
    assert.equal(await f.readEvidence("helm-started"), original);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    assert.ok(existsSync(join(f.evidence, "completed")));
    assert.equal(preflightCount(await f.state()), created);
  });

  test("recovery refuses stale hooks, wrong Pod ownership and changed execution without submitting Helm", async (t) => {
    const { f, state: original } = await interruptedUpgradeWithCompletedHook(t);
    const changes: [string, (state: typeof original) => void, RegExp][] = [
      [
        "stale nonce",
        (state) => {
          const annotations = asRecord(
            requiredRecord(
              resource(state, "Job/oce-initialization").metadata,
              "expected recovery resource metadata",
            ).annotations,
          );
          assert.ok(annotations, "expected the initializer Job attempt annotations");
          annotations["openclaw.dev/upgrade-attempt"] = randomUUID();
        },
        /original upgrade attempt/,
      ],
      [
        "wrong owner",
        (state) => {
          const owners = array(state.recoveryPod.metadata.ownerReferences, "expected Pod owners");
          const owner = asRecord(owners[0]);
          assert.ok(owner, "expected the initializer Pod to have a Job owner");
          owner.uid = "another-job";
        },
        /Pod identity/,
      ],
      [
        "changed command",
        (state) => {
          firstContainer(state.recoveryPod.spec, "initContainers").args = ["unrelated.mjs"];
        },
        /Pod identity/,
      ],
      [
        "added entrypoint",
        (state) => {
          firstContainer(state.recoveryPod.spec, "containers").command = ["unreviewed"];
        },
        /Pod identity/,
      ],
      [
        "post-upgrade hook",
        (state) => {
          const hook = state.recoveryRelease.hooks[0];
          assert.ok(hook, "expected the Helm initializer hook");
          hook.events.push("post-upgrade");
        },
        /other hook events/,
      ],
    ];
    for (const [name, change, refusal] of changes) {
      await t.test(name, async () => {
        const state = structuredClone(original);
        change(state);
        await assertRecoveryRefusedBeforeRollback(f, state, refusal);
      });
    }
    // The original attempt is still recoverable after the invalid live observations.
    await writeFile(join(f.directory, "state.json"), JSON.stringify(original));
    await f.run(...recoverHelm);
    assert.equal((await f.state()).rollbackSubmissions, 1);
  });

  test("a staged retry cannot replace the published Helm attempt and an actual retry gets a fresh nonce", async (t) => {
    const f = await fixture(t, { controllerOnly: true });
    const valuesPath = join(f.directory, "values.json");
    async function assertProtectedValues(
      evidence: string,
      intent: Awaited<ReturnType<typeof assertHelmIntent>>,
      image: string,
    ) {
      const bytes = await readFile(valuesPath);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      const values = requiredRecord(value, "expected the staged values object");
      assert.equal(asRecord(values.images)?.controller, image);
      assert.equal(asRecord(values.installation)?.upgradeAttemptId, intent.attempt.nonce);
      assert.deepEqual(
        await readFile(join(evidence, "helm-attempts", intent.attempt.nonce, "values.yaml")),
        bytes,
      );
      assert.equal(createHash("sha256").update(bytes).digest("hex"), intent.attempt.valuesSha256);
      return bytes;
    }
    await runWithInjectedFault(f, "fail-migration");
    const original = await assertHelmIntent(f, 1, 2);
    const originalValues = await assertProtectedValues(f.evidence, original, newController);
    const preparation = await f.readEvidence("parameters.json");
    // The retry's dry-run fails after staging values, before replacing the local
    // values or publishing a new intent. The failed submission stays authoritative.
    await runWithInjectedFault(f, "fail-server-dry-run", "--resume", "--migration-history-checked");
    assert.deepEqual(await assertHelmIntent(f, 1, 2), original);
    assert.deepEqual(await readFile(valuesPath), originalValues);
    await assert.rejects(f.run("--resume"), /migration --check/);
    assert.equal((await f.state()).helmSubmissions, 1);
    await runWithInjectedFault(f, "lost-helm-response", "--resume", "--migration-history-checked");
    const retry = await assertHelmIntent(f, 2, 3);
    assert.notEqual(retry.attempt.nonce, original.attempt.nonce);
    assert.deepEqual(
      JSON.parse(await f.readEvidence("helm-attempts", original.attempt.nonce, "intent.json")),
      original,
    );
    assert.equal(await f.readEvidence("parameters.json"), preparation);
    await f.run("--resume");
    await assertProtectedValues(f.evidence, retry, newController);

    const nextEvidence = join(f.directory, "next-evidence");
    await f.run("--controller-image", controller, "--evidence-dir", nextEvidence);
    const next = await assertHelmIntent(evidenceFiles(nextEvidence), 3, 4);
    assert.notEqual(next.attempt.nonce, retry.attempt.nonce);
    await assertProtectedValues(nextEvidence, next, controller);
  });

  test("a retry published before Helm accepts it can resume from its exact predecessor", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "fail-migration");
    const original = await assertHelmIntent(f, 1, 2);
    // B is published, but Helm refuses it before creating a revision. A remains live.
    await runWithInjectedFault(
      f,
      "reject-helm-submission",
      "--resume",
      "--migration-history-checked",
    );
    const retry = await assertHelmIntent(f, 2, 3);
    assert.notEqual(retry.attempt.nonce, original.attempt.nonce);
    const predecessor = await f.state();
    assert.equal(predecessor.version, 2);
    const events = await f.events();
    // The retained values belong only to the exact predecessor revision.
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify({ ...predecessor, version: 3 }),
    );
    await assert.rejects(f.run("--resume", "--migration-history-checked"), /live Helm values/);
    await writeFile(join(f.directory, "state.json"), JSON.stringify(predecessor));
    const liveValues = await readFile(join(f.directory, "live-values"), "utf8");
    const parsedValues: unknown = loadYaml(liveValues);
    await writeFile(
      join(f.directory, "live-values"),
      JSON.stringify({ ...requiredRecord(parsedValues, "expected live values"), unrelated: true }),
    );
    await assert.rejects(f.run("--resume", "--migration-history-checked"), /live Helm values/);
    await writeFile(join(f.directory, "live-values"), liveValues);
    assert.deepEqual(await f.events(), events);
    await f.run("--resume", "--migration-history-checked");
    assert.equal((await f.state()).version, 3);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 2);
  });

  test("a first intent interrupted before publication can finish its identical staged write", async (t) => {
    for (const stagedFileExists of [false, true]) {
      await t.test(stagedFileExists ? "after staging" : "before staging", async (subtest) => {
        const f = await fixture(subtest);
        await runWithInjectedFault(f, "reject-helm-submission");
        const intent = await assertHelmIntent(f, 1, 2);
        const original = await f.readEvidence("helm-started");
        const directory = join(f.evidence, "helm-attempts", intent.attempt.nonce);
        // Retain the exact real intent, modeling interruption after its exclusive
        // creation but before publication. No Helm revision or migration was created.
        await rm(join(f.evidence, "helm-started"));
        if (stagedFileExists) {
          const staged = join(directory, "helm-started.tmp");
          await writeFile(staged, JSON.stringify({ ...intent, expectedRevision: 3 }), {
            mode: 0o600,
          });
          await assert.rejects(f.run("--resume"), /staged Helm submission intent changed/);
          assert.equal((await f.state()).helmSubmissions, 1);
          await writeFile(staged, original);
        }
        await f.run("--resume");
        assert.equal(await readFile(join(directory, "intent.json"), "utf8"), original);
        assert.equal((await f.state()).version, 2);
        assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
      });
    }
  });

  test("ordinary resume rejects a well-formed revision pair that differs from the immutable intent", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "lost-helm-response");
    const original = await assertHelmIntent(f, 1, 2);
    const state = await f.state();
    state.version = 3;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await writeFile(
      join(f.evidence, "helm-started"),
      JSON.stringify({
        ...original,
        previousRevision: 2,
        expectedRevision: 3,
      }),
    );
    const events = await f.events();
    await assert.rejects(f.run("--resume"), /submission intent/);
    assert.deepEqual(await f.events(), events);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });

  test("recovery rejects admission-added execution settings even when absent from the candidate", async (t) => {
    const { f, state: original } = await interruptedUpgradeWithCompletedHook(t);
    for (const [field, value] of [
      ["lifecycle", { postStart: { exec: { command: ["unreviewed"] } } }],
      ["env", [{ name: "NODE_OPTIONS", value: "--require=/unreviewed.js" }]],
      ["envFrom", [{ secretRef: { name: "unreviewed" } }]],
      ["workingDir", "/unreviewed"],
      ["startupProbe", { exec: { command: ["unreviewed"] } }],
      ["volumeMounts", [{ name: "unreviewed", mountPath: "/unreviewed" }]],
      ["volumeDevices", [{ name: "unreviewed", devicePath: "/dev/unreviewed" }]],
    ] as const) {
      await t.test(field, async () => {
        const state = structuredClone(original);
        const spec = requiredRecord(state.recoveryPod.spec, "expected the initializer Pod spec");
        firstContainer(spec, "containers")[field] = value;
        if (field === "volumeMounts" || field === "volumeDevices") {
          spec.volumes = [
            {
              name: "unreviewed",
              ...(field === "volumeDevices"
                ? { persistentVolumeClaim: { claimName: "unreviewed-block" } }
                : { emptyDir: {} }),
            },
          ];
        }
        await assertRecoveryRefusedBeforeRollback(f, state, /Pod identity/);
      });
    }
  });

  test("an unacknowledged same-candidate rollback cannot be replayed or silently adopted", async (t) => {
    const { f } = await interruptedUpgradeWithCompletedHook(t);
    await f.failNext("lost-rollback-response");
    await assert.rejects(f.run(...recoverHelm), /outcome is unresolved/);
    // The controlled server accepted recovery, but the helper did not acknowledge
    // it. A healthy successor alone must not authorize replay or adoption.
    assert.equal((await f.state()).version, 3);
    const intent = await f.readEvidence("helm-recovery", "intent.json");
    const created = preflightCount(await f.state());
    await assert.rejects(f.run(...recoverHelm), /Do not replay recovery/);
    assert.equal(preflightCount(await f.state()), created);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal(await f.readEvidence("helm-recovery", "intent.json"), intent);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });

  test("a staged retry with replaced local values still cannot replace the published attempt", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "fail-migration");
    const original = await assertHelmIntent(f, 1, 2);
    const preparation = await f.readEvidence("parameters.json");
    // Simulate loss at the last native read after local values replacement, before
    // publishing the next intent. Resume must require explicit reconciliation.
    await runWithInjectedFault(
      f,
      "fail-before-helm-intent",
      "--resume",
      "--migration-history-checked",
    );
    const values = await yamlFile(join(f.directory, "values.json"));
    assert.equal(typeof asRecord(asRecord(values)?.installation)?.upgradeAttemptId, "string");
    assert.notEqual(
      asRecord(asRecord(values)?.installation)?.upgradeAttemptId,
      original.attempt.nonce,
    );
    await assert.rejects(
      f.run("--resume", "--migration-history-checked"),
      /protected Helm values changed/,
    );
    assert.deepEqual(await assertHelmIntent(f, 1, 2), original);
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal(await f.readEvidence("parameters.json"), preparation);
  });

  test("certificate admission refusal leaves the incumbent controllers running", async (t) => {
    const f = await fixture(t, { controllerOnly: true, certificate: true });
    await f.failNext("refuse-certificate-admission");
    await assert.rejects(f.run(), /certificate admission preflight failed/);
    assert.deepEqual(await f.events(), ["certificate-admission"]);
    const state = await f.state();
    assert.equal(state.api, 1);
    assert.equal(state.worker, 1);
    assert.equal(state.version, 1);
    assert.equal(
      await f.readEvidence("preflight-certificates.err"),
      "certificate webhook refused dry-run\n",
    );
  });

  test("successful certificate admission precedes shutdown and Helm submission", async (t) => {
    const f = await fixture(t, { controllerOnly: true, certificate: true });
    await f.run();
    assert.deepEqual(await f.events(), [
      "certificate-admission",
      "scale-api",
      "scale-worker",
      "migration",
    ]);
  });

  test("failed attempt preparation preserves native dry-run diagnostics before stopping writers", async (t) => {
    const f = await fixture(t);
    await f.failNext("fail-server-dry-run");
    await assert.rejects(f.run(), (error) => {
      assert.ok(error instanceof Error);
      assert.ok("code" in error && "stderr" in error && typeof error.stderr === "string");
      assert.equal(error.code, 9);
      assert.match(error.stderr, /Helm preparation failed/);
      return true;
    });
    const attempts = await readdir(join(f.evidence, "helm-attempts"));
    assert.equal(attempts.length, 1);
    const [attempt] = attempts;
    assert.ok(attempt, "expected the staged Helm attempt directory");
    await assertPrivateReceipt(
      join(f.evidence, "helm-attempts", attempt, "server-dry-run-error.log"),
      "synthetic server dry-run diagnostic\n",
    );
    assert.deepEqual(await f.events(), []);
    assert.equal(existsSync(join(f.evidence, "prepared")), false);
  });

  test("recovery refuses a container override of the inherited initializer identity", async (t) => {
    const { f, state: original } = await interruptedUpgradeWithCompletedHook(t);
    // Admission may leave the Job intact and override identity only on its Pod.
    for (const placement of ["initContainers", "containers"] as const) {
      for (const [key, value] of [
        ["runAsUser", 1001],
        ["runAsGroup", 1001],
        ["runAsNonRoot", false],
      ] as const) {
        await t.test(`${placement} ${key}`, async () => {
          const state = structuredClone(original);
          const container = firstContainer(state.recoveryPod.spec, placement);
          requiredRecord(container.securityContext, "expected the container security context")[
            key
          ] = value;
          await assertRecoveryRefusedBeforeRollback(f, state, /Pod identity/);
        });
      }
    }
  });

  test("recovery compares initializer resource quantities by value and refuses changed limits", async (t) => {
    const { f, state: original } = await interruptedUpgradeWithCompletedHook(t, {
      requests: { cpu: "0.1", memory: "128Mi" },
      limits: { cpu: "0.5", memory: "1.5Gi" },
    });
    // Kubernetes serializes equivalent fixed-point quantities canonically on
    // the Job and Pod; the stored Helm manifest retains the original spelling.
    for (const spec of [
      templateSpec(resource(original, "Job/oce-initialization").spec),
      requiredRecord(original.recoveryPod.spec, "expected the initializer Pod spec"),
    ]) {
      for (const placement of ["initContainers", "containers"] as const) {
        for (const entry of array(spec[placement], `expected the initializer ${placement}`)) {
          const container = requiredRecord(entry, "expected an initializer container");
          const resources = requiredRecord(container.resources, "expected container resources");
          requiredRecord(resources.requests, "expected the candidate resource requests").cpu =
            "100m";
          resources.limits = { cpu: "500m", memory: "1536Mi" };
        }
      }
    }
    for (const [placement, section, resource, value] of [
      ["containers", "limits", "memory", "1537Mi"],
      ["initContainers", "requests", "cpu", "101m"],
    ] as const) {
      const changed = structuredClone(original);
      const container = firstContainer(changed.recoveryPod.spec, placement);
      const resources = requiredRecord(container.resources, "expected container resources");
      requiredRecord(resources[section], `expected the candidate resource ${section}`)[resource] =
        value;
      await assertRecoveryRefusedBeforeRollback(f, changed, /Pod identity/);
    }
    await writeFile(join(f.directory, "state.json"), JSON.stringify(original));
    await f.run(...recoverHelm);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  });

  test("recovery refuses admission changes to Pod and container security settings", async (t) => {
    for (const change of ["Pod sysctls", "container seccomp", "init capabilities"]) {
      await t.test(change, async (subtest) => {
        const { f, state } = await interruptedUpgradeWithCompletedHook(subtest);
        // Admission can preserve every requested field while adding privileges or
        // overriding a profile inherited from the Pod onto one container.
        const spec = requiredRecord(state.recoveryPod.spec, "expected the initializer Pod spec");
        if (change === "Pod sysctls") {
          requiredRecord(spec.securityContext, "expected the Pod security context").sysctls = [
            { name: "net.ipv4.ip_local_port_range", value: "1024 65535" },
          ];
        } else if (change === "container seccomp") {
          const container = firstContainer(spec, "containers");
          requiredRecord(
            container.securityContext,
            "expected the container security context",
          ).seccompProfile = { type: "Unconfined" };
        } else {
          const container = firstContainer(spec, "initContainers");
          const security = requiredRecord(
            container.securityContext,
            "expected the container security context",
          );
          requiredRecord(security.capabilities, "expected the container capabilities").add = [
            "NET_ADMIN",
          ];
        }
        await assertRecoveryRefusedBeforeRollback(f, state, /Pod identity/);
      });
    }
  });
}
