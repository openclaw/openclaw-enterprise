import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  AgentDeploymentStatusResponse,
  AgentResponse,
  AgentRevisionResponse,
  ErrorResponse,
  FirstDeploymentReceiptResponse,
  type ChannelDriver,
  type Permission,
} from "../../packages/contracts/src/index.ts";
import type { PlatformReadView } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { request } from "./occ-api-first-deployment-cases.ts";
import {
  firstDeploymentFixture,
  slackFirstDeploymentFixture,
} from "./occ-api-first-deployment-fixture.ts";
import {
  checkedInjectedBody,
  createAgent,
  createConfiguration,
  createNamespace,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

const PermissionSchema = Type.Object({
  action: Type.String(),
  resourceKind: Type.String(),
  scope: Type.String(),
  phase: Type.Optional(Type.String()),
  condition: Type.Optional(Type.String()),
});
const OperationSchema = Type.Object({
  operationId: Type.String(),
  "x-openclaw-permissions": Type.Array(PermissionSchema),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForRequestBarrier(barrier: Promise<void>, pending: ReturnType<FixtureRequest>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Request did not reach the expected barrier")), 5000);
  });
  try {
    await Promise.race([
      barrier,
      pending.then(() => {
        throw new Error("Request completed before reaching the expected barrier");
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settlePendingRequests(requests: readonly ReturnType<FixtureRequest>[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Pending request did not settle after barrier release")),
      2000,
    );
  });
  try {
    await Promise.race([Promise.allSettled(requests), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test("guarded first deployment with the bundled Slack selection recovers without writes", async () => {
  const deployment = await firstDeploymentFixture();
  const { controller, namespace, agent, path, intent, recover, work, secretDriver, providerCalls } =
    deployment;
  const schemaApp = controller.fixture.createApp(undefined, createFastifyApp);
  let operations: unknown[];
  try {
    await schemaApp.ready();
    operations = Object.values(schemaApp.swagger().paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}),
    );
  } finally {
    await schemaApp.close();
  }
  const permissions = (id: string) => {
    const operation = operations.find(
      (value) => Check(OperationSchema, value) && value.operationId === id,
    );
    assert(Check(OperationSchema, operation), `missing operation ${id}`);
    return operation["x-openclaw-permissions"];
  };
  assert.deepEqual(permissions("recoverAgentFirstDeployment"), [
    { action: "deploy", resourceKind: "agent", scope: "requested" },
    { action: "read", resourceKind: "configuration", scope: "requested" },
  ]);
  const guardedPermissions = permissions("deployAgentFirst");
  assert.deepEqual(
    guardedPermissions.map(({ phase, ...permission }) => permission),
    permissions("deployAgent"),
  );
  assert.deepEqual(
    guardedPermissions.filter((permission) => permission.phase === undefined),
    permissions("recoverAgentFirstDeployment"),
  );
  assert.ok(
    guardedPermissions.some(
      (permission) =>
        permission.phase === "fresh_admission" &&
        permission.condition === "missing_runtime_credentials",
    ),
  );
  // A receipt miss and later replay must remain read-only and avoid provider calls.
  const before = controller.fixture.auditSink.events.length;
  const miss = await recover();
  assert.equal(miss.status, 200, JSON.stringify(miss.body));
  assert.equal(miss.data, null);
  assert.equal(miss.headers.get("cache-control"), "no-store");
  assert.equal(work().length, 0);
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(controller.fixture.auditSink.events.length, before);
  // Discard the reply so recovery must observe the state owned by the revision store.
  await controller.request("POST", `${path}/deploy-first`, { body: intent });
  const [stored] = await deployment.listRevisions();
  assert.ok(stored);
  const calls = secretDriver.calls.length;
  const events = controller.fixture.auditSink.events.length;
  const found = await recover();
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.deepEqual(found.data, {
    revisionId: stored.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    configurationGeneration: 1,
    createdAt: stored.createdAt,
  });
  const replay = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assert.equal(replay.status, 202, JSON.stringify(replay.body));
  assert.deepEqual(replay.data, found.data);
  assert.equal(secretDriver.calls.length, calls);
  assert.equal(controller.fixture.auditSink.events.length, events);
  assert.equal(work().length, 1);
  assert.equal(providerCalls(), 0);
  for (const altered of [
    { ...intent, key: "other" },
    { ...intent, expectedGeneration: 2 },
  ]) {
    assert.equal((await recover(altered)).data, null);
    const conflict = await controller.request("POST", `${path}/deploy-first`, { body: altered });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    const { error } = checkedInjectedBody(conflict, 409, ErrorResponse);
    assert.match(error.message, /already has revision history/);
    assert.match(error.message, /Recover the original first-deployment receipt/);
    assert.match(error.message, /ordinary deploy only for an intentional later revision/);
  }
  const ordinary = await controller.request("POST", `${path}/deploy`);
  assert.equal(ordinary.status, 202, JSON.stringify(ordinary.body));
  const ordinaryRevision = checkedInjectedBody(ordinary, 202, AgentRevisionResponse).data;
  assert.equal(ordinaryRevision.revision, 2);
  const replacement = await createConfiguration(controller, namespace.id);
  assert.equal(
    (await controller.request("PATCH", path, { body: { configurationId: replacement.id } })).status,
    200,
  );
  assert.deepEqual((await recover()).data, found.data);
  assert.equal((await recover({ ...intent, expectedConfigurationId: replacement.id })).data, null);
  assert.equal(work().length, 2);
  assert.equal((await controller.request("POST", `${path}/stop`)).status, 202);
  assert.equal(
    (
      await controller.request("POST", `${path}/deploy-first`, {
        body: { ...intent, key: "new-intent", expectedConfigurationId: replacement.id },
      })
    ).status,
    409,
  );

  for (const revision of await deployment.listRevisions()) {
    for (const field of ["key", "actorId", "firstDeploymentDigest", "first_deployment_digest"]) {
      assert.equal(Object.hasOwn(revision, field), false);
      assert.equal(Object.hasOwn(ordinaryRevision, field), false);
    }
  }
});

test("guarded first deployment isolates actors and requires current exact authority", async () => {
  const { controller, namespace, agent, path, intent, recover, work } =
    await firstDeploymentFixture();
  const { fixture } = controller;
  const admitted = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  const receipt = checkedInjectedBody(admitted, 202, FirstDeploymentReceiptResponse).data;
  const actor = await fixture.createAuthPrincipal("another-deployer");
  fixture.state.identities.push(actor.principal);
  const role: { id: string; namespaceId: string; permissions: readonly Permission[] } = {
    id: "exact-deployer",
    namespaceId: namespace.id,
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  fixture.state.roles.push(role);
  for (const [kind, id] of [
    ["agent", agent.id],
    ["configuration", agent.configurationId],
  ] as const) {
    fixture.state.bindings.push({
      id: `exact-${kind}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: actor.principal.id,
      roleId: role.id,
      resourceKind: kind,
      resourceId: id,
    });
  }
  const otherActor = await recover(intent, { session: actor.session });
  assert.equal(otherActor.status, 200, JSON.stringify(otherActor.body));
  assert.equal(otherActor.data, null);
  assert.equal(otherActor.headers.get("cache-control"), "no-store");
  const collision = await controller.request("POST", `${path}/deploy-first`, {
    body: intent,
    session: actor.session,
  });
  assert.equal(collision.status, 409);
  // Exact revision-read authority admits status polling, but not intent recovery or admission.
  role.permissions = [{ action: "read", resourceKind: "agent_revision" }];
  fixture.state.bindings.push({
    id: "exact-status-revision",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: actor.principal.id,
    roleId: role.id,
    resourceKind: "agent_revision",
    resourceId: receipt.revisionId,
  });
  const revisionsBeforeStatusRead = await fixture.platformState.read((state) =>
    state.revisions.listRevisions(namespace.id, agent.id),
  );
  const workBeforeStatusRead = structuredClone(work());
  const status = await controller.request("GET", `${path}/deployments/${receipt.revisionId}`, {
    session: actor.session,
  });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(
    checkedInjectedBody(status, 200, AgentDeploymentStatusResponse).data.deploymentId,
    receipt.revisionId,
  );
  assert.equal((await recover(intent, { session: actor.session })).status, 403);
  assert.equal(
    (
      await controller.request("POST", `${path}/deploy-first`, {
        body: intent,
        session: actor.session,
      })
    ).status,
    403,
  );
  assert.deepEqual(
    await fixture.platformState.read((state) =>
      state.revisions.listRevisions(namespace.id, agent.id),
    ),
    revisionsBeforeStatusRead,
  );
  assert.deepEqual(work(), workBeforeStatusRead);
  // Revocation applies to the original actor as well, even though its digest matches.
  const administrator = fixture.state.roles[0];
  assert(administrator);
  const previous = administrator.permissions;
  fixture.state.roles[0] = {
    ...administrator,
    permissions: [{ action: "read", resourceKind: "agent" }],
  };
  const revoked = await recover();
  assert.equal(revoked.status, 403);
  assert.equal(revoked.headers.get("cache-control"), "no-store");
  fixture.state.roles[0] = {
    ...administrator,
    permissions: [{ action: "deploy", resourceKind: "agent" }],
  };
  assert.equal((await recover()).status, 403);
  fixture.state.roles[0] = {
    ...administrator,
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  const minimalRecovery = await recover();
  assert.equal(minimalRecovery.status, 200, JSON.stringify(minimalRecovery.body));
  assert.deepEqual(minimalRecovery.data, admitted.data);
  const minimalReplay = await controller.request("POST", `${path}/deploy-first`, {
    body: intent,
  });
  assert.equal(minimalReplay.status, 202, JSON.stringify(minimalReplay.body));
  assert.deepEqual(minimalReplay.data, admitted.data);
  fixture.state.roles[0] = { ...administrator, permissions: previous };
  const otherAgent = await createAgent(controller, namespace.id, "another-agent");
  const otherPath = `/namespaces/${namespace.id}/agents/${otherAgent.id}/deploy-first`;
  assert.equal(
    (
      await controller.request(
        "GET",
        `${otherPath}/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
      )
    ).data,
    null,
  );
  const foreign = await createNamespace(controller, "foreign-intent");
  const cross = await controller.request(
    "GET",
    `/namespaces/${foreign.id}/agents/${agent.id}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
  );
  assert.equal(cross.status, 404);
  assert.equal(work().length, 1);
});

test("guarded first deployment rejects stale binding and generation before credential work", async () => {
  for (const change of ["binding", "generation"]) {
    const { controller, namespace, path, intent, work, secretDriver } =
      await firstDeploymentFixture();
    if (change === "binding") {
      const replacement = await createConfiguration(controller, namespace.id);
      assert.equal(replacement.generation, intent.expectedGeneration);
      assert.equal(
        (await controller.request("PATCH", path, { body: { configurationId: replacement.id } }))
          .status,
        200,
      );
    } else {
      assert.equal(
        (
          await controller.request(
            "PATCH",
            `/namespaces/${namespace.id}/configurations/${intent.expectedConfigurationId}`,
            { body: { values: {} } },
          )
        ).status,
        200,
      );
    }
    // A stale binding or generation must be rejected from the snapshot before admission.
    secretDriver.calls.length = 0;
    const iam = controller.fixture.iamDriver;
    const authorize = iam.authorize.bind(iam);
    iam.authorize = async (request) => {
      if (request.resource.kind === "configuration") {
        assert.equal(
          request.resource.id,
          intent.expectedConfigurationId,
          "must not expose a different draft",
        );
      }
      return authorize(request);
    };
    const state = controller.fixture.platformState;
    const transact = state.transact.bind(state);
    let mutations = 0;
    state.transact = (...args) => {
      mutations++;
      return transact(...args);
    };
    const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    const { error } = checkedInjectedBody(result, 409, ErrorResponse);
    assert.match(
      error.message,
      change === "binding" ? /different Configuration/ : /expected Configuration generation/,
    );
    assert.match(error.message, /Recover the original first-deployment receipt/);
    assert.doesNotMatch(error.message, /ordinary deploy/);
    assert.equal(secretDriver.calls.length, 0);
    assert.equal(work().length, 0);
    assert.equal(mutations, 0, "a stale snapshot must not enter admission");
  }
});

test(
  "guarded first deployment serializes fresh Slack contenders after concurrent preparation",
  { timeout: 10000 },
  async (t) => {
    for (const matching of [false, true]) {
      let arrivals = 0;
      const both = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { controller, path, intent, work, recover, secretDriver, providerCalls } =
        await slackFirstDeploymentFixture(true, async () => {
          if (++arrivals === 2) {
            both.resolve();
          }
          await release.promise;
        });
      const before = controller.fixture.auditSink.events.length;
      const intents = [intent, matching ? intent : { ...intent, key: "competing" }];
      // Both contenders finish provider preparation before either can commit admission.
      const requests = intents.map((body) =>
        controller.request("POST", `${path}/deploy-first`, { body }),
      );
      try {
        await waitForRequestBarrier(both.promise, Promise.race(requests));
        release.resolve();
        const results = await Promise.all(requests);
        assert.deepEqual(
          results.map((result) => result.status).sort(),
          matching ? [202, 202] : [202, 409],
        );
        assert.equal(work().length, 1);
        assert.equal(controller.fixture.auditSink.events.length - before, 1);
        const winner = results.findIndex((result) => result.status === 202);
        const winningIntent = intents[winner];
        const winningResult = results[winner];
        assert(winningIntent && winningResult);
        const receipt = await recover(winningIntent);
        assert.deepEqual(receipt.data, winningResult.data);
        if (matching) {
          assert.deepEqual(results[0]?.data, results[1]?.data);
        }
        assert.equal(providerCalls(), 2);
        assert.equal(secretDriver.calls.filter((call) => call.operation === "withValue").length, 2);
        assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 2);
        t.diagnostic(
          JSON.stringify({ matching, sender: 2, withValue: 2, resolve: 2, work: 1, audit: 1 }),
        );
      } finally {
        release.resolve();
        await settlePendingRequests(requests);
      }
    }
  },
);

test("guarded first deployment supports trusted registered validators and hides unknown failures", async () => {
  for (const fails of [false, true]) {
    const { controller, path, intent, secretDriver, work } = await firstDeploymentFixture();
    let calls = 0;
    const custom: ChannelDriver = {
      id: "custom-channel",
      implementation: "test",
      capability: "channel",
      enableRouting: () => [],
      async lookupDirectory() {
        assert.fail("Unexpected directory lookup");
      },
      async validateCredentials() {
        calls++;
        if (fails) {
          throw new Error("synthetic-private-validator-detail");
        }
      },
    };
    controller.fixture.controller.registerDriver(custom);
    controller.fixture.controller.selectDriver("channel", custom.id);
    const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
    assert.equal(result.status, fails ? 500 : 202, JSON.stringify(result.body));
    assert.equal(calls, 1);
    assert.equal(work().length, fails ? 0 : 1);
    if (fails) {
      assert.equal(secretDriver.calls.length, 0);
      assert.equal(
        JSON.stringify(result.body).includes("synthetic-private-validator-detail"),
        false,
      );
      assert.equal(
        JSON.stringify(controller.fixture.auditSink.events).includes(
          "synthetic-private-validator-detail",
        ),
        false,
      );
    }
  }
});

test("guarded first deployment rechecks configuration after outside-transaction validation", async () => {
  for (const change of [
    "binding",
    "generation",
    "configuration",
    "configuration-driver",
    "channel",
    "late-channel",
    "late-configuration",
  ]) {
    const { controller, namespace, agent, path, intent, secretDriver, work } =
      await firstDeploymentFixture();
    const replacement = await createConfiguration(controller, namespace.id);
    const state = controller.fixture.platformState;
    const originalTransact = state.transact;
    const transact = originalTransact.bind(state);
    const { promise: validated, resolve: reached } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    let pause = true;
    state.transact = async (operation) => {
      // The real Configuration and Slack validators have returned; admission has not locked.
      if (pause) {
        pause = false;
        reached();
        await released;
      }
      return transact(operation);
    };
    const admission = controller.request("POST", `${path}/deploy-first`, { body: intent });
    try {
      await waitForRequestBarrier(validated, admission);
      if (change === "binding" || change === "generation") {
        const updated =
          change === "binding"
            ? await controller.request("PATCH", path, {
                body: { configurationId: replacement.id },
              })
            : await controller.request(
                "PATCH",
                `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
                { body: { values: { temperature: "1" } } },
              );
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
      } else if (change === "late-channel" || change === "late-configuration") {
        const driver =
          change === "late-channel"
            ? new SlackChannelDriver(async () => assert.fail("Unexpected provider"))
            : createTestConfigurationDriver({ id: "late-configuration" });
        if (change === "late-channel") {
          Object.defineProperty(driver, "id", { value: "late-channel" });
        }
        controller.fixture.controller.registerDriver(driver);
        // The second Configuration validation runs inside admission, after its
        // initial Driver checks. A database lock cannot prevent this selection change.
        controller.fixture.configurationDriver.validate = async () => {
          controller.fixture.controller.selectDriver(driver.capability, driver.id);
        };
      } else if (change === "configuration") {
        const driver = controller.fixture.configurationDriver;
        const saved = await driver.read({ namespaceId: namespace.id, id: agent.configurationId });
        await driver.update({ ...saved, values: { temperature: "1" } });
      } else if (change === "configuration-driver") {
        const driver = createTestConfigurationDriver({ id: "replacement-configuration" });
        controller.fixture.controller.registerDriver(driver);
        controller.fixture.controller.selectDriver("configuration", driver.id);
      } else if (change === "channel") {
        const driver = new SlackChannelDriver(async () => assert.fail("Unexpected provider"));
        Object.defineProperty(driver, "id", { value: "replacement-channel" });
        controller.fixture.controller.registerDriver(driver);
        controller.fixture.controller.selectDriver("channel", driver.id);
      }
      release();
      const result = await admission;
      assert.equal(result.status, 409, JSON.stringify(result.body));
      if (["binding", "generation", "configuration"].includes(change)) {
        const error = checkedInjectedBody(result, 409, ErrorResponse).error;
        assert.match(error.message, /Recover the original first-deployment receipt/);
        assert.doesNotMatch(error.message, /ordinary deploy/);
      }
      assert.equal(secretDriver.calls.length, change.startsWith("late-") ? 1 : 0);
      if (change.startsWith("late-")) {
        assert.equal(secretDriver.calls[0]?.operation, "resolve");
      }
      assert.equal(work().length, 0);
    } finally {
      release();
      try {
        await settlePendingRequests([admission]);
      } finally {
        state.transact = originalTransact;
      }
    }
  }
});

test("guarded first deployment rechecks Agent and Configuration authority before credential effects", async (t) => {
  for (const authority of ["deploy", "read"] as const) {
    for (const stage of ["before-backend", "after-backend"]) {
      await t.test(`${authority} revoked ${stage}`, async (t) => {
        const {
          controller,
          namespace,
          agent,
          bot,
          path,
          intent,
          work,
          secretDriver,
          providerCalls,
        } = await slackFirstDeploymentFixture();
        const fixture = controller.fixture;
        const revoke = () =>
          fixture.state.restrictions.push({
            id: `revoke-${authority}-${stage}`,
            namespaceId: namespace.id,
            resourceKind: authority === "deploy" ? "agent" : "configuration",
            resourceId: authority === "deploy" ? agent.id : intent.expectedConfigurationId,
            action: authority,
            effect: "deny",
          });
        if (stage === "before-backend") {
          // The Secret metadata lookup yields to a concurrent policy change. Native IAM
          // still makes every decision; the wrapper only schedules the restriction.
          const read = fixture.platformState.read.bind(fixture.platformState);
          fixture.platformState.read = async (operation) => {
            const result = await read(operation);
            if (
              typeof result === "object" &&
              result !== null &&
              "id" in result &&
              result.id === bot.id
            ) {
              revoke();
            }
            return result;
          };
        } else {
          // Model revocation while the backend was reading, before OCC receives its value.
          const withValue = secretDriver.withValue.bind(secretDriver);
          secretDriver.withValue = (secret, use) =>
            withValue(secret, (value) => {
              revoke();
              return use(value);
            });
        }
        const app = fixture.createApp(undefined, createFastifyApp);
        try {
          const url = await app.listen({ host: "127.0.0.1", port: 0 });
          const result = await request(url, "POST", `${path}/deploy-first`, {
            session: app.defaultSession,
            body: intent,
          });
          const revisions = await fixture.platformState.read((unit) =>
            unit.revisions.listRevisionMetadata(namespace.id, agent.id),
          );
          const reads = secretDriver.calls.filter((call) => call.operation === "withValue").length;
          t.diagnostic(
            JSON.stringify({
              authority,
              stage,
              status: result.status,
              sender: providerCalls(),
              withValue: reads,
              revisions: revisions.length,
              work: work().length,
            }),
          );
          assert.equal(result.status, 403, JSON.stringify(result.body));
          assert.equal(revisions.length, 0);
          assert.equal(work().length, 0);
          assert.equal(
            providerCalls(),
            0,
            "revoked deployment authority must prevent credential dispatch",
          );
          assert.equal(
            reads,
            stage === "after-backend" ? 1 : 0,
            "revocation before backend access must prevent the Secret read",
          );
          assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 0);
        } finally {
          await app.close();
        }
      });
    }
  }
});

test("guarded first deployment refuses deleting Agents before validation", async (t) => {
  for (const stage of ["before-valid-token", "before-wrong-role-token", "after-validation-error"]) {
    await t.test(stage, async (t) => {
      const deployment = await slackFirstDeploymentFixture();
      const { controller, namespace, bot, path, intent, work, secretDriver, providerCalls } =
        deployment;
      const fixture = controller.fixture;
      const app = fixture.createApp(undefined, createFastifyApp);
      try {
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        if (stage !== "before-valid-token") {
          // Store a real wrong-role value through the supported Secret mutation route.
          const changed = await request(
            url,
            "PATCH",
            `/namespaces/${namespace.id}/secrets/${bot.id}`,
            {
              session: app.defaultSession,
              body: { value: "xoxp-synthetic-user" },
            },
          );
          assert.equal(changed.status, 200, JSON.stringify(changed.body));
        }
        secretDriver.calls.length = 0;
        let deletionWork: ReturnType<typeof fixture.platformState.pendingOperations> | undefined;
        const remove = async () => {
          const deleted = await request(url, "DELETE", path, { session: app.defaultSession });
          assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
          const deletedAgent = checkedInjectedBody(deleted, 202, AgentResponse).data;
          assert.equal(deletedAgent.status, "deleting");
          assert.equal(deletedAgent.desiredRuntimeState, "stopped");
          deletionWork = fixture.platformState.pendingOperations();
        };
        if (stage === "after-validation-error") {
          const withValue = secretDriver.withValue.bind(secretDriver);
          secretDriver.withValue = async (secret, use) => {
            // Let the actual Slack validator reject the stored token, then accept deletion
            // before OCC carries the saved validation error into locked admission.
            const outcome = await withValue(secret, use);
            await remove();
            return outcome;
          };
        } else {
          await remove();
        }
        const result = await request(url, "POST", `${path}/deploy-first`, {
          session: app.defaultSession,
          body: intent,
        });
        const revisions = await deployment.listRevisionMetadata();
        const reads = secretDriver.calls.filter((call) => call.operation === "withValue").length;
        t.diagnostic(
          JSON.stringify({
            stage,
            status: result.status,
            code: checkedInjectedBody(result, 409, ErrorResponse).error.code,
            sender: providerCalls(),
            withValue: reads,
            revisions: revisions.length,
            work: work().length,
          }),
        );
        assertApiError(result, 409, "AGENT_DELETING");
        assert.equal(revisions.length, 0);
        assert.equal(work().length, 0);
        assert(deletionWork, "deletion work was captured");
        assert.deepEqual(fixture.platformState.pendingOperations(), deletionWork);
        assert.equal(providerCalls(), 0);
        assert.equal(reads, stage === "after-validation-error" ? 1 : 0);
        assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 0);
      } finally {
        await app.close();
      }
    });
  }
});

test("matching first deployments recover between the initial snapshot and lock despite fresh failures", async () => {
  for (const failure of ["validator", "compute", "deploy", "read", "actor"]) {
    const { controller, namespace, agent, path, intent, work, secretDriver } =
      await firstDeploymentFixture();
    const fixture = controller.fixture;
    const state = fixture.platformState;
    const originalRead = state.read;
    const originalTransact = state.transact;
    const read = originalRead.bind(state);
    const { promise: missed, resolve: sawMiss } = Promise.withResolvers<void>();
    const { promise: resume, resolve: release } = Promise.withResolvers<void>();
    let pause = true;
    let lookups = 0;
    // Count receipt lookups at the storage boundary, including the locked contender.
    const observe = <T extends PlatformReadView>(unit: T): T => ({
      ...unit,
      revisions: {
        ...unit.revisions,
        findFirstDeploymentReceipt: async (
          ...args: Parameters<PlatformReadView["revisions"]["findFirstDeploymentReceipt"]>
        ) => {
          lookups++;
          return unit.revisions.findFirstDeploymentReceipt(...args);
        },
        findRevision: async () => assert.fail("Receipt recovery decoded a full revision"),
      },
    });
    state.read = async (operation) => {
      const result = await read((unit) => operation(observe(unit)));
      if (
        typeof result === "object" &&
        result !== null &&
        "metadata" in result &&
        result.metadata &&
        pause
      ) {
        pause = false;
        sawMiss();
        await resume;
      }
      return result;
    };
    const transact = originalTransact.bind(state);
    state.transact = (operation) => transact((unit) => operation(observe(unit)));
    let session = fixture.session;
    assert(session);
    if (failure === "actor") {
      const other = await fixture.createAuthPrincipal("other-first-deployer");
      fixture.state.identities.push(other.principal);
      const binding = fixture.state.bindings[0];
      assert(binding);
      fixture.state.bindings.push({
        ...binding,
        id: "other-deployer",
        subjectId: other.principal.id,
      });
      assert(other.session);
      session = other.session;
    }
    const late = controller.request("POST", `${path}/deploy-first`, { body: intent, session });
    try {
      await waitForRequestBarrier(missed, late);
      const winner = await controller.request("POST", `${path}/deploy-first`, { body: intent });
      assert.equal(winner.status, 202, JSON.stringify(winner.body));
      assert.equal(lookups, 3); // contender miss; winner miss and locked lookup
      if (failure === "validator") {
        fixture.configurationDriver.validate = async () => {
          throw new Error("synthetic-private-error");
        };
      }
      if (failure === "compute") {
        Object.defineProperty(fixture.computeDriver, "implementation", {
          value: "changed-after-commit",
        });
      }
      if (["validator", "compute"].includes(failure)) {
        const role = fixture.state.roles[0];
        assert(role);
        fixture.state.roles[0] = {
          ...role,
          permissions: [
            { action: "deploy", resourceKind: "agent" },
            { action: "read", resourceKind: "configuration" },
          ],
        };
      }
      if (failure === "deploy" || failure === "read") {
        fixture.state.restrictions.push({
          id: `revoke-${failure}`,
          namespaceId: namespace.id,
          effect: "deny",
          action: failure,
          resourceKind: failure === "deploy" ? "agent" : "configuration",
          resourceId: failure === "deploy" ? agent.id : intent.expectedConfigurationId,
        });
      }
      release();
      const recovered = await late;
      const denied = failure === "deploy" || failure === "read";
      let expectedStatus = 202;
      if (denied) {
        expectedStatus = 403;
      }
      if (failure === "actor") {
        expectedStatus = 409;
      }
      assert.equal(recovered.status, expectedStatus, JSON.stringify(recovered.body));
      if (!denied && failure !== "actor") {
        assert.deepEqual(recovered.data, winner.data);
      }
      assert.equal(lookups, denied ? 3 : 4);
      assert.equal(work().length, 1);
      assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 1);
    } finally {
      release();
      try {
        await settlePendingRequests([late]);
      } finally {
        state.read = originalRead;
        state.transact = originalTransact;
      }
    }
  }
});

test("first deployment recovery generation has an exact decimal wire bound over real HTTP", async () => {
  const { controller, path, intent, secretDriver, work } = await firstDeploymentFixture();
  const app = controller.fixture.createApp(undefined, createFastifyApp);
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const document: unknown = app.swagger();
    assert(isRecord(document) && isRecord(document.paths));
    const swaggerPath =
      document.paths[
        "/namespaces/{namespaceId}/agents/{agentId}/deploy-first/{key}/{expectedConfigurationId}/{expectedGeneration}"
      ];
    assert(isRecord(swaggerPath) && isRecord(swaggerPath.get));
    const operation = swaggerPath.get;
    assert(isRecord(operation.responses));
    const response = operation.responses["200"];
    assert(isRecord(response) && isRecord(response.headers));
    const cacheControl = response.headers["Cache-Control"];
    assert(isRecord(cacheControl));
    assert.deepEqual(cacheControl.schema, { type: "string", const: "no-store" });
    assert(Array.isArray(operation.parameters));
    const parameter: unknown = operation.parameters.find(
      (candidate: unknown) => isRecord(candidate) && candidate.name === "expectedGeneration",
    );
    assert(isRecord(parameter) && isRecord(parameter.schema));
    assert(typeof parameter.schema.pattern === "string");
    const pattern = new RegExp(parameter.schema.pattern);
    for (const generation of ["1", "9007199254740991", "9007199254740992", "0", "01", "1\n"]) {
      const valid = generation === "1" || generation === "9007199254740991";
      assert.equal(pattern.test(generation), valid, generation);
      const result = await request(
        url,
        "GET",
        `${path}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${encodeURIComponent(generation)}`,
        { session: app.defaultSession },
      );
      assert.equal(result.status, valid ? 200 : 400, generation);
      if (valid) {
        assert.equal(result.data, null);
      }
      assert.equal(result.headers.get("cache-control"), "no-store");
    }
    // Independent integer comparison checks every decimal prefix boundary of the maximum.
    const maximum = "9007199254740991";
    for (let index = 0; index < maximum.length; index++) {
      for (let digit = 0; digit <= 9; digit++) {
        const candidate = maximum.slice(0, index) + digit + "9".repeat(maximum.length - index - 1);
        assert.equal(
          pattern.test(candidate),
          candidate[0] !== "0" && BigInt(candidate) <= 9007199254740991n,
          candidate,
        );
      }
    }
    assert.equal(secretDriver.calls.length, 0);
    assert.equal(work().length, 0);
  } finally {
    await app.close();
  }
});

test("guarded deployment rejects dot keys and unrecognized intent fields without writes", async () => {
  const { controller, path, intent, work, secretDriver } = await firstDeploymentFixture();
  for (const body of [
    { ...intent, key: "." },
    { ...intent, key: ".." },
    { ...intent, actorId: "other" },
  ]) {
    const result = await controller.request("POST", `${path}/deploy-first`, { body });
    assertApiError(result, 400, "INVALID_REQUEST");
  }
  assert.equal(work().length, 0);
  assert.equal(secretDriver.calls.length, 0);
});
