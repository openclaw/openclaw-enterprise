import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { createServer, ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { asRecord } from "../../packages/utils/src/index.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import {
  attributeEntries,
  attributes,
  collectorFixture,
  docker,
  exportedRecords,
  nodeImage,
  otlpObject,
  root,
  selected,
  waitFor,
} from "../helpers/logging-collector-fixture.ts";
import {
  exportedThroughSentinel,
  postLogs,
  readCollectorYaml,
  sentinelLogs,
  startKubernetesProcessors,
} from "../helpers/logging-collector-pipeline.ts";
import { registerKubernetesProcessorCases } from "./logging-collector-kubernetes-cases.ts";

// The OCC API and worker event names the Collector exports; every other OCC event is dropped.
async function exportedOccEventPattern() {
  const collector = await readCollectorYaml("collector.yaml");
  const processors = asRecord(collector.processors);
  const transform = asRecord(processors?.["transform/operational"]);
  assert.ok(Array.isArray(transform?.log_statements), "expected operational log statement groups");
  const groups: unknown[] = transform.log_statements;
  const statements = groups.flatMap((group) => {
    const entries = asRecord(group)?.statements;
    assert.ok(Array.isArray(entries), "expected a list of operational log statements");
    const statements: unknown[] = entries;
    assert.ok(statements.every((entry) => typeof entry === "string"));
    return statements;
  });
  const statement = statements.find(
    (entry) =>
      entry.startsWith('set(attributes["event.name"], cache["record"]["event"])') &&
      entry.includes('"occ-api"'),
  );
  const pattern = statement?.match(/IsMatch\(cache\["record"\]\["event"\], "([^"]+)"\)/)?.[1];
  assert.ok(pattern, "expected an OCC event pattern in the operational log transform");
  // The Collector escapes `$` as `$$` in its configuration.
  return new RegExp(pattern.replaceAll("$$", "$"));
}

test("the Collector exports bounded native-admin audit diagnostics", async () => {
  const event = "native_admin.pending_work_unresolved";
  const pattern = await exportedOccEventPattern();
  // A computed event field hid both denial names from the documented-event inventory.
  const source = await readFile(join(root, "apps/controller/src/http/native-admin.ts"), "utf8");
  const emitted = new Set(
    [...source.matchAll(/\bevent: "([a-z_]+[.][a-z_.-]+)"/g)].map(([, name]) => name),
  );
  const flow = await readFile(join(root, "docs/flows/common-logging.md"), "utf8");
  for (const denial of [
    "native_admin.http_denial_audit_failed",
    "native_admin.websocket_denial_audit_failed",
  ]) {
    assert.ok(emitted.has(denial), `${denial} is visible to the event inventory`);
    assert.ok(flow.includes(`\`${denial}\``), `${denial} is documented`);
    assert.ok(pattern.test(denial), `${denial} reaches the backend`);
    for (const name of [`${denial}.detail`, `${denial}-unreviewed`]) {
      assert.equal(pattern.test(name), false, "nearby unreviewed diagnostics stay local");
    }
  }
  assert.ok(pattern.test(event), "the documented shutdown diagnostic reaches the backend");
  for (const name of [`${event}.detail`, `${event}-unreviewed`, "native_admin.other_event"]) {
    assert.equal(pattern.test(name), false, "nearby unreviewed diagnostics stay local");
  }
});

async function sourceFiles(directory: string, extensions: string[]) {
  return (await readdir(join(root, directory), { recursive: true }))
    .filter((path) => extensions.some((extension) => path.endsWith(extension)))
    .map((path) => join(directory, path));
}

