import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type {
  AgentProvisioningResponse,
  ConfigurationDriver,
  ProvisionAgentBody,
  SecretWire,
} from "@openclaw-enterprise/contracts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createProvisioningFixture } from "./postgres-agent-provisioning-fixture.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createProvisioningFixture>>;
type FixtureOptions = Parameters<typeof createProvisioningFixture>[1];
type StopWorkerAfter = NonNullable<FixtureOptions["stopWorkerAfter"]>;
type ProvisioningSecrets = Record<
  "modelKey" | "slackBotToken" | "slackSigningSecret" | "externalServiceToken",
  SecretWire
>;
type ProvisioningBody = ProvisionAgentBody & {
  configuration: { values: { agents: { defaults: unknown } } };
};

interface AdmissionDependencies {
  createFixture: (context: TestContext, options: FixtureOptions) => Promise<Fixture>;
  createProvisioningSecrets: (
    fixture: Fixture,
    namespaceId: string,
  ) => Promise<ProvisioningSecrets>;
  provisioningBody: (namespaceId: string, secrets: ProvisioningSecrets) => ProvisioningBody;
}

export function observeProvisioningRetry() {
  let workId: string | undefined;
  const completed: Parameters<StopWorkerAfter>[0][] = [];

  // The retry can be due at once. Stop in the same pass as the matching completion (finding 1610).
  // Until the provisioning work ID is known, this allows Namespace bootstrap to run normally.
  const stopWorkerAfter: StopWorkerAfter = (event) => {
    if (workId === undefined || event.event !== "worker.completed" || event.workId !== workId) {
      return false;
    }
    completed.push(event);
    return true;
  };

  async function expectQueuedRetry(fixture: Fixture, targetWorkId: string) {
    workId = targetWorkId;
    await fixture.startWorker();
    await waitFor("the worker to finish its first provisioning attempt", async () => completed[0]);
    await fixture.stopWorker();
    assert.deepEqual(
      completed.map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [{ attempt: 1, outcome: "retry", code: "PROVISIONING_DEPENDENCY_UNAVAILABLE" }],
    );
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(work.rows, [{ state: "queued", reason_code: null, attempt_count: 1 }]);
  }

  return { stopWorkerAfter, expectQueuedRetry };
}

export function createProvisioningDependencySetup({
  createFixture,
  createProvisioningSecrets,
  provisioningBody,
}: AdmissionDependencies) {
  async function admitPlan(fixture: Fixture, configure?: (body: ProvisioningBody) => void) {
    const { id: namespaceId } = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespaceId);
    const body = provisioningBody(namespaceId, secrets);
    configure?.(body);
    const provisionPath = `/namespaces/${namespaceId}/agents/provision`;
    const admitted = await fixture.request<AgentProvisioningResponse["data"]>(
      "POST",
      provisionPath,
      { body },
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.ok(admitted.data);
    const { workId, url } = admitted.data.provisioning;
    return { namespaceId, body, provisionPath, workId, url };
  }

  async function preparePluginSwitch(
    context: TestContext,
    configurationDriver: ConfigurationDriver,
  ) {
    const drivers = {
      computeDriver: createRuntimeComputeDriver(),
      configurationDriver,
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
    };
    const fixture = await createFixture(context, {
      ...drivers,
      pluginDriver: new CodexPluginDriver(),
    });
    const admitted = await admitPlan(fixture, (body) => {
      body.plugins = { "codex-plugin:linear@openai-curated-remote": { enabled: true } };
    });
    return {
      ...admitted,
      fixture,
      switchPluginDriver: () =>
        createFixture(context, { ...drivers, pluginDriver: new OCCPluginDriver() }),
    };
  }

  return { admitPlan, preparePluginSwitch };
}
