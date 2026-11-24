import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  AgentRevision,
  ComputeReadiness,
  PluginDeploymentWarning,
  PluginDesiredSelection,
  PluginDriver,
  PluginRevisionState,
} from "../../packages/contracts/src/index.ts";
import type {
  ControllerWork,
  ControllerWorkState,
} from "../../packages/occ/src/controller-work.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

type RevisionFixture = Awaited<
  ReturnType<ReturnType<typeof createWorkerRevisionFixtures>["setup"]>
>;
type RuntimeDrivers = NonNullable<ControllerWorkerOptions["drivers"]>;
type RevisionCase = (fixture: RevisionFixture, context: TestContext) => Promise<void>;

export interface MutablePluginRevisionState {
  driver: PluginRevisionState["driver"];
  plugins: Record<string, PluginDesiredSelection>;
}

interface PluginCaseDependencies {
  codexPluginRevisionState(pluginId: string): MutablePluginRevisionState;
  withBothPluginDrivers(drivers: RuntimeDrivers): RuntimeDrivers;
  createOccPluginDriver(): PluginDriver;
}

interface TerminalRow {
  state: ControllerWorkState;
  reason_code: string | null;
  result_data: NonNullable<ControllerWork["resultData"]> | null;
}

type MissingPinFixture = Pick<
  RevisionFixture,
  | "admitInitialRevision"
  | "advanceMaintenance"
  | "compute"
  | "currentAgent"
  | "revision"
  | "start"
  | "work"
  | "workResult"
>;
type WarningFixture = Pick<
  RevisionFixture,
  | "admitInitialRevision"
  | "compute"
  | "currentAgent"
  | "namespace"
  | "observerPool"
  | "start"
  | "work"
>;
type StartupFixture = WarningFixture & {
  deploymentStatus(
    owner: Pick<Agent, "id">,
    candidate: Pick<AgentRevision, "id">,
  ): ReturnType<RevisionFixture["deploymentStatus"]>;
};
type PostPointerFixture = WarningFixture & Pick<RevisionFixture, "state">;

export function observePluginTerminalRow(pool: Pool, idempotencyKey: string) {
  return pool.query<TerminalRow, [string]>(
    "SELECT state, reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
    [idempotencyKey],
  );
}

function admitDedicatedPlugin(
  fixture: Pick<RevisionFixture, "admitInitialRevision">,
  label: string,
  plugins: PluginRevisionState,
) {
  return fixture.admitInitialRevision(label, {
    agent: { executionMode: "dedicated" },
    revision: { plugins },
  });
}

function readyWithWarnings(
  revision: Pick<AgentRevision, "namespaceId" | "agentId" | "id">,
  warnings: readonly PluginDeploymentWarning[],
): ComputeReadiness {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    ready: true,
    warnings,
  };
}