// Guides, references and flows tell operators to look for OCC events by name. A named
// event the Collector drops never reaches the log backend those operators search, as
// happened to `shutdown.failed` and `device_authorization.start_failed` (finding 600).
// The scan covers dotted names emitted as `event: "<name>"` literals; undotted names such
// as `listening` and names built at runtime need their own Collector case.
test("the Collector exports every OCC API and worker event the docs name", async () => {
  const pattern = await exportedOccEventPattern();
  const emitted = new Set<string>();
  for (const path of [
    ...(await sourceFiles("apps/controller/src", [".ts", ".mjs"])),
    ...(await sourceFiles("packages/occ/src", [".ts"])),
  ]) {
    // The Kubernetes Compute Driver renders this file's events into Gateway and Codex
    // Pods; the Collector classifies those runtime wrapper diagnostics separately.
    if (
      path.endsWith("drivers/compute/kubernetes/runtime-entrypoints.ts") ||
      path.endsWith("drivers/compute/harness-egress-enrollment.ts")
    ) {
      continue;
    }
    const text = await readFile(join(root, path), "utf8");
    for (const [, event] of text.matchAll(/\bevent: "([a-z_]+[.][a-z_.-]+)"/g)) {
      assert.ok(event);
      emitted.add(event);
    }
  }
  const named = new Map<string, string>();
  for (const path of await sourceFiles("docs", [".md"])) {
    const text = await readFile(join(root, path), "utf8");
    for (const [, event] of text.matchAll(/`([a-z_]+[.][a-z_.-]+)`/g)) {
      assert.ok(event);
      if (emitted.has(event) && !named.has(event)) {
        named.set(event, path);
      }
    }
  }
  // Guard the scan itself: these documented events must be found, or the check is vacuous.
  for (const event of ["http.completed", "worker.compute-prepare-failed", "shutdown.failed"]) {
    assert.ok(named.has(event), `${event} is emitted and documented`);
  }
  const dropped = [...named]
    .filter(([event]) => !pattern.test(event))
    .map(([event, path]) => `${event} (${path})`);
  assert.deepEqual(dropped, [], "documented OCC events the Collector drops");
});

registerKubernetesProcessorCases();

// The fields the OCC log sanitizer keeps as fixed codes or a route fence
// (apps/controller/src/logging.ts), and the attribute the Collector exports each as.
const codeAttributes = {
  check: "occ.check",
  failure: "occ.failure",
  harnessState: "occ.harness_state",
  hintCode: "occ.hint_code",
  reasonCode: "occ.reason_code",
  fence: "occ.fence",
};

// Worker records with code fields, each with the attributes the Collector must export besides
// its event name, stream and request ID. The sanitizer must keep the same code fields.
type CodeFieldCase = {
  record: { event: string } & Record<string, unknown>;
  exported: Record<string, string | boolean>;
};

