import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  ConfigurationResponse,
  InstallationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { handedOff, required } from "./postgres-agent-provisioning-setup.ts";

import {
  deriveNativeAdminHost,
  nativeAdminConfigurationSupported,
} from "../../apps/controller/src/gateway/native-admin.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

import {
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  identifier,
  provisioningBody,
  provisioningError,
  provisioningRow,
  storedProvisioningCounts,
} from "./postgres-agent-provisioning-setup.ts";

export function registerHarnessRefusalCase() {
  test(
    "a Harness authentication refusal of the caller's Configuration is named on create, replay, handoff, in the failed work and on retry",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const computeDriver = createRuntimeComputeDriver();
      // Kubernetes Compute raises this for a Codex Gateway setting it cannot rewrite; the
      // setting path can carry a submitted provider key, here with a control character.
      const settingRefusal = (key: string) =>
        `Configuration setting models.providers.${key}.models must be a list of objects: a dedicated Codex Gateway cannot apply it otherwise.`;
      // Exactly the 256-character status cap, counting the astral character once, so the
      // status keeps it whole.
      const fill = 256 - Array.from(settingRefusal("op\u0007enai\u{1F600}")).length;
      const refusal = settingRefusal(`op\u0007enai${"x".repeat(fill)}\u{1F600}`);
      assert.equal(Array.from(refusal).length, 256);
      const named = refusal.replace("\u0007", "?");
      let refusing = true;
      let harnessChecks = 0;
      computeDriver.validateHarnessAuth = () => {
        harnessChecks += 1;
        if (refusing) {
          throw new ConfigurationHarnessError(refusal);
        }
      };
      const fixture = await createFixture(context, {
        computeDriver,
        configurationDriver: createProvisioningConfigurationDriver({
          id: "configuration-provisioning-harness-refusal",
        }),
        secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);

      // A fresh request is refused as deployment refuses it: a 400 naming the setting.
      const refused = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: provisioningBody(namespace.id, secrets),
        },
      );
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.deepEqual(
        { code: provisioningError(refused).code, message: provisioningError(refused).message },
        { code: "INVALID_REQUEST", message: named },
      );

      // The Driver refuses the stored plan only after admission: the worker fails the work on
      // its first attempt, and the failed work's message names the setting.
      refusing = false;
      const body = provisioningBody(namespace.id, secrets);
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      refusing = true;
      await fixture.startWorker();
      const failed = await waitFor("the worker to refuse the provisioning work", async () => {
        const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
        return row.progress.error === undefined ? undefined : row;
      });
      await fixture.stopWorker();
      assert.equal(failed.status, "failed");
      assert.deepEqual(failed.progress.error, { code: "PROVISIONING_REJECTED", message: named });
      const work = await fixture.pool.query<{
        state: ControllerWorkState;
        reason_code: string | null;
        attempt_count: number;
      }>(
        "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [admitted.data.provisioning.workId],
      );
      assert.deepEqual(work.rows, [
        { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
      ]);

      // Status reports the stored failure without rechecking Harness authentication.
      const checksBeforeStatus = harnessChecks;
      const status = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        admitted.data.provisioning.url,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.data.status, "failed");
      assert.deepEqual(status.data.error, failed.progress.error);
      assert.equal(harnessChecks, checksBeforeStatus, "a status read runs no Harness check");
      // A replay of the admitted request checks the stored plan again and names the setting too.
      const provisionPath = `/namespaces/${namespace.id}/agents/provision`;
      const replayed = await fixture.request("POST", provisionPath, { body });
      assert.equal(replayed.status, 400, JSON.stringify(replayed.body));
      assert.deepEqual(
        { code: provisioningError(replayed).code, message: provisioningError(replayed).message },
        { code: "INVALID_REQUEST", message: named },
      );
      // Retry runs the plan again and names the setting too.
      const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
      assert.equal(retried.status, 400, JSON.stringify(retried.body));
      assert.deepEqual(
        { code: provisioningError(retried).code, message: provisioningError(retried).message },
        { code: "INVALID_REQUEST", message: named },
      );
      // Any other Harness authentication refusal keeps the fixed 409.
      computeDriver.validateHarnessAuth = () => {
        throw new Error("Harness authentication is incompatible with the selected topology.");
      };
      const conflicted = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
      assert.equal(conflicted.status, 409, JSON.stringify(conflicted.body));
      assert.deepEqual(
        {
          code: provisioningError(conflicted).code,
          message: provisioningError(conflicted).message,
        },
        {
          code: "RESOURCE_CONFLICT",
          message:
            "The configured model, authentication, or channel bindings cannot be provisioned.",
        },
      );

      // Admission and the worker fences check the placeholder "provisioning" Harness version;
      // deployment checks the approved runtime version. A Driver that refuses only the latter
      // fails the work at the deployment handoff, and its message is named as well. Over the
      // cap, format characters and lone surrogates become "?" and the cut keeps whole
      // characters.
      const emoji = "\u{1F600}".repeat(220);
      computeDriver.validateHarnessAuth = (harness) => {
        if (harness.version !== "provisioning") {
          throw new ConfigurationHarnessError(settingRefusal(`op\u200Benai\uD800${emoji}`));
        }
      };
      const handoffBody = provisioningBody(namespace.id, secrets);
      const handedOff = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        provisionPath,
        { body: handoffBody },
      );
      assert.equal(handedOff.status, 202, JSON.stringify(handedOff.body));
      await fixture.startWorker();
      const handoffFailed = await waitFor(
        "the handoff to refuse the provisioning work",
        async () => {
          const row = await provisioningRow(fixture.pool, namespace.id, handoffBody.requestId);
          return row.progress.error === undefined ? undefined : row;
        },
      );
      await fixture.stopWorker();
      assert.equal(handoffFailed.status, "failed");
      assert.notEqual(handoffFailed.agent_id, null, "the handoff runs after the Agent exists");
      const shown = Array.from(settingRefusal(`op?enai?${emoji}`))
        .slice(0, 255)
        .join("");
      assert.deepEqual(handoffFailed.progress.error, {
        code: "PROVISIONING_REJECTED",
        message: `${shown}…`,
      });

      // Authorization comes first: a caller who lost its grants gets 403, not the setting.
      computeDriver.validateHarnessAuth = () => {
        throw new ConfigurationHarnessError(refusal);
      };
      await fixture.revokeCurrentPrincipal();
      const denied = await fixture.request("POST", provisionPath, { body });
      assertApiError(denied, 403, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(denied.body), /models\.providers/);
    },
  );
}

