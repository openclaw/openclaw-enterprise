import assert from "node:assert/strict";
import { after } from "node:test";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { RepositoryCredentialAuthorityError } from "../../apps/controller/src/worker/repository-credentials.ts";
import {
  ActivationFailedError,
  ActivationPendingError,
  CredentialSourceRevisionError,
  KubernetesSecretWriteForbiddenError,
  SandboxGatewayUnavailableError,
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { withFailedCleanup } from "../helpers/compute-cleanup-failure.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { completedPasses, completion } from "../helpers/postgres-worker-revision-support.mjs";

// Finding 2268: a Compute Driver whose cleanup fails after a failed preparation or activation
// reports both failures, its own first. The worker decides by that first failure, as it would
// alone: a refusal fails the deployment at once, an outage waits within the convergence deadline.
// The failed cleanup stays in the pass's log line as `cleanupCause`. Before, every such failure
// retried five times as DEPENDENCY_UNAVAILABLE, or waited for the deadline in activation. The
// lane runs the revision files at once.

const { cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

type RevisionFixture = Awaited<
  ReturnType<ReturnType<typeof createWorkerRevisionFixtures>["setup"]>
>;
type Admitted = Awaited<ReturnType<RevisionFixture["admitInitialRevision"]>>;

/** The `worker.completed` fields these cases read. */
interface WorkerEvent {
  readonly event?: string;
  readonly workId?: string;
  readonly revisionId?: string;
  readonly outcome?: string;
  readonly code?: string;
  readonly cause?: string;
  readonly dependency?: string;
  readonly cleanupCause?: string;
}

/** The worker's raw events, and the log lines its sanitizing emitter writes for them. */
function capturedLogs() {
  const events: WorkerEvent[] = [];
  const lines: WorkerEvent[] = [];
  const logged = createWorkerLogEmitter(
    createOccLogger({
      component: "occ-worker",
      level: "debug",
      destination: {
        write(chunk: string) {
          for (const line of String(chunk).split("\n")) {
            if (line.length > 0) {
              lines.push(JSON.parse(line) as WorkerEvent);
            }
          }
          return true;
        },
      },
    }),
  );
  return {
    events,
    lines,
    emit(event: Readonly<Record<string, unknown>>) {
      events.push(event as WorkerEvent);
      logged(event);
    },
  };
}

function passFields({ outcome, code, cause, dependency, cleanupCause }: WorkerEvent) {
  return { outcome, code, cause, dependency, cleanupCause };
}

revisionTest(
  "a refusal whose Compute cleanup also failed fails deployment on the first attempt",
  async (fixture: RevisionFixture) => {
    // One deployment per refusal the worker fails at once when it comes alone.
    type Refusal = { readonly label: string; readonly failure: () => Error; readonly code: string };
    const refusals: readonly Refusal[] = [
      {
        label: "secret-forbidden",
        failure: () => new KubernetesSecretWriteForbiddenError(),
        code: "KUBERNETES_SECRET_WRITE_FORBIDDEN",
      },
      {
        label: "repository-authority",
        failure: () => new RepositoryCredentialAuthorityError("REPOSITORY_RUNTIME_UNSUPPORTED"),
        code: "REPOSITORY_RUNTIME_UNSUPPORTED",
      },
      {
        label: "activation-failed",
        failure: () =>
          new ActivationFailedError(
            "AGENT_GATEWAY_UNAUTHORIZED",
            "The exact AgentRevision gateway refused its own CLI as unauthorized.",
          ),
        code: "AGENT_GATEWAY_UNAUTHORIZED",
      },
      {
        label: "credential-source",
        failure: () =>
          new CredentialSourceRevisionError(
            "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
            "Two credential sources bound to the revision use the same environment variable.",
          ),
        code: "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
      },
      {
        label: "sandbox-unsupported",
        failure: () =>
          new SandboxRevisionUnsupportedError(
            "SANDBOX_HARNESS_UNSUPPORTED",
            "The Sandbox Driver cannot run this Harness.",
          ),
        code: "SANDBOX_HARNESS_UNSUPPORTED",
      },
    ];
    const cases: (Refusal & Admitted & { preparations: number })[] = [];
    for (const refusal of refusals) {
      const admitted = await fixture.admitInitialRevision(`cleanup-refusal-${refusal.label}`);
      cases.push({ ...refusal, ...admitted, preparations: 0 });
    }
    const logs = capturedLogs();
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision: { readonly id: string }) {
          const scenario = cases.find(({ candidate }) => candidate.id === revision.id);
          assert.ok(scenario, "only the admitted cases deploy");
          scenario.preparations += 1;
          throw withFailedCleanup(scenario.failure());
        },
      },
      { emit: logs.emit },
    );
    for (const scenario of cases) {
      const failed = await fixture.work(scenario.candidate, "failed_permanent", 30_000);
      const { rows } = await fixture.workResult(scenario.candidate);
      assert.deepEqual(
        {
          code: rows[0]?.reason_code,
          attempts: failed.attempt_count,
          preparations: scenario.preparations,
        },
        { code: scenario.code, attempts: 1, preparations: 1 },
        scenario.label,
      );
      // The log line can follow the committed failure (finding 1607): wait for it.
      const passes: WorkerEvent[] = await completedPasses(
        logs.events,
        scenario.candidate,
        "permanent",
      );
      assert.deepEqual(
        passes.map(passFields),
        [
          {
            outcome: "permanent",
            code: scenario.code,
            cause: scenario.failure().name,
            dependency: undefined,
            cleanupCause: "Error",
          },
        ],
        scenario.label,
      );
      // The operator's log keeps the failed cleanup too.
      const line = logs.lines.find(
        (entry) => entry.event === "worker.completed" && entry.revisionId === scenario.candidate.id,
      );
      assert.equal(line?.cleanupCause, "Error", scenario.label);
    }
  },
);