function codeFieldCases({
  canary,
  identity,
  exportedIdentity,
}: {
  canary: string;
  identity: Record<string, string>;
  exportedIdentity: Record<string, string>;
}): CodeFieldCase[] {
  const longest = `a${"b".repeat(63)}`;
  // `sandboxDriverId`, `status` and `reason` stay in local logs.
  const kept: CodeFieldCase[] = [
    {
      record: {
        event: "worker.openshell-git-continuity-refused",
        check: "held-startup-recorded",
        keyHash: "a".repeat(64),
      },
      exported: { "occ.check": "held-startup-recorded", "occ.continuity.key_hash": "a".repeat(64) },
    },
    {
      record: {
        event: "worker.openshell-git-continuity-refused",
        check: "sandbox-restart-count",
        result: 7,
      },
      exported: { "occ.check": "sandbox-restart-count", "occ.continuity.result": "7" },
    },
    {
      record: { event: "worker.openshell-git-continuity-refused", result: false, keyHash: canary },
      exported: { "occ.continuity.result": false },
    },
    {
      record: {
        event: "worker.openshell-git-continuity-refused",
        result: canary,
        keyHash: "A".repeat(64),
      },
      exported: {},
    },
    { record: { event: "worker.openshell-git-continuity-refused", result: 7.5 }, exported: {} },
    {
      record: { event: "worker.openshell-git-continuity-refused", result: 2147483648 },
      exported: {},
    },
    {
      record: {
        event: "worker.openshell-git-expiry",
        ...identity,
        outcome: "pending",
        check: "original-launch-and-pods",
        failure: "gateway_unavailable",
      },
      exported: {
        ...exportedIdentity,
        "work.outcome": "pending",
        "occ.check": "original-launch-and-pods",
        "occ.failure": "gateway_unavailable",
      },
    },
    {
      record: {
        event: "worker.openshell-git-expiry",
        ...identity,
        outcome: "withdrawn",
        check: "record-reduced-generation",
      },
      exported: {
        ...exportedIdentity,
        "work.outcome": "withdrawn",
        "occ.check": "record-reduced-generation",
      },
    },
    {
      record: { event: "worker.openshell-git-expiry", outcome: "retire-runtime", check: longest },
      exported: { "work.outcome": "retire-runtime", "occ.check": longest },
    },
    {
      record: { event: "worker.repository-delivery-pending", sandboxDriverId: canary },
      exported: {},
    },
    {
      record: {
        event: "worker.openshell-git-route-warning",
        ...identity,
        status: "refused",
        reason: `route ${canary}`,
        reasonCode: "repository_expired",
      },
      exported: { ...exportedIdentity, "occ.reason_code": "repository_expired" },
    },
    {
      record: { event: "worker.openshell-git-route", ...identity, status: "installed", fence: 7 },
      exported: { ...exportedIdentity, "occ.fence": "7" },
    },
    { record: { event: "worker.openshell-git-route", fence: 0 }, exported: { "occ.fence": "0" } },
    {
      record: { event: "worker.openshell-git-route", fence: Number.MAX_SAFE_INTEGER },
      exported: { "occ.fence": String(Number.MAX_SAFE_INTEGER) },
    },
    {
      record: {
        event: "worker.completed",
        outcome: "permanent",
        code: "SANDBOX_GATEWAY_UNAUTHORIZED",
        hintCode: "sandbox-gateway-identity",
        harnessState: "starting",
      },
      exported: {
        "work.outcome": "permanent",
        "occ.code": "SANDBOX_GATEWAY_UNAUTHORIZED",
        "occ.hint_code": "sandbox-gateway-identity",
        "occ.harness_state": "starting",
      },
    },
    // Short or unanchored near-matches of a token shape are codes, as in the sanitizer.
    {
      record: { event: "worker.openshell-git-denied", reasonCode: "ghp_short", check: "task_sk-a" },
      exported: { "occ.reason_code": "ghp_short", "occ.check": "task_sk-a" },
    },
    {
      record: { event: "worker.openshell-git-denied", reasonCode: "xghp_abcdefghijklmnop" },
      exported: { "occ.reason_code": "xghp_abcdefghijklmnop" },
    },
    {
      record: { event: "worker.openshell-git-denied", reasonCode: "a_ghp_abcdefghijklmnop" },
      exported: { "occ.reason_code": "a_ghp_abcdefghijklmnop" },
    },
    {
      record: { event: "worker.openshell-git-denied", reasonCode: `AKIA${"Q".repeat(17)}` },
      exported: { "occ.reason_code": `AKIA${"Q".repeat(17)}` },
    },
    {
      record: { event: "worker.openshell-git-denied", reasonCode: `AKIA${"Q".repeat(16)}_x` },
      exported: { "occ.reason_code": `AKIA${"Q".repeat(16)}_x` },
    },
  ];
  // Values the sanitizer drops lose the field, never the event: text, a leading digit or
  // punctuation, more than 64 characters, a token shape, a non-string code, and a fence
  // that is negative, fractional, unsafe or a string.
  const dropped = [
    { event: "worker.openshell-git-expiry", check: "original launch", failure: "1timeout" },
    { event: "worker.openshell-git-expiry", check: `${longest}c`, failure: "gateway.unavailable" },
    { event: "worker.openshell-git-expiry", check: "", failure: `_${canary}` },
    { event: "worker.openshell-git-expiry", check: 42, failure: ["timeout"], outcome: canary },
    { event: "worker.openshell-git-route-warning", reasonCode: `ghp_${"A1".repeat(10)}` },
    { event: "worker.openshell-git-route-warning", reasonCode: `step-ghs_${"a".repeat(12)}` },
    { event: "worker.openshell-git-route-warning", reasonCode: `github_pat_${"b".repeat(12)}` },
    { event: "worker.openshell-git-denied", reasonCode: `sk-proj-${"c".repeat(12)}` },
    { event: "worker.openshell-git-denied", reasonCode: `XOXB-${"1".repeat(10)}` },
    { event: "worker.openshell-git-denied", reasonCode: `x-AKIA${"Q".repeat(16)}` },
    { event: "worker.openshell-git-denied", reasonCode: `AKIA${"Q".repeat(16)}-x` },
    { event: "worker.completed", hintCode: `akia${"q".repeat(16)}`, harnessState: { state: "a" } },
    { event: "worker.completed", hintCode: "sandbox gateway", harnessState: `starting${canary}!` },
    { event: "worker.openshell-git-route", fence: -1 },
    { event: "worker.openshell-git-route", fence: 1.5 },
    { event: "worker.openshell-git-route", fence: Number.MAX_SAFE_INTEGER + 1 },
    { event: "worker.openshell-git-route", fence: "7" },
  ];
  return [...kept, ...dropped.map((record) => ({ record, exported: {} }))];
}

