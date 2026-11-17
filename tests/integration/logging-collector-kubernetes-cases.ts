import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
import {
  attributeEntries,
  attributes,
  collectorFixture,
  exportedRecords,
  otlpObject,
  selected,
  waitFor,
} from "../helpers/logging-collector-fixture.ts";
import {
  exportedThroughSentinel,
  postLogs,
  sentinelLogs,
  startKubernetesProcessors,
} from "../helpers/logging-collector-pipeline.ts";

type ScalarAttributes = ReturnType<typeof attributes>;

export function registerKubernetesProcessorCases() {
  test(
    "native Collector preserves Kubernetes identity after a dropped record sharing Pod metadata",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Kubernetes processor proof.",
      timeout: 180_000,
    },
    async (t) => {
      const fixture = await collectorFixture(t, "k8s");
      const receiverAddress = await startKubernetesProcessors(fixture);

      // This injects post-parser OTLP records with fixture Pod metadata. Full Helm
      // live proof covers actual CRI parsing and Kubernetes metadata extraction.
      const podUid = `pod-${randomUUID()}`;
      const containerId = `containerd://${randomUUID()}`;
      const imageDigest = `registry.example.test/openclaw-enterprise@sha256:${"a".repeat(64)}`;
      const bodylessInstallationId = `ins_${randomUUID()}`;
      const bodylessJson = JSON.stringify({
        event: "installation.bootstrapped",
        installationId: bodylessInstallationId,
      });
      const installationResource = {
        resource: {
          attributes: [
            { key: "occ.application", value: { stringValue: "openclaw-enterprise" } },
            { key: "occ.component", value: { stringValue: "initialization" } },
            { key: "occ.managed_by", value: { stringValue: "openclaw-enterprise" } },
            {
              key: "k8s.pod.name",
              value: { stringValue: `openclaw-enterprise-initialization-${fixture.suffix}` },
            },
            { key: "k8s.pod.uid", value: { stringValue: podUid } },
            { key: "k8s.namespace.name", value: { stringValue: `system-${fixture.suffix}` } },
            { key: "k8s.node.name", value: { stringValue: "fixture-node" } },
            { key: "container.id", value: { stringValue: containerId } },
            { key: "container.image.name", value: { stringValue: "openclaw-enterprise" } },
            { key: "container.image.tag", value: { stringValue: "fixture-tag" } },
            {
              key: "container.image.repo_digests",
              value: { arrayValue: { values: [{ stringValue: imageDigest }] } },
            },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                body: { stringValue: bodylessJson },
                attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
              },
              {
                timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                body: {
                  stringValue: JSON.stringify({
                    event: "installation.bootstrapped",
                    severity: "INFO",
                  }),
                },
                attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
              },
            ],
          },
        ],
      };
      await postLogs(receiverAddress, [installationResource]);

      const records = async () => {
        return exportedRecords(fixture.out, (resource, record) => ({
          resource: attributes(asRecord(resource.resource)?.attributes),
          attributes: attributes(record.attributes),
          record,
        }));
      };
      await waitFor("the exported record", async () => (await records()).length === 1, fixture);
      const [exported] = await records();
      assert.ok(exported);
      assert.equal(exported.resource["service.name"], "occ-api");
      assert.equal(exported.resource["service.instance.id"], podUid);
      assert.equal(exported.resource["service.version"], imageDigest);
      assert.equal(exported.resource["container.id"], containerId);
      assert.equal(exported.resource["container.image.tag"], "fixture-tag");
      assert.equal(asRecord(exported.record.body)?.stringValue, "installation.bootstrapped");
      assert.equal(exported.record.severityText, "INFO");
      assert.equal(exported.record.severityNumber, 9);
      assert.equal(exported.attributes["event.name"], "installation.bootstrapped");
      const serialized = JSON.stringify(exported);
      for (const internal of [
        "occ.application",
        "occ.component",
        "occ.managed_by",
        bodylessInstallationId,
      ]) {
        assert.equal(serialized.includes(internal), false, `${internal} must not leak downstream`);
      }

      // Stop work includes a per-operation UUID. Credential withdrawal work ends in its operation
      // UUID or `activation`, optionally followed by `:recovery:<n>`. Deletion work has no suffix.
      // Unsupported shapes must lose correlation fields without losing the event.
      const agentId = `agt_${randomUUID()}`;
      const stopWorkId = `agent:${agentId}:reconcile:stopped:${randomUUID()}`;
      const deleteWorkId = `agent:${agentId}:reconcile:deleted`;
      const provisioningWorkId = `agent-provisioning:${randomBytes(16).toString("hex")}`;
      const withdrawalWorkId = `agent_revision:rev_${randomUUID()}:reconcile:credentials_withdrawn`;
      const workCases: {
        operation: string;
        workId: string;
        discardOperation?: boolean;
        discardWorkId?: boolean;
      }[] = [
        { operation: "agent.stop", workId: stopWorkId },
        { operation: "agent.delete", workId: deleteWorkId },
        { operation: "work.reconcile", workId: provisioningWorkId },
        {
          operation: "agent_revision.credential_withdrawal",
          workId: `${withdrawalWorkId}:${randomUUID()}`,
        },
        // The attempt a candidate's activation queues has the fixed operation ID `activation`,
        // and each later attempt series appends `:recovery:<n>` to its request's key.
        {
          operation: "agent_revision.credential_withdrawal",
          workId: `${withdrawalWorkId}:activation`,
        },
        {
          operation: "agent_revision.credential_withdrawal",
          workId: `${withdrawalWorkId}:activation:recovery:1`,
        },
        {
          operation: "agent_revision.credential_withdrawal",
          workId: `${withdrawalWorkId}:${randomUUID()}:recovery:15`,
        },
        ...[
          `${withdrawalWorkId}:CANARY_SESSION`,
          `${withdrawalWorkId}:activation_CANARY`,
          `${withdrawalWorkId}:ACTIVATION`,
          `${withdrawalWorkId}:recovery:1`,
          `${withdrawalWorkId}:activation:recovery`,
          `${withdrawalWorkId}:activation:recovery:0`,
          `${withdrawalWorkId}:activation:recovery:01`,
          `${withdrawalWorkId}:activation:recovery:1:recovery:2`,
          `${withdrawalWorkId}:activation:retry:1`,
          `${withdrawalWorkId}:${randomUUID()}:recovery:CANARY_SESSION`,
        ].map((workId) => ({
          operation: "agent_revision.credential_withdrawal",
          workId,
          discardWorkId: true,
        })),
        {
          operation: "agent_revision.credential_withdrawal",
          workId: withdrawalWorkId,
          discardWorkId: true,
        },
        {
          operation: "agent_revision.credential_withdrawal",
          workId: `agent_revision:CANARY_SESSION:reconcile:credentials_withdrawn:${randomUUID()}`,
          discardWorkId: true,
        },
        {
          operation: "agent_revision.credential_withdrawal",
          workId: `${withdrawalWorkId.replace("credentials_withdrawn", "stopped")}:${randomUUID()}`,
          discardWorkId: true,
        },
        {
          operation: "agent_revision.credentials_withdrawn",
          workId: `${withdrawalWorkId}:${randomUUID()}`,
          discardOperation: true,
        },
        {
          operation: "agent.stop",
          workId: `agent:${agentId}:reconcile:stopped`,
          discardWorkId: true,
        },
        {
          operation: "agent.delete",
          workId: `${deleteWorkId}:${randomUUID()}`,
          discardWorkId: true,
        },
        {
          operation: "agent.stop",
          workId: `agent:${agentId}:reconcile:stopped:CANARY_SESSION`,
          discardWorkId: true,
        },
        {
          operation: "agent.stop",
          workId: `agent:agt_${"a".repeat(36)}:reconcile:stopped:${randomUUID()}`,
          discardWorkId: true,
        },
        { operation: "agent.restart", workId: stopWorkId, discardOperation: true },
      ];
      const cases = workCases.map((entry) => ({ ...entry, requestId: `req_${randomUUID()}` }));
      const workerResource = {
        resource: {
          // A digest-only Pod image: k8sattributes reports the tag as "latest".
          attributes: installationResource.resource.attributes.map((entry) =>
            entry.key === "occ.component"
              ? { ...entry, value: { stringValue: "worker" } }
              : entry.key === "container.image.tag"
                ? { ...entry, value: { stringValue: "latest" } }
                : entry,
          ),
        },
        scopeLogs: [
          {
            logRecords: cases.map(({ operation, workId, requestId }) => ({
              timeUnixNano: String(BigInt(Date.now()) * 1000000n),
              body: {
                stringValue: JSON.stringify({
                  event: "worker.completed",
                  severity: "INFO",
                  operation,
                  workId,
                  requestId,
                  message: "CANARY_RAW_MESSAGE",
                  sessionId: "CANARY_SESSION",
                  "service.name": "CANARY_FORGED_SERVICE",
                }),
              },
              attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
            })),
          },
        ],
      };
      await postLogs(receiverAddress, [workerResource]);
      await waitFor(
        `${1 + cases.length} exported records`,
        async () => (await records()).length === 1 + cases.length,
        fixture,
      );
      const workerRecords = (await records()).filter(
        ({ resource }) => resource["service.name"] === "occ-worker",
      );
      assert.equal(workerRecords.length, cases.length);
      for (const { resource } of workerRecords) {
        assert.equal(resource["container.image.tag"], undefined, "no invented image tag");
        assert.equal(resource["service.version"], imageDigest);
      }
      for (const entry of cases) {
        const actual = workerRecords.find(
          ({ attributes }) => attributes["request.id"] === entry.requestId,
        );
        assert.ok(actual, `expected an exported record for ${entry.requestId}`);
        assert.equal(otlpObject(actual.record.body).stringValue, "worker.completed");
        assert.equal(actual.record.severityNumber, 9);
        assert.deepEqual(actual.attributes, {
          "event.name": "worker.completed",
          "log.iostream": "stdout",
          "request.id": entry.requestId,
          ...(entry.discardOperation ? {} : { "work.operation": entry.operation }),
          ...(entry.discardWorkId ? {} : { "work.id": entry.workId }),
        });
      }
      assert.doesNotMatch(JSON.stringify(workerRecords), /CANARY_/);
    },
  );

  test(
    "native Collector keeps bounded runtime wrapper diagnostics from Gateway and Codex Pods",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector runtime diagnostic proof.",
      timeout: 180_000,
    },
    async (t) => {
      const fixture = await collectorFixture(t, "wrapper");
      const receiverAddress = await startKubernetesProcessors(fixture);
      const namespaceId = `ns_${randomUUID()}`;
      const agentId = `agt_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      const canary = `CANARY_${fixture.suffix}`;
      const resource = (role: string) => ({
        attributes: Object.entries({
          "occ.managed_by": "openclaw-enterprise",
          "occ.role": role,
          "openclaw.namespace.id": namespaceId,
          "openclaw.agent.id": agentId,
          "openclaw.revision.id": revisionId,
          "k8s.pod.uid": `pod-${randomUUID()}`,
          "container.id": `containerd://${randomUUID()}`,
        }).map(([key, value]) => ({ key, value: { stringValue: value } })),
      });
      const line = (record: Record<string, unknown>, stream = "stderr") => ({
        timeUnixNano: String(BigInt(Date.now()) * 1000000n),
        body: { stringValue: JSON.stringify({ ...record, note: canary, message: canary }) },
        attributes: [{ key: "log.iostream", value: { stringValue: stream } }],
      });
      const phase = (container: string, name: string, outcome: string) => ({
        event: "runtime.startup_phase",
        container,
        phase: name,
        outcome,
        ms: 12,
        sinceStartMs: 40,
      });
      const openclawProbe = (code: string) => ({
        event: "openclaw.model_probe",
        elapsedMs: 53049,
        capMs: 65000,
        cpuWaitMs: 7,
        code,
      });
      await postLogs(receiverAddress, [
        {
          resource: resource("gateway"),
          scopeLogs: [
            {
              logRecords: [
                line(phase("gateway", "model-probe", "failed")),
                line(openclawProbe("AUTHENTICATION_FAILED")),
                line(phase("gateway", "runtime-assets", "ok")),
                line(openclawProbe("READY")),
                line({
                  event: "runtime.workspace_node",
                  container: "gateway",
                  outcome: "failed",
                  code: "WORKSPACE_NODE_FAILED",
                }),
                // Setting names stay out of the remote record (D322).
                line({
                  event: "runtime.gateway_settings_overridden",
                  container: "gateway",
                  settings: ["cron.triggers.enabled", `models.providers.${canary}.headers`],
                }),
                // Unbounded values lose the field, never the event.
                line(openclawProbe(`${canary} key`)),
                line(phase("gateway", `${canary}/../path`, "failed")),
                // Only reviewed wrapper events, and only from the wrapper's stderr.
                line(openclawProbe("AUTHENTICATION_FAILED"), "stdout"),
                line({ event: "runtime.environment", code: "READY" }),
              ],
            },
          ],
        },
        {
          resource: resource("agent"),
          scopeLogs: [
            {
              logRecords: [
                line({
                  event: "codex.model_probe",
                  attempt: 1,
                  elapsedMs: 900,
                  exitCode: 1,
                  signal: null,
                  code: "AUTHENTICATION_FAILED",
                }),
                line(phase("agent", "codex-login", "ok")),
                line(phase("agent", "codex-login", "ok"), "stdout"),
                line({ event: "runtime.protected_startup", startupHash: "b".repeat(64) }),
                line({ event: "runtime.protected_startup", startupHash: canary }),
                line({ event: "runtime.protected_startup", startupHash: "b".repeat(64) }, "stdout"),
                // A failed phase keeps a bounded cause code; an unbounded one is dropped.
                line({
                  ...phase("agent", "plugin-install", "failed"),
                  code: "PLUGIN_NOT_IN_CATALOG",
                }),
                line({ ...phase("agent", "plugin-install", "failed"), code: `${canary} key` }),
                line({ ...phase("agent", "native-spawn", "ok"), code: "PLUGIN_NOT_IN_CATALOG" }),
              ],
            },
          ],
        },
        sentinelLogs(resource("gateway")),
      ]);
      const exported = await exportedThroughSentinel(fixture, (resource, record) => ({
        resource: attributes(asRecord(resource.resource)?.attributes),
        attributes: attributes(record.attributes),
        record,
      }));
      for (const { resource } of exported) {
        assert.equal(resource["openclaw.namespace.id"], namespaceId);
        assert.equal(resource["openclaw.agent.id"], agentId);
        assert.equal(resource["openclaw.revision.id"], revisionId);
      }
      const summary = (service: string, severity: string, attributes: ScalarAttributes) =>
        JSON.stringify([
          service,
          severity,
          Object.entries({ "log.iostream": "stderr", ...attributes }).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ]);
      const gateway = (severity: string, attributes: ScalarAttributes) =>
        summary("openclaw-gateway", severity, attributes);
      const codex = (severity: string, attributes: ScalarAttributes) =>
        summary("codex-app-server", severity, attributes);
      const phaseEvent = { "event.name": "runtime.startup_phase" };
      const probeEvent = { "event.name": "openclaw.model_probe" };
      const sort = (entries: string[]) => [...entries].sort();
      assert.deepEqual(
        sort(
          exported.map(({ resource, attributes, record }) => {
            assert.equal(otlpObject(record.body).stringValue, attributes["event.name"]);
            const service = resource["service.name"];
            assert.ok(typeof service === "string" && typeof record.severityText === "string");
            return summary(service, record.severityText, attributes);
          }),
        ),
        sort([
          gateway("WARN", { ...phaseEvent, "occ.startup.phase": "model-probe" }),
          gateway("WARN", { ...probeEvent, "occ.code": "AUTHENTICATION_FAILED" }),
          gateway("INFO", { ...phaseEvent, "occ.startup.phase": "runtime-assets" }),
          gateway("INFO", { ...probeEvent, "occ.code": "READY" }),
          gateway("WARN", {
            "event.name": "runtime.workspace_node",
            "occ.code": "WORKSPACE_NODE_FAILED",
          }),
          gateway("WARN", { "event.name": "runtime.gateway_settings_overridden" }),
          gateway("WARN", probeEvent),
          gateway("WARN", phaseEvent),
          codex("WARN", { "event.name": "codex.model_probe", "occ.code": "AUTHENTICATION_FAILED" }),
          codex("INFO", { ...phaseEvent, "occ.startup.phase": "codex-login" }),
          codex("INFO", {
            "event.name": "runtime.protected_startup",
            "occ.startup.hash": "b".repeat(64),
          }),
          codex("INFO", { "event.name": "runtime.protected_startup" }),
          codex("WARN", {
            ...phaseEvent,
            "occ.startup.phase": "plugin-install",
            "occ.code": "PLUGIN_NOT_IN_CATALOG",
          }),
          codex("WARN", { ...phaseEvent, "occ.startup.phase": "plugin-install" }),
          codex("INFO", { ...phaseEvent, "occ.startup.phase": "native-spawn" }),
        ]),
      );
      assert.doesNotMatch(JSON.stringify(exported), /CANARY_/);
    },
  );

  test(
    "native Collector exports OCC lifecycle, dependency and authentication warnings with bounded fields",
    {
      skip: selected
        ? false
        : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector OCC warning proof.",
      timeout: 180_000,
    },
    async (t) => {
      const fixture = await collectorFixture(t, "occ-warnings");
      const receiverAddress = await startKubernetesProcessors(fixture);
      const canary = `canary${fixture.suffix}`;
      const resource = (component: string) => ({
        attributes: Object.entries({
          "occ.application": "openclaw-enterprise",
          "occ.component": component,
          "k8s.pod.uid": `pod-${randomUUID()}`,
          "container.id": `containerd://${randomUUID()}`,
        }).map(([key, value]) => ({ key, value: { stringValue: value } })),
      });
      // Records as the API and worker print them: Pino JSON on stdout (with the `service`
      // base field and an ISO time), and the PostgreSQL pool's idle-connection warning written
      // directly to stderr. `note` is a hostile extra field that must never be exported.
      const line = (record: Record<string, unknown>, stream = "stdout") => ({
        timeUnixNano: String(BigInt(Date.now()) * 1000000n),
        body: {
          stringValue: JSON.stringify({
            time: new Date().toISOString(),
            service: "api",
            note: canary,
            ...record,
          }),
        },
        attributes: [{ key: "log.iostream", value: { stringValue: stream } }],
      });
      const requestId = `req_${randomUUID()}`;
      const namespaceId = `ns_${randomUUID()}`;
      const agentId = `agt_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      await postLogs(receiverAddress, [
        {
          resource: resource("api"),
          scopeLogs: [
            {
              logRecords: [
                line({ severity: "INFO", event: "shutdown.started", signal: "SIGTERM" }),
                line({ severity: "INFO", event: "shutdown.completed", durationMs: 1250.375 }),
                line({
                  severity: "ERROR",
                  event: "shutdown.failed",
                  code: "SHUTDOWN_FAILED",
                  durationMs: 30000.5,
                }),
                line(
                  { level: "warn", event: "database.idle-client-error", code: "57P01" },
                  "stderr",
                ),
                // The pool logs a Node transport code when the socket fails first.
                line(
                  { level: "warn", event: "database.idle-client-error", code: "ECONNRESET" },
                  "stderr",
                ),
                // An unbounded code loses the field, never the event.
                line(
                  { level: "warn", event: "database.idle-client-error", code: canary },
                  "stderr",
                ),
                line({
                  severity: "WARN",
                  event: "device_authorization.start_failed",
                  requestId,
                  route: `/api/${canary}`,
                  host: "auth.openai.com",
                  reason: "unreachable",
                  failure: "TimeoutError",
                }),
                // A token-shaped failure class is dropped, as the sanitizer drops it elsewhere.
                line({
                  severity: "WARN",
                  event: "device_authorization.start_failed",
                  requestId,
                  reason: "unavailable",
                  failure: `ghp_${canary}`,
                }),
                // The denied call and Kubernetes namespace stay in local logs.
                line({
                  severity: "WARN",
                  event: "agent_runtime_credentials.cluster_denied",
                  requestId,
                  route: `/api/${canary}`,
                  verb: "get",
                  resource: "secrets",
                  kubernetesNamespace: `tenant-${canary}`,
                  plane: "execution",
                  kubernetesStatus: 403,
                }),
                // A dependency 503's class, message and causes stay in local logs.
                line({
                  severity: "WARN",
                  event: "http.dependency_unavailable",
                  requestId,
                  method: "POST",
                  route: `/api/${canary}`,
                  errorClass: "DependencyUnavailableError",
                  message: `The Kubernetes Secret create failed ${canary}.`,
                  causes: [{ errorClass: "ApiException", code: 500 }],
                }),
                // A failed audit write keeps the Agent's IDs; the error stays local.
                line({
                  severity: "WARN",
                  event: "native_admin.websocket_audit_failed",
                  error: { type: "Error", message: canary, stack: `Error: ${canary}` },
                  namespaceId,
                  agentId,
                  revisionId,
                }),
                // Both denial paths export the fixed event, never supplied caller or error fields.
                ...[
                  "native_admin.http_denial_audit_failed",
                  "native_admin.websocket_denial_audit_failed",
                ].map((event) =>
                  line({
                    severity: "WARN",
                    event,
                    requestId,
                    namespaceId,
                    agentId,
                    revisionId,
                    code: "UNREVIEWED_EXTRA",
                    pending: 7,
                    userId: canary,
                    headers: { authorization: canary },
                    error: { message: canary, stack: canary },
                    payload: { private: canary },
                  }),
                ),
                line({ severity: "WARN", event: "native_admin.http_denial_audit_failed.detail" }),
                line({
                  severity: "WARN",
                  event: "native_admin.websocket_denial_audit_failed-unreviewed",
                }),
                // Shutdown exports only its bounded pending count; payloads and identities stay local.
                ...[
                  0,
                  7,
                  9007199254740991,
                  -1,
                  1.5,
                  "7",
                  9007199254740992,
                  true,
                  null,
                  { private: canary },
                ].map((pending) =>
                  line({
                    severity: "WARN",
                    event: "native_admin.pending_work_unresolved",
                    pending,
                    message: canary,
                    userId: canary,
                    requestId,
                    namespaceId,
                    agentId,
                    revisionId,
                    code: "UNREVIEWED_EXTRA",
                    payload: { private: canary },
                  }),
                ),
                line({ severity: "WARN", event: "native_admin.pending_work_unresolved.detail" }),
                // A Compute-owner mismatch keeps the Agent's IDs; the Driver names stay local.
                line({
                  severity: "WARN",
                  event: "native_admin.compute_owner_mismatch",
                  namespaceId,
                  agentId,
                  revisionId,
                  revisionCompute: { id: `compute-${canary}`, implementation: canary },
                  selectedCompute: { id: `selected-${canary}`, implementation: canary },
                  message: `Native admin UI is refused ${canary}`,
                }),
                // Account IDs and messages that name them stay in local logs.
                line({
                  severity: "WARN",
                  event: "authentication.activation-warning",
                  reason: "Accounts without a Principal or exactly one password were not enrolled.",
                  skippedUserIds: [`user_${canary}`],
                  skippedUserCount: 1,
                  skippedUserIdsTruncated: false,
                }),
                line({
                  severity: "WARN",
                  event: "authentication.password-sign-in-warning",
                  code: "EXTERNAL_IDENTITY_MISSING",
                  skippedUserIds: [`user_${canary}`],
                  skippedUserCount: 1,
                  skippedUserIdsTruncated: false,
                }),
                line({
                  severity: "WARN",
                  event: "authentication.forwarded-refused-warning",
                  code: "TRUSTED_PROXY_NOT_CONFIGURED",
                }),
                line({
                  severity: "WARN",
                  event: "authentication.recovery-seed-warning",
                  message: `OCC_AUTH_RECOVERY_USER_ID differs ${canary}`,
                }),
                // A near-match of a reviewed name is still dropped.
                line({ severity: "WARN", event: "shutdown.failed-unreviewed" }),
              ],
            },
          ],
        },
        {
          resource: resource("worker"),
          scopeLogs: [
            {
              logRecords: [
                line(
                  { level: "warn", event: "database.idle-client-error", code: "57P01" },
                  "stderr",
                ),
              ],
            },
          ],
        },
        // The sentinel is a runtime wrapper record, which the Collector exports only from
        // a managed Gateway Pod.
        sentinelLogs({
          attributes: Object.entries({
            "occ.managed_by": "openclaw-enterprise",
            "occ.role": "gateway",
            "k8s.pod.uid": `pod-${randomUUID()}`,
            "container.id": `containerd://${randomUUID()}`,
          }).map(([key, value]) => ({ key, value: { stringValue: value } })),
        }),
      ]);
      const exported = await exportedThroughSentinel(fixture, (resource, record) => ({
        resource: attributes(asRecord(resource.resource)?.attributes),
        record,
      }));
      const summary = (
        service: string,
        severity: string,
        stream: string,
        fields: Record<string, string>,
      ) =>
        JSON.stringify([
          service,
          severity,
          Object.entries({ "log.iostream": stream, ...fields }).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ]);
      const api = (severity: string, fields: Record<string, string>, stream = "stdout") =>
        summary("occ-api", severity, stream, fields);
      const sort = (entries: string[]) => [...entries].sort();
      assert.deepEqual(
        sort(
          exported.map(({ resource, record }) => {
            const fields = Object.fromEntries(
              attributeEntries(record.attributes).map(([key, value]) => {
                // OTLP JSON carries an int64 as a string; a JSON number may arrive as either.
                const scalar = value.stringValue ?? String(value.intValue ?? value.doubleValue);
                assert.ok(typeof scalar === "string");
                return [key, scalar] as const;
              }),
            );
            assert.equal(otlpObject(record.body).stringValue, fields["event.name"]);
            const service = resource["service.name"];
            const stream = fields["log.iostream"];
            assert.ok(typeof service === "string" && typeof record.severityText === "string");
            assert.ok(typeof stream === "string");
            return summary(service, record.severityText, stream, fields);
          }),
        ),
        sort([
          api("INFO", { "event.name": "shutdown.started" }),
          api("INFO", { "event.name": "shutdown.completed", duration_ms: "1250.375" }),
          api("ERROR", {
            "event.name": "shutdown.failed",
            "occ.code": "SHUTDOWN_FAILED",
            duration_ms: "30000.5",
          }),
          api(
            "WARN",
            { "event.name": "database.idle-client-error", "occ.code": "57P01" },
            "stderr",
          ),
          api(
            "WARN",
            { "event.name": "database.idle-client-error", "occ.code": "ECONNRESET" },
            "stderr",
          ),
          api("WARN", { "event.name": "database.idle-client-error" }, "stderr"),
          api("WARN", {
            "event.name": "device_authorization.start_failed",
            "request.id": requestId,
            "occ.device_authorization.reason": "unreachable",
            "occ.device_authorization.failure": "TimeoutError",
          }),
          api("WARN", {
            "event.name": "device_authorization.start_failed",
            "request.id": requestId,
            "occ.device_authorization.reason": "unavailable",
          }),
          api("WARN", {
            "event.name": "agent_runtime_credentials.cluster_denied",
            "request.id": requestId,
          }),
          api("WARN", { "event.name": "http.dependency_unavailable", "request.id": requestId }),
          api("WARN", {
            "event.name": "native_admin.websocket_audit_failed",
            "occ.namespace.id": namespaceId,
            "occ.agent.id": agentId,
            "occ.revision.id": revisionId,
          }),
          api("WARN", { "event.name": "native_admin.http_denial_audit_failed" }),
          api("WARN", { "event.name": "native_admin.websocket_denial_audit_failed" }),
          ...["0", "7", "9007199254740991"].map((pending) =>
            api("WARN", {
              "event.name": "native_admin.pending_work_unresolved",
              "occ.native_admin.pending": pending,
            }),
          ),
          ...Array.from({ length: 7 }, () =>
            api("WARN", { "event.name": "native_admin.pending_work_unresolved" }),
          ),
          api("WARN", {
            "event.name": "native_admin.compute_owner_mismatch",
            "occ.namespace.id": namespaceId,
            "occ.agent.id": agentId,
            "occ.revision.id": revisionId,
          }),
          api("WARN", { "event.name": "authentication.activation-warning" }),
          api("WARN", {
            "event.name": "authentication.password-sign-in-warning",
            "occ.code": "EXTERNAL_IDENTITY_MISSING",
          }),
          api("WARN", {
            "event.name": "authentication.forwarded-refused-warning",
            "occ.code": "TRUSTED_PROXY_NOT_CONFIGURED",
          }),
          api("WARN", { "event.name": "authentication.recovery-seed-warning" }),
          summary("occ-worker", "WARN", "stderr", {
            "event.name": "database.idle-client-error",
            "occ.code": "57P01",
          }),
        ]),
      );
      assert.doesNotMatch(JSON.stringify(exported), new RegExp(canary));
    },
  );
}
