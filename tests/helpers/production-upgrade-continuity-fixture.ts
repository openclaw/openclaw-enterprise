import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import type { AgentWire } from "../../packages/contracts/src/api/resources.ts";
import type {
  AgentRuntimeContainerStatus,
  AgentRuntimeDescription,
  AgentRuntimeLogSource,
  AgentRuntimePodStatus,
} from "../../packages/contracts/src/runtime-logs.ts";

type PodReference = AgentRuntimeLogSource["pods"][number];

type ContinuityPod = Omit<AgentRuntimePodStatus, "containers"> & {
  containers: AgentRuntimeContainerStatus[];
};

type ContinuitySource = Omit<AgentRuntimeLogSource, "available" | "unavailableCode" | "pods"> & {
  available: boolean;
  unavailableCode?: NonNullable<AgentRuntimeLogSource["unavailableCode"]>;
  pods: PodReference[];
};

type ContinuityRuntime = Omit<AgentRuntimeDescription, "pods" | "sources" | "harness"> & {
  pods: ContinuityPod[];
  sources: ContinuitySource[];
  harness?: AgentRuntimeDescription["harness"];
};

interface ContinuityObservation {
  agent: Omit<AgentWire, "activeRevisionId"> & {
    activeRevisionId?: AgentWire["activeRevisionId"] | null;
  };
  runtime: ContinuityRuntime;
  agentError?: string;
  runtimeError?: string;
  changeRevisionAfterRuntime?: string;
  changeHelmRevisionAfterRuntime?: boolean;
}

function continuityPodReference(
  pod: Pick<AgentRuntimePodStatus, "name" | "uid">,
  container = "runtime",
): PodReference {
  return { name: pod.name, uid: pod.uid, container, restartCount: 0 };
}

export const continuityNamespace = "ns_00000000-0000-4000-8000-000000000001";
const continuityAgent = "agt_00000000-0000-4000-8000-000000000002";
const continuityRevision = "rev_00000000-0000-4000-8000-000000000003";
const continuityFlags = [
  "--verify-agent",
  continuityAgent,
  "--verify-agent-namespace",
  continuityNamespace,
] as const;
function continuityObservation(suffix = "before"): ContinuityObservation {
  const observedAt = "2026-11-07T00:00:00Z";
  const roles: AgentRuntimePodStatus["role"][] = ["agent", "gateway"];
  const pods = roles.map<ContinuityPod>((role) => ({
    role,
    cluster: "control",
    name: `${role}-${suffix}`,
    uid: `${role}-${suffix}-uid`,
    phase: "Running",
    ready: true,
    createdAt: observedAt,
    // Provider-backed workloads need not use the Compute container name.
    containers: [
      {
        name: "runtime",
        state: "running",
        reason: null,
        ready: true,
        restartCount: 0,
        startedAt: observedAt,
        lastTermination: null,
      },
    ],
    events: [],
  }));
  return {
    agent: {
      id: continuityAgent,
      namespaceId: continuityNamespace,
      name: "Continuity check",
      servicePrincipalId: "spn_00000000-0000-4000-8000-000000000004",
      configurationId: "cfg_00000000-0000-4000-8000-000000000005",
      backendId: "backend",
      // The draft was edited to embedded; the running immutable revision is dedicated.
      executionMode: "embedded",
      gatewayManagedMode: true,
      sandboxPolicyEditing: false,
      activeRevisionId: continuityRevision,
      desiredRuntimeState: "running",
      status: "active",
      harnessAuth: null,
      createdAt: observedAt,
    },
    runtime: {
      revisionId: continuityRevision,
      observedAt,
      pods,
      sources: pods.map((pod) => ({
        id: pod.role,
        kind: "container",
        available: true,
        retention: "Available while the Pod is retained.",
        pods: [continuityPodReference(pod)],
      })),
      harness: { state: "running" },
    },
  };
}
function continuityFixture() {
  return { before: continuityObservation(), after: continuityObservation("replacement") };
}

type FixtureOptions = {
  controllerOnly?: true;
  continuity?: ReturnType<typeof continuityFixture>;
  environment?: NodeJS.ProcessEnv;
};