test("the Collector keeps exactly the code fields the OCC log sanitizer keeps", () => {
  const lines: Record<string, unknown>[] = [];
  const emit = createWorkerLogEmitter(
    createOccLogger({
      component: "occ-worker",
      destination: { write: (text) => lines.push(otlpObject(JSON.parse(text))) },
    }),
  );
  const identity = { namespaceId: `ns_${randomUUID()}` };
  const cases = codeFieldCases({
    canary: "canarysanitizer",
    identity,
    exportedIdentity: { "occ.namespace.id": identity.namespaceId },
  });
  for (const { record, exported } of cases) {
    emit(record);
    const line = lines.at(-1);
    assert.ok(line, "the sanitizer emitted a log line");
    assert.equal(line.event, record.event);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(codeAttributes)
          .filter(([field]) => Object.hasOwn(line, field))
          .map(([field, attribute]) => [attribute, String(line[field])]),
      ),
      Object.fromEntries(
        Object.entries(exported).filter(([attribute]) =>
          Object.values(codeAttributes).includes(attribute),
        ),
      ),
      JSON.stringify(record),
    );
  }
});

test(
  "native Collector exports OpenShell Git expiry and delivery events with the sanitizer's code fields",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector worker code-field proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "occ-codes");
    const receiverAddress = await startKubernetesProcessors(fixture);
    const canary = `canary${fixture.suffix}`;
    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const identity = { namespaceId, agentId, revisionId };
    const exportedIdentity = {
      "occ.namespace.id": namespaceId,
      "occ.agent.id": agentId,
      "occ.revision.id": revisionId,
    };
    // Probe diagnostics survive Pod cleanup through this real Collector pipeline.
    // Only the two fixed reasons and a process-failure curl exit code may escape.
    const probeCases: CodeFieldCase[] = [
      ...[1, 56, 99].map((code) => ({
        reason: "probe_process_failed",
        code,
        exported: {
          "occ.git_probe.reason": "probe_process_failed",
          "occ.git_probe.exit_code": String(code),
        },
      })),
      ...[undefined, -1, 0, 100, 1.5, "56", "E_FAILURE", true, { code: 56 }].map((code) => ({
        reason: "probe_process_failed",
        code,
        exported: { "occ.git_probe.reason": "probe_process_failed" },
      })),
      {
        reason: "probe_response_invalid",
        code: 56,
        exported: { "occ.git_probe.reason": "probe_response_invalid" },
      },
      ...[canary, "probe_process_failed_extra", 56, null].map((reason) => ({
        reason,
        code: 56,
        exported: {},
      })),
    ].map(({ reason, code, exported }) => ({
      record: {
        event: "worker.openshell-git-probe-failed",
        ...identity,
        reason,
        code,
        stdout: canary,
        stderr: canary,
        proof: canary,
        url: canary,
      },
      exported: { ...exportedIdentity, ...exported },
    }));
    const cases = [...codeFieldCases({ canary, identity, exportedIdentity }), ...probeCases].map(
      (entry) => ({ ...entry, requestId: `req_${randomUUID()}` }),
    );
    const line = (record: Record<string, unknown>) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: {
        stringValue: JSON.stringify({
          time: new Date().toISOString(),
          service: "worker",
          severity: "INFO",
          note: canary,
          ...record,
        }),
      },
      attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
    });
    const resource = (component: string) => ({
      attributes: Object.entries({
        "occ.application": "openclaw-enterprise",
        "occ.component": component,
        "k8s.pod.uid": `pod-${randomUUID()}`,
        "container.id": `containerd://${randomUUID()}`,
      }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    });
    await postLogs(receiverAddress, [
      {
        resource: resource("worker"),
        scopeLogs: [
          {
            logRecords: [
              ...cases.map(({ record, requestId }) => line({ ...record, requestId })),
              // Near-matches of the reviewed names are still dropped.
              line({ event: "worker.openshell-git-expiry-unreviewed", check: "model-provider" }),
              line({ event: "worker.openshell-git-probe-failed-unreviewed" }),
              line({ event: "worker.repository-delivery-pending-unreviewed" }),
            ],
          },
        ],
      },
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
      fields: Object.fromEntries(
        attributeEntries(record.attributes).map(([key, value]) => {
          // OTLP JSON carries an int64 as a string; a JSON number may arrive as either.
          const scalar =
            value.stringValue ?? value.boolValue ?? String(value.intValue ?? value.doubleValue);
          assert.ok(typeof scalar === "string" || typeof scalar === "boolean");
          return [key, scalar] as const;
        }),
      ),
    }));
    assert.equal(exported.length, cases.length);
    for (const { record, exported: fields, requestId } of cases) {
      const actual = exported.find((entry) => entry.fields["request.id"] === requestId);
      assert.ok(actual, `${record.event} ${JSON.stringify(record)} is exported`);
      assert.equal(actual.resource["service.name"], "occ-worker");
      assert.equal(otlpObject(actual.record.body).stringValue, record.event);
      assert.equal(actual.record.severityText, "INFO");
      if (fields["occ.fence"] !== undefined) {
        // A fence is exported as an integer, never a double or string.
        const fence = attributeEntries(actual.record.attributes).find(
          ([key]) => key === "occ.fence",
        );
        assert.ok(fence);
        assert.equal(String(fence[1].intValue), fields["occ.fence"]);
      }
      if (fields["occ.git_probe.exit_code"] !== undefined) {
        const code = attributeEntries(actual.record.attributes).find(
          ([key]) => key === "occ.git_probe.exit_code",
        );
        assert.ok(code);
        assert.equal(String(code[1].intValue), fields["occ.git_probe.exit_code"]);
      }
      assert.deepEqual(
        actual.fields,
        {
          "event.name": record.event,
          "log.iostream": "stdout",
          "request.id": requestId,
          ...fields,
        },
        JSON.stringify(record),
      );
    }
    assert.doesNotMatch(JSON.stringify(exported), new RegExp(canary));
  },
);