export function registerNativeAdminCases() {
  test(
    "overlong retained native domain refuses opt-in before durable provisioning",
    requiresPostgres,
    async (context) => {
      const domain = `${"a.".repeat(100)}a.oce.localhost`;
      assert.equal(domain.length, 215);
      const fixture = await createFixture(context, {
        nativeAdmin: true,
        nativeAdminDomain: domain,
      });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const configs = await fixture.pool.query<Record<string, unknown>>(
        "SELECT * FROM occ.configurations WHERE namespace_id = $1 ORDER BY id",
        [namespace.id],
      );
      const response = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: { ...provisioningBody(namespace.id, secrets), nativeAdmin: true },
        },
      );
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.match(provisioningError(response).message, /214 characters/);
      assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
        jobs: 0,
        agents: 0,
      });
      const after = await fixture.pool.query<Record<string, unknown>>(
        "SELECT * FROM occ.configurations WHERE namespace_id = $1 ORDER BY id",
        [namespace.id],
      );
      assert.deepEqual(after.rows, configs.rows);
    },
  );

  test(
    "native admin opt-in provisions the exact origin in the first version and preserves retry identity",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      // Canonical DNS length, not presentation whitespace or a root dot, controls admission.
      const domain = `${"a.".repeat(99)}a.oce.localhost`;
      assert.equal(domain.length, 213);
      const canonicalDomain = `a${domain}`;
      assert.equal(canonicalDomain.length, 214);
      const fixture = await createFixture(context, {
        nativeAdmin: true,
        nativeAdminDomain: `  ${canonicalDomain.toUpperCase()}.  `,
        stopAfterProvisioning: true,
      });
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const path = `/namespaces/${namespace.id}/agents/provision`;
      const base = { ...provisioningBody(namespace.id, secrets), nativeAdmin: true };
      const existingOrigin = "http://localhost:18789";
      const gateway = {
        controlUi: { enabled: false, allowedOrigins: [existingOrigin] },
        auth: { password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" } },
      };
      assert.equal(
        (await fixture.requestChecked(InstallationResponse, "GET", "/installation")).data
          .capabilities?.nativeAdmin,
        true,
      );
      // An incompatible policy must fail before a durable job or Configuration is created.
      const body = {
        ...base,
        configuration: {
          ...base.configuration,
          values: { ...base.configuration.values, gateway },
          secretBindings: {
            ...base.configuration.secretBindings,
            EXTERNAL_SERVICE_TOKEN: {
              ...base.configuration.secretBindings.EXTERNAL_SERVICE_TOKEN,
              delivery: { type: "env" as const },
            },
          },
        },
      };
      const conflict = {
        ...body,
        configuration: {
          ...body.configuration,
          values: {
            ...body.configuration.values,
            gateway: { ...gateway, auth: { ...gateway.auth, mode: "token" } },
          },
        },
      };
      const refused = await fixture.request("POST", path, { body: conflict });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
        jobs: 0,
        agents: 0,
      });
      const admitted = await fixture.requestChecked(AgentProvisioningResponse, "POST", path, {
        body,
      });
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      assert.equal(
        admitted.data.provisioning.agentId,
        undefined,
        "reserved identity is not a created Agent",
      );
      const queued = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      const reservedAgentId = queued.plan.reservedAgentId;
      assert.ok(typeof reservedAgentId === "string");
      assert.match(reservedAgentId, identifier("agt"));
      // The reserved identity and prepared policy must survive API restart before
      // the first worker claim; replay must not reserve another Agent or origin.
      await fixture.restartApi();
      const replay = await fixture.requestChecked(AgentProvisioningResponse, "POST", path, {
        body,
      });
      assert.equal(replay.status, 202, JSON.stringify(replay.body));
      assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);
      assert.deepEqual(
        (await provisioningRow(fixture.pool, namespace.id, body.requestId)).plan,
        queued.plan,
      );
      const changed = await fixture.request("POST", path, {
        body: { ...body, nativeAdmin: false },
      });
      assert.equal(
        changed.status,
        409,
        "opting out cannot replay a different plan under the same request ID",
      );
      await fixture.startWorker();
      const status = await waitFor("native admin first revision handoff", async () => {
        const result = await fixture.requestChecked(
          AgentProvisioningStatusResponse,
          "GET",
          admitted.data.provisioning.url,
        );
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.notEqual(result.data.status, "failed", JSON.stringify(result.body));
        return result.data.revisionId ? handedOff(result.data) : undefined;
      });
      await fixture.stopWorker();
      assert.equal(status.agentId, queued.plan.reservedAgentId);
      const installation = required(await fixture.state.loadInstallation());
      const origin = `https://${deriveNativeAdminHost(installation.id, { id: status.agentId, namespaceId: namespace.id }, canonicalDomain)}:9443`;
      assert.equal(new URL(origin).hostname.length, 253);
      const configuration = await fixture.requestChecked(
        ConfigurationResponse,
        "GET",
        `/namespaces/${namespace.id}/configurations/${status.configurationId}`,
      );
      const savedGateway = required(
        asRecord(required(asRecord(configuration.data.values)).gateway),
      );
      assert.equal(configuration.data.generation, 1);
      assert.deepEqual(required(asRecord(savedGateway.controlUi)).allowedOrigins, [
        existingOrigin,
        origin,
      ]);
      assert.equal(savedGateway.publicOrigin, origin);
      assert.deepEqual(
        required(asRecord(savedGateway.auth)).password,
        body.configuration.values.gateway.auth.password,
      );
      assert.deepEqual(configuration.data.secretBindings, body.configuration.secretBindings);
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, status.agentId),
      );
      assert.equal(revisions.length, 1);
      assert.equal(nativeAdminConfigurationSupported(required(revisions[0]), origin), true);
      // Replay after the worker handoff must still refer to the same Agent and first revision.
      await fixture.restartApi();
      const completedReplay = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        path,
        { body },
      );
      assert.equal(completedReplay.status, 202, JSON.stringify(completedReplay.body));
      assert.equal(completedReplay.data.provisioning.agentId, status.agentId);
      assert.equal(completedReplay.data.provisioning.revisionId, status.revisionId);
    },
  );
}