type UpgradeFixture = {
  directory: string;
  evidence: string;
  commands: readonly unknown[];
  readEvidence(name: string): Promise<string>;
  run(...args: string[]): Promise<unknown>;
  state(): Promise<{
    api: number;
    worker: number;
    version: number;
    dispatches: number;
    helmSubmissions?: number;
    continuity: ReturnType<typeof continuityFixture> | null;
  }>;
  events(): Promise<string[]>;
  failNext(fault: string): Promise<void>;
};

type ContinuityTestDependencies = {
  fixture(t: TestContext, options?: FixtureOptions): Promise<UpgradeFixture>;
  injectedFault: { code: number };
  helmTargetOverrides: readonly string[];
  controller: string;
  newController: string;
  assertPrivateReceipt(path: string, expected: string): Promise<void>;
};

const continuityEvidenceSchema = Type.Object({
  revisionId: Type.String(),
  roles: Type.Array(Type.String()),
  runtime: Type.Object({
    pods: Type.Array(
      Type.Object({ uid: Type.String(), role: Type.String(), phase: Type.String() }),
    ),
    harness: Type.Optional(Type.Object({ state: Type.String() })),
  }),
});

async function readContinuityEvidence(
  f: Pick<UpgradeFixture, "readEvidence">,
  name: "agent-continuity.json" | "agent-continuity-after.json",
) {
  const observation: unknown = JSON.parse(await f.readEvidence(name));
  Assert(continuityEvidenceSchema, observation);
  return observation;
}

const continuityConfirmationSchema = Type.Object({ activeRevisionId: Type.String() });

type CompatibilityCounts = {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  total: number;
};

type CompatibilityTestReceipt = {
  name: string;
  status: "passed" | "failed" | "skipped";
  file: string;
  skip?: boolean | string;
  todo?: boolean | string;
};

type CompatibilityFileReceipt = {
  path: string;
  status: "passed" | "failed";
  nodeExitCode: number;
  signal: NodeJS.Signals | null;
  counts: CompatibilityCounts;
  tests: CompatibilityTestReceipt[];
  issues: readonly unknown[];
  cleanup: { status: "passed" | "failed" } | null;
  fileFailure?: { error: { message: string } };
};

type CompatibilityReceipt = {
  version: 1;
  command: "run" | "aggregate";
  sourceSha: string | null;
  lane: "postgres";
  scope: "full" | "focused";
  status: "passed" | "failed";
  exitCode: number;
  counts: CompatibilityCounts;
  issues: readonly unknown[];
  files: [
    CompatibilityFileReceipt & {
      tests: [CompatibilityTestReceipt, CompatibilityTestReceipt];
      imageDigests: { releasedController: string; candidateController: string };
    },
    CompatibilityFileReceipt,
  ];
};

type ChangeCompatibilityReceipt = (receipt: CompatibilityReceipt) => void;