test(
  "native Collector exports Codex turns, tool calls and plain app-server messages, not span noise",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Codex record proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "codex");
    const receiverAddress = await startKubernetesProcessors(fixture);
    const canary = `CANARY_${fixture.suffix}`;
    const resource = {
      attributes: Object.entries({
        "occ.managed_by": "openclaw-enterprise",
        "occ.role": "agent",
        "openclaw.namespace.id": `ns_${randomUUID()}`,
        "openclaw.agent.id": `agt_${randomUUID()}`,
        "openclaw.revision.id": `rev_${randomUUID()}`,
        "k8s.pod.uid": `pod-${randomUUID()}`,
        "container.id": `containerd://${randomUUID()}`,
      }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    };
    // Codex 0.158 tracing JSON, as `LOG_FORMAT=json` prints it.
    const tracing = (
      level: string,
      target: string,
      fields: Record<string, string>,
      span?: Record<string, string>,
    ) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: {
        stringValue: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          fields,
          target,
          ...(span === undefined ? {} : { span, spans: [] }),
        }),
      },
      attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
    });
    const turn = { name: "turn", model: canary, "turn.id": canary, "thread.id": canary };
    await postLogs(receiverAddress, [
      {
        resource,
        scopeLogs: [
          {
            logRecords: [
              tracing("INFO", "codex_core::tasks", { message: "new" }, turn),
              tracing("INFO", "codex_core::tasks", { message: "enter" }, turn),
              tracing("INFO", "codex_core::tasks", { message: "exit" }, turn),
              tracing("INFO", "codex_core::tasks", { message: "close", "time.busy": canary }, turn),
              tracing(
                "INFO",
                "codex_app_server::app_server_tracing",
                { message: "enter" },
                {
                  name: "app_server.request",
                },
              ),
              tracing(
                "INFO",
                "codex_app_server::app_server_tracing",
                { message: "new" },
                {
                  name: "app_server.request",
                },
              ),
              tracing("INFO", "codex_core::tools::parallel", {
                message: "tool call completed",
                tool_name: "shell",
                call_id: canary,
                turn_id: canary,
              }),
              tracing("INFO", "codex_core::tools::parallel", {
                message: "tool call completed",
                tool_name: `${canary} "x"`,
              }),
              tracing("INFO", "codex_app_server", {
                message:
                  "received shutdown signal; entering graceful restart drain (connections=0, runningAssistantTurns=0, new client turns rejected)",
              }),
              // Transport records below warn are not reviewed operational output.
              tracing("INFO", "codex_app_server_transport::transport::websocket", {
                message: "websocket client connected",
                peer_addr: "127.0.0.1:41000",
              }),
              tracing("INFO", "codex_app_server", {
                message: "outbound router task exited (channel closed)",
              }),
              // Unreviewed message text keeps the event name as its body (errors) or is
              // dropped (warnings).
              tracing("ERROR", "codex_app_server", {
                message: `Failed to deserialize JSONRPCMessage: invalid type: string "${canary}"`,
              }),
              tracing("WARN", "codex_app_server", { message: `failed to refresh token ${canary}` }),
              tracing("WARN", "codex_app_server", { message: `${"x".repeat(30)}${canary}` }),
              // Model failures from any Codex target, never the codex_otel content targets.
              // Only app-server and the fixed codex_core retry messages keep their text.
              tracing("WARN", "codex_core::responses_retry", {
                message: "stream connection failed; waiting to retry",
                error: canary,
                prompt: canary,
              }),
              tracing("WARN", "codex_otel::log_only", {
                message: "stream connection failed; waiting to retry",
              }),
              // codex_core can interpolate chat text into a warning; plain prose
              // that passes the plain-text pattern is never exported as text.
              tracing("WARN", "codex_core::event_mapping", {
                message: "Output text in user message: deploy the payroll service now",
              }),
              tracing("ERROR", "codex_core::session::handlers", {
                message: "Failed to apply execpolicy amendment: rm allowed",
              }),
              tracing("INFO", "codex_core::client", { message: "using model" }),
              // A repeating plugin warning without a reviewed message is dropped.
              tracing("WARN", "codex_core_plugins::manager", {
                message: "remote installed plugin bundle sync failed",
              }),
            ],
          },
        ],
      },
      sentinelLogs(resource),
    ]);
    const exported = await exportedThroughSentinel(fixture, (_resource, record) => ({
      attributes: attributes(record.attributes),
      record,
    }));
    const summary = exported
      .map(({ attributes: kept, record }) =>
        JSON.stringify([
          record.severityText,
          kept["event.name"],
          otlpObject(record.body).stringValue,
          kept["occ.codex.tool_name"] ?? null,
        ]),
      )
      .sort();
    assert.deepEqual(
      summary,
      [
        ["INFO", "codex.turn", "turn started", null],
        ["INFO", "codex.turn", "turn completed", null],
        ["INFO", "codex.tool_call", "tool call completed", "shell"],
        ["INFO", "codex.tool_call", "tool call completed", null],
        [
          "INFO",
          "codex.operational",
          "received shutdown signal; entering graceful restart drain (connections=0, runningAssistantTurns=0, new client turns rejected)",
          null,
        ],
        ["INFO", "codex.operational", "outbound router task exited (channel closed)", null],
        ["ERROR", "codex.operational", "codex.operational", null],
        ["WARN", "codex.operational", "stream connection failed; waiting to retry", null],
        ["ERROR", "codex.operational", "codex.operational", null],
      ]
        .map((entry) => JSON.stringify(entry))
        .sort(),
    );
    assert.doesNotMatch(JSON.stringify(exported), /CANARY_/);
  },
);

