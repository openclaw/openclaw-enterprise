import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  CODEX_HARNESS_TEMPLATE_ID,
  type SecretDriver,
} from "../../packages/contracts/src/index.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { installCodexDeviceIssuer } from "../helpers/codex-device-issuer.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createProviderSandboxDriver } from "../helpers/runtime-logs.mjs";
import { assertCodexWorkerRelease } from "../helpers/worker-account-release.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

test(
  "two dedicated Codex Agents independently use one personal model account",
  requiresPostgres,
  async (t) => {
    const clock = createControlledClock();
    const secretDriver = createTestSecretDriver() as SecretDriver;
    const preparedTokens = new TokenService(
      new OAuthConnectionTokens(secretDriver, refreshPinnedOAuthGrant),
    );
    const { inject, controller, principal, computeDriver, state, pool } =
      await createPostgresAgentApp(t, {
        label: "codex-model-account",
        authSecret: "codex-model-account-postgres-session-secret",
        secretDriver,
        sandboxDriver: createProviderSandboxDriver({ id: "openshell-sandbox" }).driver,
        controllerOptions: {
          preparedTokens,
          nativeWorkerSupport: "custom-image",
          now: () => new Date(clock.wallNow()),
        },
      });
    Object.assign(computeDriver, {
      resolveSandboxNamespace: async (namespace: { id: string }) => ({
        ...namespace,
        name: kubernetesNamespaceName(namespace.id),
      }),
    });
    const drivers = selectTemplateDrivers(controller);
    const { providers } = drivers;
    const issuer = installCodexDeviceIssuer(t);
    async function createNamespace() {
      const created = await inject("POST", "/namespaces", {
        name: `Codex model account ${randomUUID()}`,
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = created.json().data.id;
      await controller.handleNamespaceLifecycle(principal.id, id, "ready");
      return id;
    }
    const namespaceId = await createNamespace();
    const retiringId = await createNamespace();
    const ns = `/namespaces/${namespaceId}`;
    const authorize = (id: string) =>
      inject("POST", `/namespaces/${id}/agents/device-authorizations`, { harnessId: "codex" });
    // Keep one provider challenge in flight. Another Namespace can use the shared registration,
    // and deleting the first Namespace takes effect before its challenge can be published.
    const reachedProvider = Promise.withResolvers<void>();
    const finishIssuance = Promise.withResolvers<void>();
    issuer.beforeStart = async () => {
      issuer.beforeStart = undefined;
      reachedProvider.resolve();
      await finishIssuance.promise;
    };
    const slowStart = authorize(retiringId);
    await reachedProvider.promise;
    let start;
    try {
      await pool.query("SELECT id FROM occ.connection_templates WHERE id=$1 FOR UPDATE NOWAIT", [
        CODEX_HARNESS_TEMPLATE_ID,
      ]);
      start = await authorize(namespaceId);
      const removal = await inject("DELETE", `/namespaces/${retiringId}`);
      assert.equal(removal.statusCode, 202, removal.body);
    } finally {
      finishIssuance.resolve();
    }
    const rejected = await slowStart;
    assert.equal(rejected.statusCode, 409, rejected.body);
    const pending = await pool.query(
      "SELECT id FROM occ.credential_sources WHERE namespace_id=$1",
      [retiringId],
    );
    assert.equal(pending.rowCount, 0);
    assert.equal(start.statusCode, 200, start.body);
    await clock.advance(1000);
    const poll = await inject(
      "POST",
      `${ns}/agents/device-authorizations/${start.json().data.sessionId}/poll`,
      {},
    );
    assert.equal(poll.statusCode, 200, poll.body);
    assert.equal(poll.json().data.status, "ready");
    const sourceId = poll.json().data.source.id;
    const replay = await inject(
      "POST",
      `${ns}/agents/device-authorizations/${start.json().data.sessionId}/poll`,
      {},
    );
    assert.deepEqual(replay.json().data.source, poll.json().data.source);
    const receipts = await pool.query(
      "SELECT actor_id FROM occ.audit_events WHERE resource_id=$1 AND details->>'phase'='source_ready'",
      [sourceId],
    );
    assert.deepEqual(receipts.rows, [{ actor_id: principal.id }]);

    const configuration = await inject("POST", `${ns}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-4.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);

    const selected = {
      credentialSources: [{ sourceId }],
      harnessAuth: { method: "credential_source", sourceId },
    };
    const openclaw = await inject("POST", `${ns}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(openclaw.statusCode, 201, openclaw.body);
    const wrongHarness = await inject("POST", `${ns}/agents`, {
      name: "Other Harness",
      executionMode: "dedicated",
      configurationId: openclaw.json().data.id,
      ...selected,
    });
    assert.equal(wrongHarness.statusCode, 409, wrongHarness.body);
    assert.match(wrongHarness.json().error.message, /dedicated Codex Agent/);

    // Each separate Agent selection creates its exact source grant. The deployed sender receives an
    // access token only after release, and both recipients keep independent OpenShell profiles.
    async function deploy(name: string, runWorker = false) {
      const createdAgent = await inject("POST", `${ns}/agents`, {
        name,
        executionMode: "dedicated",
        configurationId: configuration.json().data.id,
        ...(runWorker && selected),
      });
      assert.equal(createdAgent.statusCode, 201, createdAgent.body);
      const agentId = createdAgent.json().data.id;
      if (!runWorker) {
        const update = await inject("PATCH", `${ns}/agents/${agentId}`, {
          ...selected,
          configurationId: configuration.json().data.id,
        });
        assert.equal(update.statusCode, 200, update.body);
      }
      const revision = runWorker
        ? await assertCodexWorkerRelease(t, {
            controller,
            state,
            pool,
            namespaceId,
            agentId,
            sourceId,
            principal,
            ...drivers,
            preparedTokens,
            secretDriver,
            accountId: issuer.accountId,
            accessToken: issuer.accessToken,
          })
        : await controller.deployAgent(
            principal.id,
            { namespaceId, agentId },
            resolveApprovedHarness,
          );
      const account = await controller.prepareRevisionAccount(
        namespaceId,
        agentId,
        revision.id,
        sourceId,
      );
      assert.equal(account?.state, "prepared");
      assert.ok(account);
      const metadata = account.source.config["oce.codex.account"];
      assert.ok(metadata);
      assert.equal(JSON.parse(metadata).accountId, issuer.accountId);
      assert.ok(!JSON.stringify(revision).includes(issuer.accessToken));

      return { agentId, revision, source: account.source };
    }
    const a = await deploy("Research", true);
    const b = await deploy("Coding");
    await controller.releaseRevisionAccount(namespaceId, b.agentId, b.revision.id, b.source);
    const recipients = [...providers.values()];
    assert.equal(recipients.length, 2);
    for (const receiver of recipients) {
      assert.deepEqual(receiver.credentials, { CODEX_ACCESS_TOKEN: issuer.accessToken });
    }
    await controller.detachAgentConnection(principal.id, {
      namespaceId,
      agentId: a.agentId,
      credentialSourceId: sourceId,
    });
    const detached = await controller.getAgent(principal.id, namespaceId, a.agentId);
    assert.equal(detached.harnessAuth, null);
    await assert.rejects(
      controller.releaseRevisionAccount(namespaceId, a.agentId, a.revision.id, a.source),
      /prepared account is no longer authorized/,
    );
    await controller.releaseRevisionAccount(namespaceId, b.agentId, b.revision.id, b.source);
    assert.equal(issuer.exchanges, 1);
  },
);