export function registerUpgradeContinuityTests({
  fixture,
  injectedFault,
  helmTargetOverrides,
  controller,
  newController,
  assertPrivateReceipt,
}: ContinuityTestDependencies): void {
  // These are the supported CLI JSON responses. They model only external observations;
  // the real upgrade command owns all continuity decisions and recovery writes.
  function controllerContinuityFixture(
    t: TestContext,
    continuity: ReturnType<typeof continuityFixture>,
  ) {
    return fixture(t, { controllerOnly: true, continuity });
  }

  // Existing controller-only semantics intentionally remain unchanged unless selected.
  test("Agent continuity is opt-in; controller recovery alone can complete after Agent loss", async (t) => {
    const continuity = continuityFixture();
    delete continuity.after.agent.activeRevisionId;
    continuity.after.runtime.pods = [];
    const f = await controllerContinuityFixture(t, continuity);
    await f.run();
    assert.ok(existsSync(join(f.evidence, "completed")));
    assert.equal(
      (await f.events()).some((event) => event.startsWith("continuity-")),
      false,
    );
  });

  test("Agent continuity accepts replacement Ready Pods for the original immutable topology", async (t) => {
    const continuity = continuityFixture();
    const agentPod = continuity.after.runtime.pods[0];
    const agentSource = continuity.after.runtime.sources[0];
    assert.ok(agentPod && agentSource);
    agentPod.containers.push({
      name: "initialize-workspace",
      state: "terminated",
      reason: "Completed",
      ready: false,
      restartCount: 0,
      startedAt: "2026-11-07T00:00:00Z",
      lastTermination: {
        reason: "Completed",
        exitCode: 0,
        finishedAt: "2026-11-07T00:00:01Z",
      },
    });
    agentSource.pods.push(continuityPodReference(agentPod, "initialize-workspace"));
    const f = await controllerContinuityFixture(t, continuity);
    await f.run(...continuityFlags);
    const before = await readContinuityEvidence(f, "agent-continuity.json");
    const after = await readContinuityEvidence(f, "agent-continuity-after.json");
    assert.deepEqual(before.roles, ["agent", "gateway"]);
    const originalPod = before.runtime.pods[0];
    const replacementPod = after.runtime.pods[0];
    assert.ok(originalPod && replacementPod);
    assert.notEqual(originalPod.uid, replacementPod.uid);
    assert.equal(after.revisionId, before.revisionId);
    assert.ok(existsSync(join(f.evidence, "completed")));
    assert.equal((await f.state()).dispatches, 0);
  });

  test("Agent continuity refuses lost or changed revisions and resumes without repeating Helm", async (t) => {
    for (const revision of [null, "rev_00000000-0000-4000-8000-000000000099"]) {
      await t.test(String(revision), async (t) => {
        const continuity = continuityFixture();
        continuity.after.agent.activeRevisionId = revision;
        const f = await controllerContinuityFixture(t, continuity);
        await assert.rejects(
          f.run(...continuityFlags),
          /continuity failed; completion was not recorded/,
        );
        assert.equal(existsSync(join(f.evidence, "completed")), false);
        const baseline = await f.readEvidence("agent-continuity.json");
        const state = await f.state();
        assert.equal(state.helmSubmissions, 1);
        assert.ok(state.continuity);
        state.continuity.after = continuityObservation("restored");
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        await f.run(...continuityFlags, "--resume");
        assert.equal((await f.state()).helmSubmissions, 1);
        assert.equal((await f.state()).dispatches, 0);
        assert.equal(await f.readEvidence("agent-continuity.json"), baseline);
        assert.ok(existsSync(join(f.evidence, "completed")));
      });
    }
  });

  test("Agent continuity checks read permissions before stopping either writer", async (t) => {
    for (const [operation, status] of [
      ["agent", 403],
      ["runtime", 403],
      ["runtime", 501],
    ] as const) {
      await t.test(`${operation} HTTP ${status}`, async (t) => {
        const continuity = continuityFixture();
        continuity.before[`${operation}Error`] =
          `Error: OCC operation failed (HTTP ${status}): UNAVAILABLE: selected read refused`;
        const f = await controllerContinuityFixture(t, continuity);
        await assert.rejects(
          f.run(...continuityFlags),
          /continuity check failed before writer shutdown/,
        );
        const state = await f.state();
        assert.equal(state.api, 1);
        assert.equal(state.worker, 1);
        assert.equal(state.helmSubmissions, undefined);
        assert.equal(existsSync(join(f.evidence, "prepared")), false);
        assert.equal((await f.events()).includes("migration"), false);
      });
    }
  });

  test("Agent continuity requires every revision role despite an edited draft", async (t) => {
    const continuity = continuityFixture();
    continuity.after.runtime.pods = continuity.after.runtime.pods.filter(
      (pod) => pod.role === "gateway",
    );
    const agentSource = continuity.after.runtime.sources.find((source) => source.id === "agent");
    assert.ok(agentSource);
    agentSource.available = false;
    agentSource.unavailableCode = "NO_POD";
    agentSource.pods = [];
    const f = await controllerContinuityFixture(t, continuity);
    await assert.rejects(
      f.run(...continuityFlags, "--timeout-seconds", "5"),
      /continuity failed; completion was not recorded\..*Timed out/,
    );
    const observed = await readContinuityEvidence(f, "agent-continuity-after.json");
    assert.deepEqual(observed.roles, ["agent", "gateway"]);
    assert.deepEqual(
      observed.runtime.pods.map((pod) => pod.role),
      ["gateway"],
    );
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    const state = await f.state();
    assert.ok(state.continuity);
    state.continuity.after = continuityObservation("restored");
    // Retained terminal Pods do not prevent healthy replacement Pods from passing.
    const original = continuityObservation();
    const originalPod = original.runtime.pods[0];
    const originalSource = original.runtime.sources[0];
    const restoredSource = state.continuity.after.runtime.sources[0];
    assert.ok(originalPod && originalSource && restoredSource);
    state.continuity.after.runtime.pods.push({ ...originalPod, phase: "Failed", ready: false });
    restoredSource.pods.push(...originalSource.pods);
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await f.run(...continuityFlags, "--resume");
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.ok(existsSync(join(f.evidence, "completed")));
  });

  test("Agent continuity refuses truncated Pod observations and lost provider Harness status", async (t) => {
    for (const scenario of ["truncated", "missing-harness", "lost-harness", "duplicate-pod"]) {
      await t.test(scenario, async (t) => {
        const continuity = continuityFixture();
        const pod = continuity.after.runtime.pods[0];
        assert.ok(pod);
        if (scenario === "truncated") {
          // The endpoint returns at most eight Pods per role; another live Pod may
          // be omitted beyond seven ended Pods and the one visible live Pod.
          for (let index = 0; index < 7; index++) {
            continuity.after.runtime.pods.push({
              ...pod,
              name: `ended-${index}`,
              uid: `ended-${index}`,
              phase: "Failed",
              ready: false,
            });
          }
        } else if (scenario === "missing-harness") {
          delete continuity.after.runtime.harness;
        } else if (scenario === "lost-harness") {
          continuity.after.runtime.harness = { state: "lost", code: "SANDBOX_MISSING" };
        } else {
          continuity.after.runtime.pods.push({
            ...pod,
            name: "duplicate",
            uid: "duplicate",
          });
        }
        for (const source of continuity.after.runtime.sources) {
          source.pods = continuity.after.runtime.pods
            .filter((pod) => pod.role === source.id)
            .map((pod) => continuityPodReference(pod));
        }
        const f = await controllerContinuityFixture(t, continuity);
        await assert.rejects(
          f.run(...continuityFlags, "--timeout-seconds", "5"),
          /continuity failed; completion was not recorded\..*Timed out/,
        );
        // A refusal counts only after the command retained a full observation of
        // this scenario, not if a slow setup exhausted the deadline beforehand.
        const observed = await readContinuityEvidence(f, "agent-continuity-after.json");
        assert.equal(observed.revisionId, continuityRevision);
        if (scenario === "truncated") {
          assert.equal(observed.runtime.pods.filter((pod) => pod.role === "agent").length, 8);
        } else if (scenario === "missing-harness") {
          assert.equal(Object.hasOwn(observed.runtime, "harness"), false);
        } else if (scenario === "lost-harness") {
          assert.equal(observed.runtime.harness?.state, "lost");
        } else {
          assert.equal(
            observed.runtime.pods.filter((pod) => pod.role === "agent" && pod.phase === "Running")
              .length,
            2,
          );
        }
        assert.equal(existsSync(join(f.evidence, "completed")), false);
        assert.equal((await f.state()).helmSubmissions, 1);
        assert.equal((await f.state()).dispatches, 0);
      });
    }
  });

  test("Agent continuity binds original evidence and selection across resume", async (t) => {
    const continuity = continuityFixture();
    continuity.after.runtime.sources = continuity.after.runtime.sources.filter(
      (source) => source.id === "gateway",
    );
    const f = await controllerContinuityFixture(t, continuity);
    await assert.rejects(f.run(...continuityFlags), /revision workload roles changed/);
    await assert.rejects(f.run("--resume"), /resume evidence directory/);
    const baseline = join(f.evidence, "agent-continuity.json");
    await writeFile(baseline, "{}\n");
    await assert.rejects(
      f.run(...continuityFlags, "--resume"),
      /prepared upgrade evidence changed/,
    );
    assert.equal((await f.state()).helmSubmissions, 1);
  });

  test("Agent continuity confirms the active revision after reading runtime status", async (t) => {
    const continuity = continuityFixture();
    const replacement = "rev_00000000-0000-4000-8000-000000000099";
    // The old revision still has Ready Pods when a concurrent deployment switches
    // the active revision. The final Agent read must catch that intervening change.
    continuity.after.changeRevisionAfterRuntime = replacement;
    const f = await controllerContinuityFixture(t, continuity);
    await assert.rejects(
      f.run(...continuityFlags),
      /selected Agent changed during runtime inspection/,
    );
    const confirmed: unknown = JSON.parse(
      await f.readEvidence("agent-continuity-after.confirm.json"),
    );
    Assert(continuityConfirmationSchema, confirmed);
    assert.equal(confirmed.activeRevisionId, replacement);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    assert.equal((await f.state()).helmSubmissions, 1);
    assert.equal((await f.state()).dispatches, 0);
  });

  test("Agent continuity finishes before the terminal Helm identity check", async (t) => {
    const continuity = continuityFixture();
    continuity.after.changeHelmRevisionAfterRuntime = true;
    const f = await controllerContinuityFixture(t, continuity);
    await assert.rejects(
      f.run(...continuityFlags),
      /the final Helm release is not this submission's deployed revision/,
    );
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    const state = await f.state();
    assert.equal(state.version, 3);
    assert.equal(state.helmSubmissions, 1);
    assert.equal(state.dispatches, 0);
  });

  test("Upgrade rejects inherited Helm target overrides before external calls or evidence writes", async (t) => {
    for (const variable of helmTargetOverrides) {
      await t.test(variable, async (t) => {
        const value = "private-target-override";
        const f = await fixture(t, { controllerOnly: true, environment: { [variable]: value } });
        // Helm accepts these independently of --kubeconfig/--kube-context. Refuse
        // before either command protocol or recovery evidence can use another target.
        await assert.rejects(f.run(), (error) => {
          assert.ok(
            error instanceof Error && "stderr" in error && typeof error.stderr === "string",
          );
          assert.match(error.stderr, new RegExp(`unset ${variable}`));
          assert.match(error.stderr, /selected kubeconfig/);
          assert.equal(error.stderr.includes(value), false);
          return true;
        });
        assert.equal(f.commands.length, 0);
        assert.equal(existsSync(f.evidence), false);
      });
    }
  });

  test("Resume refuses inherited Helm target changes without altering accepted upgrade evidence", async (t) => {
    const environment: NodeJS.ProcessEnv = {};
    const f = await fixture(t, { controllerOnly: true, environment });
    await f.failNext("lost-helm-response");
    await assert.rejects(f.run(), injectedFault);
    const parameters = await f.readEvidence("parameters.json");
    const submission = await f.readEvidence("helm-started");
    const commands = f.commands.length;
    const events = await f.events();
    // A changed shell environment must not redirect reconciliation of an accepted
    // submission, even when the recorded kubeconfig and all arguments still match.
    for (const variable of helmTargetOverrides) {
      environment[variable] = "private-target-override";
      await assert.rejects(f.run("--resume"), new RegExp(`unset ${variable}`));
      delete environment[variable];
      assert.equal(f.commands.length, commands);
      assert.deepEqual(await f.events(), events);
      assert.equal(await f.readEvidence("parameters.json"), parameters);
      assert.equal(await f.readEvidence("helm-started"), submission);
      assert.equal(existsSync(join(f.evidence, ".upgrade-lock")), false);
    }
    await f.run("--resume");
    assert.ok(existsSync(join(f.evidence, "completed")));
    assert.equal((await f.state()).helmSubmissions, 1);
  });

  test("Agent continuity rejects explicitly empty selection before external calls", async (t) => {
    for (const flags of [
      ["--verify-agent", "", "--verify-agent-namespace", ""],
      ["--verify-agent", ""],
      ["--verify-agent-namespace", ""],
    ]) {
      await t.test(JSON.stringify(flags), async (t) => {
        const f = await fixture(t, { controllerOnly: true });
        await assert.rejects(f.run(...flags), /requires a nonempty value/);
        assert.equal(f.commands.length, 0);
      });
    }
  });

  test("Agent continuity rejects incomplete selection and intentional runtime replacement", async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run("--verify-agent", continuityAgent), /must be supplied together/);
    await assert.rejects(f.run(...continuityFlags), /cannot be combined with --runtime-image/);
    assert.equal(f.commands.length, 0);
  });

  // Match the native runner's run summary, including another file from a full lane.
  // These receipts test the consumer; they do not claim PostgreSQL execution.
  function controllerCompatibilityResults(): CompatibilityReceipt {
    const path = "tests/integration/postgres-migration-compatibility.test.mjs";
    const counts = { passed: 2, failed: 0, skipped: 0, todo: 0, total: 2 };
    const [, releasedController] = controller.split("@");
    const [, candidateController] = newController.split("@");
    assert.ok(releasedController && candidateController);
    return {
      version: 1,
      command: "run",
      sourceSha: "1".repeat(40),
      lane: "postgres",
      scope: "full",
      status: "passed",
      exitCode: 0,
      counts: { ...counts, passed: 3, total: 3 },
      issues: [],
      files: [
        {
          path,
          status: "passed",
          nodeExitCode: 0,
          signal: null,
          counts,
          tests: [
            {
              name: "Released controller remains usable after configured IAM activation",
              status: "passed",
              file: path,
            },
            {
              name: "Released controller remains usable across candidate database writes",
              status: "passed",
              file: path,
            },
          ],
          issues: [],
          cleanup: { status: "passed" },
          imageDigests: { releasedController, candidateController },
        },
        {
          path: "tests/integration/postgres-migration-version.test.ts",
          status: "passed",
          nodeExitCode: 0,
          signal: null,
          counts: { ...counts, passed: 1, total: 1 },
          tests: [
            {
              name: "Migration refuses PostgreSQL 16 before first installation or upgrade without exposing credentials",
              status: "passed",
              file: "tests/integration/postgres-migration-version.test.ts",
            },
          ],
          issues: [],
          cleanup: { status: "passed" },
        },
      ],
    };
  }

  test("controller compatibility preserves Agent continuity through interrupted upgrade recovery", async (t) => {
    const f = await controllerContinuityFixture(t, continuityFixture());
    const path = join(f.directory, "compatibility.json");
    const contents = JSON.stringify(controllerCompatibilityResults());
    await writeFile(path, contents);
    const flags = ["--controller-compatibility-results", path, ...continuityFlags];
    await f.failNext("lost-helm-response");
    await assert.rejects(f.run(...flags), injectedFault);
    const frozen = join(f.evidence, "controller-compatibility-results.json");
    await assertPrivateReceipt(frozen, contents);
    const continuityBefore = await f.readEvidence("agent-continuity.json");
    const before = await f.events();

    // Neither a replacement nor deletion of prepared evidence can change the
    // compatibility decision after a committed Helm submission.
    await writeFile(frozen, "{}");
    await assert.rejects(f.run(...flags, "--resume"), /prepared upgrade evidence changed/);
    await rm(frozen);
    await assert.rejects(f.run(...flags, "--resume"), /prepared upgrade evidence changed/);
    assert.deepEqual(await f.events(), before);
    await writeFile(frozen, contents, { mode: 0o600 });

    // The original external file is no longer an input: only its frozen copy is.
    await rm(path);
    await f.run(...flags, "--resume");
    await assertPrivateReceipt(frozen, contents);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    assert.equal(await f.readEvidence("agent-continuity.json"), continuityBefore);
    const continuityAfter = await readContinuityEvidence(f, "agent-continuity-after.json");
    assert.equal(continuityAfter.revisionId, continuityRevision);
    assert.ok(existsSync(join(f.evidence, "completed")));
    assert.equal((await f.state()).dispatches, 0);
    assert.equal((await f.state()).api, 1);
    assert.equal((await f.state()).worker, 1);
  });

  async function assertCompatibilityReceiptRejected(
    t: TestContext,
    change: ChangeCompatibilityReceipt,
  ) {
    const f = await fixture(t, { controllerOnly: true });
    const receipt = controllerCompatibilityResults();
    change(receipt);
    const path = join(f.directory, "compatibility.json");
    await writeFile(path, JSON.stringify(receipt));
    await assert.rejects(
      f.run("--controller-compatibility-results", path),
      /controller compatibility receipt must pass/,
    );
    assert.deepEqual(await f.events(), []);
    return f;
  }

  test("controller compatibility rejects unqualified evidence before changing writers", async (t) => {
    const changes: Record<string, ChangeCompatibilityReceipt> = {
      "missing IAM activation": (r) => (r.files[0].tests[0].name = "Another passing case"),
      "IAM result from another file": (r) => (r.files[0].tests[0].file = r.files[1].path),
      "unselected green": (r) => (r.files[0].tests[1].name = "Another migration case"),
      "failed selected case": (r) => (r.files[0].tests[1].status = "failed"),
      "skipped selected case": (r) => (r.files[0].tests[1].status = "skipped"),
      "duplicate selected case": (r) => (r.files[0].tests[0].name = r.files[0].tests[1].name),
      "wrong test file": (r) => (r.files[0].tests[1].file = r.files[1].path),
      "duplicate matching file": (r) => (r.files[1].path = r.files[0].path),
      "failed cleanup": (r) => {
        assert.ok(r.files[0].cleanup);
        r.files[0].cleanup.status = "failed";
      },
      "missing cleanup": (r) => (r.files[0].cleanup = null),
      "skipped file case": (r) => (r.files[0].counts.skipped = 1),
      "failed runner": (r) => (r.status = "failed"),
      "aggregate summary": (r) => (r.command = "aggregate"),
      "missing runner provenance": (r) => (r.sourceSha = null),
      "reversed image roles": (r) => {
        const images = r.files[0].imageDigests;
        [images.releasedController, images.candidateController] = [
          images.candidateController,
          images.releasedController,
        ];
      },
      "different platform or config digest": (r) =>
        (r.files[0].imageDigests.candidateController = `sha256:${"d".repeat(64)}`),
    };
    for (const [name, change] of Object.entries(changes)) {
      await t.test(name, async (subtest) => {
        const f = await assertCompatibilityReceiptRejected(subtest, change);
        assert.equal((await f.state()).api, 1);
        assert.equal((await f.state()).worker, 1);
        assert.equal(existsSync(join(f.evidence, "prepared")), false);
      });
    }
  });

  test("controller compatibility rejects contradictory runner summaries", async (t) => {
    const changes: Record<string, ChangeCompatibilityReceipt> = {
      "failed unrelated test row": (r) => (r.files[0].tests[0].status = "failed"),
      "failed sibling file": (r) => (r.files[1].status = "failed"),
      "wrong total count": (r) => r.counts.total++,
      "multiple files in focused run": (r) => (r.scope = "focused"),
    };
    for (const [name, change] of Object.entries(changes)) {
      await t.test(name, async (subtest) => {
        await assertCompatibilityReceiptRejected(subtest, change);
      });
    }
  });

  test("controller compatibility rejects passing summaries with explicit failure evidence", async (t) => {
    const changes: Record<string, ChangeCompatibilityReceipt> = {
      // The native producer recognizes marker presence, including false and empty
      // values. A row carrying either marker cannot be a passed test.
      "skip marker": (r) => (r.files[0].tests[1].skip = false),
      "todo marker": (r) => (r.files[0].tests[1].todo = ""),
      "root file failure": (r) => (r.files[1].fileFailure = { error: { message: "test failed" } }),
      "empty sibling file": (r) => {
        r.files[1].tests = [];
        r.files[1].counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
        r.counts = { ...r.files[0].counts };
      },
    };
    for (const [name, change] of Object.entries(changes)) {
      await t.test(name, async (subtest) => {
        await assertCompatibilityReceiptRejected(subtest, change);
      });
    }
  });

  test("controller compatibility requires a value and an explicit controller selection", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.run("--controller-compatibility-results", ""),
      /requires a nonempty value/,
    );
    await assert.rejects(
      f.run("--controller-compatibility-results", join(f.directory, "unused.json")),
      /requires --controller-image/,
    );
    assert.deepEqual(await f.events(), []);
  });
}