test(
  "native Collector keeps argv credentials out of Codex bodies and exports Gateway startup failures",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Gateway startup proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "gateway-startup");
    const receiverAddress = await startKubernetesProcessors(fixture);
    const canary = `CANARY_${fixture.suffix}`;
    const resource = {
      attributes: Object.entries({
        "occ.managed_by": "openclaw-enterprise",
        "occ.role": "gateway",
        "openclaw.namespace.id": `ns_${randomUUID()}`,
        "openclaw.agent.id": `agt_${randomUUID()}`,
        "openclaw.revision.id": `rev_${randomUUID()}`,
        "k8s.pod.uid": `pod-${randomUUID()}`,
        "container.id": `containerd://${randomUUID()}`,
      }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    };
    // OpenClaw's JSON console prints the startup failure with no subsystem.
    const consoleLine = (record: Record<string, unknown>) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: { stringValue: JSON.stringify({ time: new Date().toISOString(), ...record }) },
      attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
    });
    const cause =
      "Gateway failed to start: gateway.bind=custom requires gateway.customBindHost. Run openclaw gateway status --deep for diagnostics.";
    const codexResource = {
      attributes: resource.attributes.map((entry) =>
        entry.key === "occ.role" ? { key: "occ.role", value: { stringValue: "agent" } } : entry,
      ),
    };
    const codexError = (message: string) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: {
        stringValue: JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "ERROR",
          fields: { message },
          target: "codex_app_server",
        }),
      },
      attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
    });
    await postLogs(receiverAddress, [
      {
        // argv credentials have no credential word: a codex.operational body with a
        // credential flag or a user:password pair keeps the event name.
        resource: codexResource,
        scopeLogs: [
          {
            logRecords: [
              codexError(`exec_command failed: curl -u admin:${canary} https://x.example`),
              codexError(`exec_command failed: git --password ${canary}`),
            ],
          },
        ],
      },
      {
        resource,
        scopeLogs: [
          {
            logRecords: [
              consoleLine({ level: "error", message: cause }),
              // A cause that names a credential, or quotes a value, keeps the event name.
              consoleLine({
                level: "error",
                message: `Gateway failed to start: gateway.auth.token ${canary} is invalid`,
              }),
              consoleLine({
                level: "error",
                message: `Gateway failed to start: "${canary}"`,
              }),
              // Other subsystem-less output (a chat reply printed by runtime.log) and
              // a non-error startup line are not exported.
              consoleLine({ level: "info", message: `Gateway failed to start: ${canary}` }),
              consoleLine({ level: "error", message: canary }),
            ],
          },
        ],
      },
      sentinelLogs(resource),
    ]);
    const exported = await exportedThroughSentinel(fixture, (_resource, record) => ({
      attributes: attributes(record.attributes),
      record,
    }));
    assert.deepEqual(
      exported
        .map(({ attributes: kept, record }) =>
          JSON.stringify([
            record.severityText,
            kept["event.name"],
            otlpObject(record.body).stringValue,
          ]),
        )
        .sort(),
      [
        ["ERROR", "codex.operational", "codex.operational"],
        ["ERROR", "codex.operational", "codex.operational"],
        ["ERROR", "gateway.startup_failed", cause],
        ["ERROR", "gateway.startup_failed", "gateway.startup_failed"],
        ["ERROR", "gateway.startup_failed", "gateway.startup_failed"],
      ]
        .map((entry) => JSON.stringify(entry))
        .sort(),
    );
    assert.doesNotMatch(JSON.stringify(exported), /CANARY_/);
  },
);