export function createPluginRevisionCases({
  codexPluginRevisionState,
  withBothPluginDrivers,
  createOccPluginDriver,
}: PluginCaseDependencies) {
  async function missingPinnedPluginDriver(fixture: MissingPinFixture) {
    const { owner, candidate: previous } = await fixture.admitInitialRevision("plugin-cutover", {
      agent: { executionMode: "dedicated" },
    });
    await fixture.start(
      {
        ...fixture.compute,
        requiresStoppedPredecessors: () => true,
        maintenanceIntervalMs: 3_600_000,
        async stopRevision(revision) {
          assert.notEqual(
            revision.id,
            previous.id,
            "a rejected plugin pin cannot stop the active revision",
          );
          return fixture.compute.stopRevision(revision);
        },
      },
      { transformDrivers: (drivers) => ({ ...drivers, pluginDrivers: [createOccPluginDriver()] }) },
    );
    await fixture.work(previous, "succeeded");
    // The admitted revision pins Codex, but this worker no longer has that Driver.
    const next = await fixture.revision(owner, 2, {
      plugins: codexPluginRevisionState("codex-plugin:linear@openai-curated-remote"),
    });
    await fixture.work(next, "failed_permanent");
    const refusal = asRecord((await fixture.workResult(next)).rows[0]);
    assert.ok(refusal, "the rejected revision must have a terminal work result");
    assert.equal(refusal.reason_code, "PLUGIN_DRIVER_MISMATCH");
    const nextMaintenance = asRecord((await fixture.advanceMaintenance(previous)).rows[0]);
    assert.ok(nextMaintenance, "the predecessor must retain its maintenance work");
    const maintenanceKey = nextMaintenance.idempotency_key;
    assert.ok(typeof maintenanceKey === "string", "maintenance work must have an idempotency key");
    const maintenance = { ...previous, idempotencyKey: maintenanceKey };
    await fixture.work(maintenance, "succeeded");
    const maintained = asRecord((await fixture.workResult(maintenance)).rows[0]);
    assert.ok(maintained, "the predecessor maintenance must have a terminal result");
    assert.equal(maintained.reason_code, "REVISION_ALREADY_ACTIVE");
    const active = await fixture.currentAgent(owner);
    assert.ok(active, "the existing Agent must remain present");
    assert.equal(active.activeRevisionId, previous.id);
  }

  async function pluginStartupWarnings(fixture: StartupFixture) {
    const pluginId = "codex-plugin:linear@openai-curated-remote";
    const otherPluginId = "codex-plugin:calendar@openai-curated-remote";
    const warnings: PluginDeploymentWarning[] = [
      { code: "PLUGIN_AUTH_REQUIRED", pluginId },
      { code: "PLUGIN_INSTALL_FAILED", pluginId: otherPluginId },
    ];
    const pluginState = codexPluginRevisionState(pluginId);
    pluginState.plugins[otherPluginId] = {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
    };
    const { owner, candidate } = await admitDedicatedPlugin(fixture, "plugin-warning", pluginState);
    const prepared: string[] = [];

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          prepared.push(revision.id);
          if (revision.id !== candidate.id) {
            return fixture.compute.prepareRevision(revision);
          }
          return readyWithWarnings(revision, warnings);
        },
      },
      { transformDrivers: withBothPluginDrivers },
    );

    await fixture.work(candidate, "succeeded");
    const terminal = await observePluginTerminalRow(fixture.observerPool, candidate.idempotencyKey);
    assert.deepEqual(terminal.rows, [
      {
        state: "succeeded",
        reason_code: "REVISION_ACTIVATED",
        result_data: { warnings },
      },
    ]);
    const active = await fixture.currentAgent(owner);
    assert.ok(active, "the deployed Agent must exist");
    assert.equal(active.activeRevisionId, candidate.id);
    assert.deepEqual(prepared, [candidate.id]);
    // The public status projection reads the persisted result through OCC;
    // individual plugin failures must not turn a successful deployment into an error.
    assert.deepEqual(await fixture.deploymentStatus(owner, candidate), {
      deploymentId: candidate.id,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      status: "succeeded",
      error: null,
      warnings,
      progress: null,
      cleanup: null,
    });
  }

  async function pluginWarningsAfterPointer(fixture: PostPointerFixture) {
    const pluginId = "codex-plugin:github@openai-curated-remote";
    const { owner, candidate } = await admitDedicatedPlugin(
      fixture,
      "plugin-post-pointer-warning",
      codexPluginRevisionState(pluginId),
    );
    const published = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        undefined,
        candidate.id,
      ),
    );
    assert.ok(published, "the active pointer publication must return the Agent");
    assert.equal(published.activeRevisionId, candidate.id);

    let prepareCount = 0;
    const activations: string[] = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          prepareCount += 1;
          return readyWithWarnings(revision, [{ code: "PLUGIN_INSTALL_FAILED", pluginId }]);
        },
        async activateRevision(revision) {
          activations.push(revision.id);
        },
      },
      { transformDrivers: withBothPluginDrivers },
    );

    await fixture.work(candidate, "succeeded");
    assert.equal(prepareCount, 1);
    assert.deepEqual(activations, [candidate.id]);
    const terminal = await observePluginTerminalRow(fixture.observerPool, candidate.idempotencyKey);
    assert.deepEqual(terminal.rows, [
      {
        state: "succeeded",
        reason_code: "REVISION_ALREADY_ACTIVE",
        result_data: { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }] },
      },
    ]);
  }

  async function foreignPluginWarnings(fixture: WarningFixture) {
    const pluginId = "codex-plugin:slack@openai-curated-remote";
    const { owner, candidate } = await admitDedicatedPlugin(
      fixture,
      "foreign-plugin-diagnostic",
      codexPluginRevisionState(pluginId),
    );
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return readyWithWarnings(revision, [
            {
              code: "PLUGIN_INSTALL_FAILED",
              pluginId: "codex-plugin:foreign@openai-curated-remote",
            },
          ]);
        },
      },
      { transformDrivers: withBothPluginDrivers },
    );

    await fixture.work(candidate, "failed_permanent");
    const generic = await observePluginTerminalRow(fixture.observerPool, candidate.idempotencyKey);
    assert.deepEqual(generic.rows, [
      {
        state: "failed_permanent",
        reason_code: "INVALID_DRIVER_OBSERVATION",
        result_data: null,
      },
    ]);
    const inactive = await fixture.currentAgent(owner);
    assert.ok(inactive, "the existing Agent must remain present");
    assert.equal(inactive.activeRevisionId, undefined);
  }

  return {
    missingPinnedPluginDriver,
    pluginStartupWarnings,
    pluginWarningsAfterPointer,
    foreignPluginWarnings,
  } satisfies Record<string, RevisionCase>;
}