// A Sandbox gateway outage reaches the worker as its own error class, which the worker wraps as a
// transient dependency failure; the failed cleanup follows that wrapper into the log.
for (const outage of [
  {
    label: "Kubernetes API",
    failure: () =>
      new TransientDependencyError(
        "kubernetes_api",
        "unavailable",
        "The Kubernetes API answered HTTP 503.",
      ),
    code: "KUBERNETES_API_UNAVAILABLE",
    dependency: "kubernetes_api",
  },
  {
    label: "Sandbox gateway",
    failure: () =>
      new SandboxGatewayUnavailableError("OpenShell CreateSandbox failed with gRPC status 14."),
    code: "SANDBOX_GATEWAY_UNAVAILABLE",
    dependency: "sandbox_gateway",
  },
]) {
  revisionTest(
    `a ${outage.label} outage whose Compute cleanup also failed waits past the attempt budget, then the deployment activates`,
    async (fixture: RevisionFixture) => {
      // Seven failed passes, more than the attempt budget (5): each waits as the outage alone does.
      const { owner, candidate } = await fixture.admitInitialRevision(
        `cleanup-outage-${outage.dependency}`,
      );
      const logs = capturedLogs();
      let failures = 0;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(...args: Parameters<typeof fixture.compute.prepareRevision>) {
            if (failures < 7) {
              failures += 1;
              throw withFailedCleanup(outage.failure());
            }
            return fixture.compute.prepareRevision(...args);
          },
        },
        { emit: logs.emit },
      );
      const succeeded = await fixture.work(candidate, "succeeded", 30_000);
      assert.equal(failures, 7);
      assert.equal(succeeded.attempt_count, 1);
      assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "succeeded");
      const passes: WorkerEvent[] = await completedPasses(logs.events, candidate);
      assert.deepEqual(
        passes.slice(0, 7).map(passFields),
        Array.from({ length: 7 }, () => ({
          outcome: "pending",
          code: outage.code,
          cause: "unavailable",
          dependency: outage.dependency,
          cleanupCause: "Error",
        })),
      );
    },
  );
}

// Both activation paths: the pass that publishes the active pointer, and a later pass that finds
// it already published.
for (const pendingPasses of [0, 1]) {
  revisionTest(
    `an activation refusal whose Compute cleanup also failed fails deployment at once (after ${pendingPasses} pending passes)`,
    async (fixture: RevisionFixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision(
        `cleanup-activation-${pendingPasses}`,
      );
      const logs = capturedLogs();
      let activations = 0;
      await fixture.start(
        {
          ...fixture.compute,
          async activateRevision() {
            activations += 1;
            if (activations <= pendingPasses) {
              throw new ActivationPendingError(
                "WORKSPACE_NODE_BINDING_PENDING",
                "The exact AgentRevision gateway has not applied its workspace node.",
              );
            }
            throw withFailedCleanup(
              new ActivationFailedError(
                "AGENT_GATEWAY_UNAUTHORIZED",
                "The exact AgentRevision gateway refused its own CLI as unauthorized.",
              ),
            );
          },
        },
        { emit: logs.emit },
      );
      await fixture.work(candidate, "failed_permanent", 30_000);
      assert.equal(activations, pendingPasses + 1);
      assert.equal(
        (await fixture.deploymentStatus(owner, candidate)).error?.code,
        "AGENT_GATEWAY_UNAUTHORIZED",
      );
      const passes: WorkerEvent[] = await completedPasses(logs.events, candidate, "permanent");
      assert.deepEqual(passFields(passes.at(-1)!), {
        outcome: "permanent",
        code: "AGENT_GATEWAY_UNAUTHORIZED",
        cause: "ActivationFailedError",
        dependency: undefined,
        cleanupCause: "Error",
      });
    },
  );
}

revisionTest(
  "a maintenance outage whose Compute cleanup also failed waits on its dependency and keeps the chain",
  async (fixture: RevisionFixture) => {
    // A running revision's maintenance pass keeps its chain on an outage, as for one alone, and
    // names the dependency instead of REVISION_FINALIZATION_INCOMPLETE.
    const { owner, candidate } = await fixture.admitInitialRevision("cleanup-maintenance");
    const logs = capturedLogs();
    let failing = false;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 200,
        async prepareRevision(...args: Parameters<typeof fixture.compute.prepareRevision>) {
          if (failing) {
            throw withFailedCleanup(
              new TransientDependencyError(
                "kubernetes_api",
                "unavailable",
                "The Kubernetes API answered HTTP 503.",
              ),
            );
          }
          return fixture.compute.prepareRevision(...args);
        },
      },
      { emit: logs.emit },
    );
    await fixture.work(candidate, "succeeded");
    failing = true;
    const maintenance = `agent_revision:${candidate.id}:maintenance:`;
    const failed: WorkerEvent = await completion(
      logs.events,
      "a maintenance pass that met the outage",
      (event: WorkerEvent) =>
        event.event === "worker.completed" &&
        event.workId?.startsWith(maintenance) === true &&
        event.outcome !== "success",
    );
    assert.deepEqual(passFields(failed), {
      outcome: "pending",
      code: "KUBERNETES_API_UNAVAILABLE",
      cause: "unavailable",
      dependency: "kubernetes_api",
      cleanupCause: "Error",
    });
    failing = false;
    await completion(
      logs.events,
      "a later maintenance pass to succeed",
      (event: WorkerEvent, index: number) =>
        index > logs.events.indexOf(failed) &&
        event.event === "worker.completed" &&
        event.workId?.startsWith(maintenance) === true &&
        event.outcome === "success",
    );
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, candidate.id);
  },
);