// Stands in for the API server behind k8sattributes: serves one Pod through
// list or watch-list, and withholds every Pod response until the test releases it.
function servePodMetadata(startServer: typeof createServer, pod: unknown) {
  const requests: string[] = [];
  const held: { url: URL; response: ServerResponse }[] = [];
  let released = false;

  const answer = (url: URL, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    if (url.searchParams.get("watch") === "true") {
      response.writeHead(200);
      if (url.searchParams.get("sendInitialEvents") === "true") {
        response.write(JSON.stringify({ type: "ADDED", object: pod }) + "\n");
        response.write(
          JSON.stringify({
            type: "BOOKMARK",
            object: {
              kind: "Pod",
              apiVersion: "v1",
              metadata: {
                resourceVersion: "10",
                annotations: { "k8s.io/initial-events-end": "true" },
              },
            },
          }) + "\n",
        );
      }
      return;
    }
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "PodList",
        metadata: { resourceVersion: "10" },
        items: [pod],
      }),
    );
  };

  startServer((request, response) => {
    const url = new URL(request.url ?? "", "http://api");
    if (url.pathname === "/fixture/requests") {
      return response.end(JSON.stringify(requests));
    }
    if (url.pathname === "/fixture/release") {
      released = true;
      for (const { url, response } of held.splice(0)) {
        answer(url, response);
      }
      return response.end("released");
    }
    if (url.pathname !== "/api/v1/pods" || request.url === undefined) {
      response.writeHead(404);
      return response.end("{}");
    }
    requests.push(request.url);
    if (released) {
      return answer(url, response);
    }
    held.push({ url, response });
  }).listen(8001, "0.0.0.0");
}

test(
  "native Collector keeps CRI records written before Kubernetes Pod metadata syncs",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Kubernetes metadata proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "sync");
    // The fixture's cleanup removes this container with the rest of its network.
    const api = `oce-otel-sync-api-${fixture.suffix}`;
    const namespace = `system-${fixture.suffix}`;
    const podName = `openclaw-enterprise-worker-${fixture.suffix}`;
    const podUid = randomUUID();
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace,
        uid: podUid,
        resourceVersion: "10",
        labels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/component": "worker",
        },
      },
      spec: { nodeName: "fixture-node", containers: [{ name: "worker", image: "fixture" }] },
      status: {
        containerStatuses: [
          {
            name: "worker",
            image: "fixture",
            imageID: `registry.example.test/controller@sha256:${"b".repeat(64)}`,
            containerID: `containerd://${fixture.suffix}`,
            ready: true,
            restartCount: 0,
            state: { running: {} },
          },
        ],
      },
    };
    // The worker's only startup event is already on disk when the Collector
    // starts, exactly as for a DaemonSet added to (or restarted on) a live node.
    const pods = join(fixture.directory, "pods");
    const logDirectory = join(pods, `${namespace}_${podName}_${podUid}`, "worker");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      join(logDirectory, "0.log"),
      `${new Date().toISOString()} stdout F ${JSON.stringify({ level: 30, event: "worker.started", computeDriverId: "kubernetes" })}\n`,
    );
    await docker([
      "run",
      "--detach",
      "--name",
      api,
      "--network",
      fixture.network,
      "--publish",
      "127.0.0.1::8001",
      "--env",
      `POD=${JSON.stringify(pod)}`,
      nodeImage,
      "node",
      "-e",
      // Node erases the types before serializing this self-contained child program.
      `(${servePodMetadata.toString()})(require("node:http").createServer, JSON.parse(process.env.POD));`,
    ]);
    const control = `http://${(await docker(["port", api, "8001/tcp"])).split("\n")[0]}/fixture`;
    const podRequests = async (): Promise<string[]> => {
      const body: unknown = await fetch(`${control}/requests`)
        .then((response) => response.json())
        .catch(() => []);
      assert.ok(Array.isArray(body), "expected a list of Pod metadata request URLs");
      const requests: unknown[] = body;
      assert.ok(requests.every((request) => typeof request === "string"));
      return requests;
    };
    await waitFor("the Pod metadata fixture", async () =>
      fetch(`${control}/requests`)
        .then((response) => response.ok)
        .catch(() => false),
    );
    await writeFile(
      join(fixture.directory, "kubeconfig"),
      `${JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "fixture", cluster: { server: `http://${api}:8001` } }],
        users: [{ name: "fixture", user: {} }],
        contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
        "current-context": "fixture",
      })}\n`,
    );
    // Only the credential source differs from the shipped receiver file.
    await writeFile(
      join(fixture.directory, "metadata-auth.yaml"),
      "processors:\n  k8sattributes:\n    auth_type: kubeConfig\n",
    );
    await fixture.startCollector({
      receiverPath: join(root, "deploy/logging/kubernetes.yaml"),
      publish: [],
      env: ["K8S_NODE_NAME=fixture-node", "KUBECONFIG=/etc/otel-fixture/kubeconfig"],
      volumes: [
        `${pods}:/var/log/pods:ro`,
        `${join(fixture.directory, "kubeconfig")}:/etc/otel-fixture/kubeconfig:ro`,
      ],
      configs: [join(fixture.directory, "metadata-auth.yaml")],
    });
    const records = async () =>
      exportedRecords(fixture.out, (resource, record) => ({
        resource: attributes(asRecord(resource.resource)?.attributes),
        record,
      }));

    // Hold Pod metadata well past filelog's first 200 ms poll. A pipeline that
    // started without metadata has read, dropped and committed the record by now.
    await waitFor(
      "the Collector's first Pod metadata request",
      async () => (await podRequests()).length > 0,
      fixture,
    );
    await delay(3_000);
    assert.deepEqual(await records(), []);
    await fetch(`${control}/release`, { method: "POST" });

    await waitFor(
      "the record after Pod metadata syncs",
      async () => (await records()).length > 0,
      fixture,
    );
    const exported = await records();
    assert.equal(exported.length, 1);
    const [entry] = exported;
    assert.ok(entry);
    assert.equal(entry.resource["service.name"], "occ-worker");
    assert.equal(entry.resource["service.instance.id"], podUid);
    assert.equal(asRecord(entry.record.body)?.stringValue, "worker.started");
    assert.equal(entry.record.severityText, "INFO");
  },
);
