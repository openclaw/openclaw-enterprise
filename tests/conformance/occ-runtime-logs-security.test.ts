import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";
import { InMemoryAuditSink, type AuditEvent } from "../../packages/audit/src/index.ts";
import {
  ErrorResponse,
  JsonValue,
  type ErrorCode,
} from "../../packages/contracts/src/api/common.ts";
import {
  AgentRevisionResponse,
  AgentRuntimeDescriptionSchema,
  AgentRuntimeLogPageSchema,
  type AgentRuntimeLogPageWire,
} from "../../packages/contracts/src/api/resources.ts";
import type { Permission } from "../../packages/contracts/src/index.ts";
import { RuntimeLogsForbiddenByClusterError } from "../../packages/occ/src/index.ts";
import { denialsDuring } from "../helpers/console-audit-denials.ts";
import {
  callerDenied,
  POLICY_RECOMMENDATIONS_NO_SANDBOX,
  runtimeLogSourceUnavailable,
} from "../helpers/refusal-text.mjs";
import {
  administerGrants,
  createProviderSandboxDriver,
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
  operateGrants,
} from "../helpers/runtime-logs.ts";

const LOGS_GRANT = "Agent read_logs (or Agent administer)";
const VIEW_ACTION = "openclaw.agents.runtime_logs.view";
const DOWNLOAD_ACTION = "openclaw.agents.runtime_logs.download";

type FixtureOptions = Parameters<typeof createRuntimeLogFixture>[0];
type Compute = ReturnType<typeof createRuntimeLogComputeDriver>;
type FixtureResponse = Awaited<
  ReturnType<Awaited<ReturnType<typeof createRuntimeLogFixture>>["request"]>
>;
type LogRecord = AgentRuntimeLogPageWire["records"][number];
type ComputeCall = Compute["calls"][number];

async function createSecurityFixture({
  computeDriver = createRuntimeLogComputeDriver(),
  ...options
}: Omit<NonNullable<FixtureOptions>, "computeDriver"> & { computeDriver?: Compute } = {}) {
  const fixture = await createRuntimeLogFixture({ ...options, computeDriver });
  return { ...fixture, computeDriver };
}

function runtimeDescription(response: FixtureResponse) {
  assert.equal(response.status, 200, response.text);
  assert.ok(Check(AgentRuntimeDescriptionSchema, response.data), response.text);
  return response.data;
}

function logPage(response: FixtureResponse) {
  assert.equal(response.status, 200, response.text);
  assert.ok(Check(AgentRuntimeLogPageSchema, response.data), response.text);
  return response.data;
}

function apiError(response: FixtureResponse, status: number, code: ErrorCode, label?: string) {
  const message = label === undefined ? response.text : `${label}: ${response.text}`;
  assert.equal(response.status, status, message);
  assert.ok(Check(ErrorResponse, response.body), message);
  assert.equal(response.body.error.code, code, message);
  return response.body.error;
}

function cursorFrom(page: AgentRuntimeLogPageWire) {
  assert.ok(page.cursor, "expected a cursor for the log view");
  return page.cursor;
}

function lineMessages(records: readonly LogRecord[]) {
  return records.map((record) => {
    assert.equal(record.type, "line");
    return record.message;
  });
}

function auditDetails(event: AuditEvent | undefined, key: string) {
  const details = event?.details?.[key];
  assert.ok(
    typeof details === "object" && details !== null && !Array.isArray(details),
    `missing audit details for ${key}`,
  );
  return details;
}

function logAuditEvents(
  sink: InMemoryAuditSink,
  action: typeof VIEW_ACTION | typeof DOWNLOAD_ACTION,
) {
  return sink.events.filter((event) => event.action === action);
}

function runtimeLogLine(index: number, raw = `gateway output ${index}`) {
  return { time: `2026-09-30T12:00:${String(index).padStart(2, "0")}.000000001Z`, raw };
}

function driverReads(fixture: { computeDriver: Compute }) {
  return fixture.computeDriver.calls.filter(
    (call): call is Extract<ComputeCall, { operation: "read" }> => call.operation === "read",
  );
}

test("runtime status and log reads enforce their permission tiers before any Driver call", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];

  const reader = await fixture.createPrincipal("runtime-reader", target, [
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ]);
  const operator = await fixture.createPrincipal("runtime-operator", target, operateGrants);
  const administerOnly = await fixture.createPrincipal("runtime-administer-only", target, [
    { action: "administer", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ]);
  const administrator = await fixture.createPrincipal(
    "runtime-administrator",
    target,
    administerGrants,
  );
  fixture.computeDriver.calls.length = 0;

  for (const path of [target.runtimePath, target.logsPath()]) {
    const denied = await fixture.request("GET", path, { session: reader.session });
    apiError(denied, 403, "FORBIDDEN", path);
    assert.equal(fixture.auditSink.events.at(-1)?.kind, "authorization_denial");
  }
  // Operate is the status audience: it sees Pods and Events but never log text.
  const status = await fixture.request("GET", target.runtimePath, { session: operator.session });
  assert.equal(
    runtimeDescription(status).sources[0]?.pods[0]?.name,
    fixture.computeDriver.podName({ id: target.revisionId }),
  );
  const operatorLogs = await fixture.request("GET", target.logsPath(), {
    session: operator.session,
  });
  assert.equal(operatorLogs.status, 403);
  // Without either log grant the denial names the delegable read_logs permission.
  assert.deepEqual(fixture.auditSink.events.at(-1)?.authorization, {
    principalId: operator.principal.id,
    action: "read_logs",
    resource: { kind: "agent", id: target.agent.id, namespaceId: target.namespace.id },
  });
  const missingRead = await fixture.request("GET", target.logsPath(), {
    session: administerOnly.session,
  });
  assert.equal(missingRead.status, 403);
  assert.equal(fixture.auditSink.events.at(-1)?.authorization?.action, "read");
  // No denied request reached the Driver.
  assert.deepEqual(
    fixture.computeDriver.calls.map(({ operation }) => operation),
    ["describe"],
  );

  const logs = await fixture.request("GET", target.logsPath(), {
    session: administrator.session,
  });
  assert.deepEqual(lineMessages(logPage(logs).records), ["gateway output 1"]);

  // A principal of another Namespace is denied like every revision-scoped route: the
  // exact revision read is authorized before anything about the runtime is observed.
  const other = await fixture.deployAgent("runtime-other");
  const foreign = await fixture.createPrincipal("runtime-foreign", other, administerGrants);
  fixture.computeDriver.calls.length = 0;
  for (const path of [target.runtimePath, target.logsPath()]) {
    const crossNamespace = await fixture.request("GET", path, { session: foreign.session });
    assert.equal(crossNamespace.status, 403, path);
  }
  assert.equal(fixture.computeDriver.calls.length, 0);

  // Service principals use the same bindings (CLI and automation).
  const service = await fixture.createServicePrincipal("runtime-cli", target, administerGrants);
  const serviceLogs = await fixture.request("GET", target.logsPath(), {
    serviceKey: service.serviceKey,
  });
  assert.equal(serviceLogs.status, 200, serviceLogs.text);

  // Every grant above is bound to the exact Agent and revision. A second Agent of the same
  // Namespace is refused to each caller for each tier, audited once for its first unmet check,
  // and no refused request reaches the Driver.
  const sibling = await fixture.deployAgent("runtime-sibling", { namespace: target.namespace });
  const logsRefusal = {
    grant: LOGS_GRANT,
    target: `Agent ${sibling.agent.id}`,
    denial: { action: "read_logs", kind: "agent", id: sibling.agent.id },
  };
  fixture.computeDriver.calls.length = 0;
  for (const [caller, path, refusal] of [
    // The status tier resolves the exact revision first.
    [
      { session: operator.session },
      sibling.runtimePath,
      {
        grant: "AgentRevision read",
        target: `AgentRevision ${sibling.revisionId}`,
        denial: { action: "read", kind: "agent_revision", id: sibling.revisionId },
      },
    ],
    [{ session: administrator.session }, sibling.logsPath(), logsRefusal],
    [
      { session: administrator.session },
      sibling.logsPath("source=gateway&download=true"),
      logsRefusal,
    ],
    [{ serviceKey: service.serviceKey }, sibling.logsPath(), logsRefusal],
  ] as const) {
    const { response, denials } = await denialsDuring(fixture.auditSink, () =>
      fixture.request("GET", path, caller),
    );
    const error = apiError(response, 403, "FORBIDDEN", path);
    assert.equal(error.message, callerDenied(refusal.grant, refusal.target), path);
    assert.deepEqual(denials, [refusal.denial], path);
  }
  assert.equal(fixture.computeDriver.calls.length, 0);
});

test("a delegated read_logs principal reads and downloads logs without administer", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  const logReader: Permission[] = [
    { action: "read_logs", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ];
  const delegate = await fixture.createPrincipal("runtime-log-reader", target, logReader);
  const accessEvents = () =>
    fixture.auditSink.events.filter(
      ({ action, actor }) =>
        action.startsWith("openclaw.agents.runtime_logs.") &&
        actor?.principalId === delegate.principal.id,
    );

  // read_logs admits log text but nothing the administer tier also covers.
  const logs = await fixture.request("GET", target.logsPath(), { session: delegate.session });
  assert.deepEqual(lineMessages(logPage(logs).records), ["gateway output 1"]);
  const download = await fixture.request("GET", target.logsPath("source=gateway&download=true"), {
    session: delegate.session,
  });
  assert.equal(download.status, 200, download.text);
  assert.match(download.text, /gateway output 1/);
  const nativeAdmin = await fixture.request(
    "GET",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/native-admin`,
    { session: delegate.session },
  );
  assert.equal(nativeAdmin.status, 403);
  // Runtime status stays with the operate audience.
  const status = await fixture.request("GET", target.runtimePath, { session: delegate.session });
  assert.equal(status.status, 403);

  // Each read is an access event that names the delegated grant, never the text.
  const granted = accessEvents().filter(({ kind }) => kind === "access");
  assert.equal(granted.length, 2);
  assert.deepEqual(
    granted.map(({ kind, action, outcome, authorization }) => [
      kind,
      action,
      outcome,
      authorization?.action,
    ]),
    [
      ["access", "openclaw.agents.runtime_logs.view", "success", "read_logs"],
      ["access", "openclaw.agents.runtime_logs.download", "success", "read_logs"],
    ],
  );
  assert.equal(JSON.stringify(accessEvents()).includes("gateway output 1"), false);

  // The grant is still exact-Agent: a sibling Agent's logs in the same Namespace are denied,
  // audited once for that Agent.
  const sibling = await fixture.deployAgent("runtime-log-sibling", { namespace: target.namespace });
  const { response: siblingLogs, denials } = await denialsDuring(fixture.auditSink, () =>
    fixture.request("GET", sibling.logsPath(), { session: delegate.session }),
  );
  const siblingError = apiError(siblingLogs, 403, "FORBIDDEN");
  assert.equal(siblingError.message, callerDenied(LOGS_GRANT, `Agent ${sibling.agent.id}`));
  assert.deepEqual(denials, [{ action: "read_logs", kind: "agent", id: sibling.agent.id }]);

  // A read_logs Restriction wins even over administer, so it cannot be bypassed.
  const both = await fixture.createPrincipal("runtime-log-both", target, [
    ...logReader,
    { action: "administer", resourceKind: "agent" },
  ]);
  fixture.policy.restrictions.push({
    id: `restriction-read-logs-${target.agent.id}`,
    namespaceId: target.namespace.id,
    action: "read_logs",
    resourceKind: "agent",
    resourceId: target.agent.id,
    effect: "deny",
  });
  const reads = driverReads(fixture).length;
  for (const principal of [delegate, both]) {
    const restricted = await fixture.request("GET", target.logsPath(), {
      session: principal.session,
    });
    assert.equal(restricted.status, 403);
    const denial = fixture.auditSink.events.at(-1);
    assert.equal(denial?.kind, "authorization_denial");
    assert.equal(denial.authorization?.action, "read_logs");
    const evidence = auditDetails(denial, "iamEvidence");
    assert.ok("restrictionIds" in evidence);
    assert.deepEqual(evidence.restrictionIds, [`restriction-read-logs-${target.agent.id}`]);
  }
  assert.equal(driverReads(fixture).length, reads);

  // Revocation between polls is honoured for the delegated grant too.
  fixture.policy.restrictions.length = 0;
  const again = await fixture.request("GET", target.logsPath(), { session: delegate.session });
  const cursor = cursorFrom(logPage(again));
  delegate.revoke("read_logs", "agent");
  const revoked = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(cursor)}`),
    { session: delegate.session },
  );
  assert.equal(revoked.status, 403);
});

test("an Agent-level read_logs grant covers every revision, including later deployments", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  // No per-revision grant: log text is delegated on the exact Agent alone.
  const delegate = await fixture.createPrincipal("runtime-log-agent-only", target, [
    { action: "read_logs", resourceKind: "agent" },
    { action: "read", resourceKind: "agent" },
  ]);
  const first = await fixture.request("GET", target.logsPath(), { session: delegate.session });
  assert.deepEqual(lineMessages(logPage(first).records), ["gateway output 1"]);

  // A new deployment creates a new revision; the same Agent grant still reads its logs.
  const redeployed = await fixture.request(
    "POST",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deploy`,
  );
  assert.equal(redeployed.status, 202, redeployed.text);
  assert.ok(
    Check({ SafeJsonValue: JsonValue }, AgentRevisionResponse, redeployed.body),
    redeployed.text,
  );
  const revisionId = redeployed.body.data.id;
  assert.notEqual(revisionId, target.revisionId);
  const secondPath = `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deployments/${revisionId}/runtime/logs?source=gateway`;
  const second = await fixture.request("GET", secondPath, { session: delegate.session });
  assert.equal(second.status, 200, second.text);
  const download = await fixture.request("GET", `${secondPath}&download=true`, {
    session: delegate.session,
  });
  assert.equal(download.status, 200, download.text);
  assert.match(download.text, /gateway output 1/);

  // Runtime status keeps its revision requirement, and a revision of another Agent is
  // never reachable through this Agent's path.
  const status = await fixture.request("GET", target.runtimePath, { session: delegate.session });
  assert.equal(status.status, 403);
  const sibling = await fixture.deployAgent("runtime-log-agent-only-sibling", {
    namespace: target.namespace,
  });
  const accessCount = (action: string) =>
    fixture.auditSink.events.filter(
      ({ kind, action: eventAction }) => kind === "access" && eventAction === action,
    ).length;
  const callsBeforeCrossed = fixture.computeDriver.calls.length;
  const viewsBeforeCrossed = accessCount("openclaw.agents.runtime_logs.view");
  const downloadsBeforeCrossed = accessCount("openclaw.agents.runtime_logs.download");
  // Reject the mismatched existing revision before any Compute call or access admission.
  for (const query of ["source=gateway", "source=gateway&download=true"]) {
    const crossed = await fixture.request(
      "GET",
      `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deployments/${sibling.revisionId}/runtime/logs?${query}`,
      { session: delegate.session },
    );
    apiError(crossed, 404, "NOT_FOUND", query);
    assert.equal(fixture.computeDriver.calls.length, callsBeforeCrossed, query);
    assert.equal(accessCount("openclaw.agents.runtime_logs.view"), viewsBeforeCrossed, query);
    assert.equal(
      accessCount("openclaw.agents.runtime_logs.download"),
      downloadsBeforeCrossed,
      query,
    );
  }

  const readsBeforeRevocation = driverReads(fixture).length;
  delegate.revoke("read_logs", "agent");
  const revoked = await fixture.request("GET", secondPath, { session: delegate.session });
  assert.equal(revoked.status, 403);
  assert.equal(driverReads(fixture).length, readsBeforeRevocation);
});

test("runtime log cursors bind one principal and view and are re-authorized on every poll", async () => {
  const fixture = await createSecurityFixture({
    computeDriver: createRuntimeLogComputeDriver({
      sandboxNamespaceName: () => "cursor-tenant",
      state: {
        harnessPod: { ready: true },
        harnessLines: [runtimeLogLine(1, "Agent container output")],
        lines: [runtimeLogLine(1), runtimeLogLine(2)],
      },
    }),
    sandboxDriver: createProviderSandboxDriver().driver,
  });
  const target = await fixture.deployAgent();
  const state = fixture.computeDriver.state;
  const viewer = await fixture.createPrincipal("runtime-viewer", target, administerGrants);
  const other = await fixture.createPrincipal("runtime-other-viewer", target, administerGrants);

  const first = await fixture.request("GET", target.logsPath(), { session: viewer.session });
  const firstPage = logPage(first);
  assert.equal(firstPage.records.length, 2);
  const views = () => logAuditEvents(fixture.auditSink, VIEW_ACTION);
  assert.equal(views().length, 1);
  const view = views()[0];
  assert.equal(view?.kind, "access");
  assert.equal(view.authorization?.action, "administer");
  assert.equal(view.actor?.principalId, viewer.principal.id);
  const details = auditDetails(view, "runtimeLogs");
  assert.ok("viewId" in details);
  assert.deepEqual(
    { ...details, viewId: typeof details.viewId },
    {
      viewId: "string",
      revisionId: target.revisionId,
      source: "gateway",
      pod: fixture.computeDriver.podName({ id: target.revisionId }),
      container: "gateway",
      previous: false,
      tailLines: 200,
    },
  );

  const token = cursorFrom(firstPage);
  const cursor = encodeURIComponent(token);

  // The Agent container is readable on this revision with the same principal.
  const agentPath = target.logsPath("source=agent&container=agent");
  const agent = await fixture.request("GET", agentPath, { session: viewer.session });
  assert.deepEqual(lineMessages(logPage(agent).records), ["Agent container output"]);
  assert.equal(views().length, 2);

  // Moving an intact Gateway cursor to the Agent source must fail before a text read or access audit.
  const readsBeforeCrossed = driverReads(fixture).length;
  const auditCount = () => fixture.auditSink.events.filter(({ kind }) => kind === "access").length;
  const auditsBefore = auditCount();
  const crossed = await fixture.request("GET", `${agentPath}&cursor=${cursor}`, {
    session: viewer.session,
  });
  apiError(crossed, 400, "RUNTIME_LOGS_CURSOR_INVALID", "another source");
  assert.equal(driverReads(fixture).length, readsBeforeCrossed);
  assert.equal(auditCount(), auditsBefore);

  // A follow poll returns only lines after the cursor and is not re-audited.
  state.lines = [runtimeLogLine(1), runtimeLogLine(2), runtimeLogLine(3)];
  const next = await fixture.request("GET", target.logsPath(`source=gateway&cursor=${cursor}`), {
    session: viewer.session,
  });
  const nextPage = logPage(next);
  assert.deepEqual(lineMessages(nextPage.records), ["gateway output 3"]);
  const sinceSeconds = driverReads(fixture).at(-1)?.sinceSeconds;
  assert.ok(sinceSeconds !== undefined && sinceSeconds >= 1);
  assert.equal(views().length, 2);

  // A container restart is labelled, never a silent restart of the stream.
  state.restartCount = 1;
  state.lines = [runtimeLogLine(4, "after restart")];
  const replaced = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(cursorFrom(nextPage))}`),
    { session: viewer.session },
  );
  assert.deepEqual(
    logPage(replaced).records.map((record) =>
      record.type === "gap" ? record.reason : record.type === "line" ? record.message : record.type,
    ),
    ["stream_replaced", "after restart"],
  );
  state.previousLines = [runtimeLogLine(0, "before restart")];
  const previous = await fixture.request("GET", target.logsPath("source=gateway&previous=true"), {
    session: viewer.session,
  });
  assert.deepEqual(lineMessages(logPage(previous).records), ["before restart"]);
  assert.equal(driverReads(fixture).at(-1)?.previous, true);
  // Reusing a view's cursor for another instance selection starts a new audited view.
  const previousWithCursor = await fixture.request(
    "GET",
    target.logsPath(
      `source=gateway&previous=true&cursor=${encodeURIComponent(cursorFrom(nextPage))}`,
    ),
    { session: viewer.session },
  );
  assert.equal(previousWithCursor.status, 200, previousWithCursor.text);
  assert.equal(views().length, 4);
  const readsBefore = driverReads(fixture).length;

  // The other principal and a changed signature independently invalidate the same cursor.
  const [version, payload, originalMac] = token.split(".");
  assert.ok(version && payload && originalMac);
  const tamperedMac = `${originalMac[0] === "A" ? "B" : "A"}${originalMac.slice(1)}`;
  const tamperedCursor = `${version}.${payload}.${tamperedMac}`;
  assert.equal(
    Buffer.from(originalMac, "base64url").equals(Buffer.from(tamperedMac, "base64url")),
    false,
    "the tamper control must change decoded MAC bytes",
  );
  for (const [label, submitted, session] of [
    ["foreign principal", token, other.session],
    ["tampered", tamperedCursor, viewer.session],
  ] as const) {
    const rejected = await fixture.request(
      "GET",
      target.logsPath(`source=gateway&cursor=${encodeURIComponent(submitted)}`),
      { session },
    );
    apiError(rejected, 400, "RUNTIME_LOGS_CURSOR_INVALID", label);
  }
  assert.equal(driverReads(fixture).length, readsBefore);

  // Only Pods the Driver listed for this revision reach it.
  const unknownPod = await fixture.request(
    "GET",
    target.logsPath("source=gateway&pod=kube-apiserver-0"),
    {
      session: viewer.session,
    },
  );
  apiError(unknownPod, 400, "RUNTIME_LOGS_POD_INVALID");
  const unsupported = await fixture.request("GET", target.logsPath("source=gateway&follow=true"), {
    session: viewer.session,
  });
  assert.equal(unsupported.status, 400);
  // Bounds are exact decimal text: 1 to 1000 lines and 1 to 86400 seconds, never clamped.
  for (const query of [
    "tailLines=0",
    "tailLines=01",
    "tailLines=1001",
    "sinceSeconds=0",
    "sinceSeconds=86401",
  ]) {
    const outOfRange = await fixture.request("GET", target.logsPath(`source=gateway&${query}`), {
      session: viewer.session,
    });
    const error = apiError(outOfRange, 400, "INVALID_REQUEST", query);
    assert.deepEqual(
      error.details,
      [{ path: `/${query.split("=")[0]}`, code: "INVALID_FORMAT" }],
      query,
    );
  }
  assert.equal(driverReads(fixture).length, readsBefore);

  // Revocation between polls is honoured with the same cursor.
  viewer.revoke("administer", "agent");
  const revoked = await fixture.request("GET", target.logsPath(`source=gateway&cursor=${cursor}`), {
    session: viewer.session,
  });
  assert.equal(revoked.status, 403);
  assert.equal(driverReads(fixture).length, readsBefore);
});

test("minLevel filters log lines on the server and a cursor still resumes after hidden lines", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  const state = fixture.computeDriver.state;
  const codex = (
    index: number,
    level: string,
    fields: { message: string },
    span?: { name: string },
  ) =>
    runtimeLogLine(
      index,
      JSON.stringify({
        timestamp: "2026-10-01T07:49:44.100970Z",
        level,
        fields,
        target: span === undefined ? "codex_app_server" : "codex_exec_server::local_file_system",
        ...(span === undefined ? {} : { span, spans: [] }),
      }),
    );
  state.lines = [
    codex(1, "INFO", { message: "new" }, { name: "fs.read_file" }),
    codex(2, "WARN", { message: "retrying model request" }),
    runtimeLogLine(3, "plain wrapper text"),
    codex(4, "INFO", { message: "close" }, { name: "fs.read_file" }),
  ];
  const views = () => logAuditEvents(fixture.auditSink, VIEW_ACTION);
  const shown = (page: AgentRuntimeLogPageWire) =>
    page.records.map((record) =>
      record.type === "line" ? `${record.level} ${record.message}` : record.type,
    );

  const all = await fixture.request("GET", target.logsPath("source=gateway"));
  assert.deepEqual(shown(logPage(all)), [
    "debug span new fs.read_file",
    "warn retrying model request",
    "unknown plain wrapper text",
    "debug span close fs.read_file",
  ]);

  // Lines of unknown level stay: the server cannot tell they are below the floor.
  const info = await fixture.request("GET", target.logsPath("source=gateway&minLevel=info"));
  const infoPage = logPage(info);
  assert.deepEqual(shown(infoPage), ["warn retrying model request", "unknown plain wrapper text"]);
  assert.equal(views().length, 2);

  // A poll at the same level is the same view and resumes after the last line read,
  // including the hidden debug line, so lowering the level later never replays it.
  state.lines.push(
    codex(5, "ERROR", { message: "model request failed" }),
    codex(6, "INFO", { message: "new" }, { name: "fs.get_metadata" }),
  );
  const next = await fixture.request(
    "GET",
    target.logsPath(
      `source=gateway&minLevel=info&cursor=${encodeURIComponent(cursorFrom(infoPage))}`,
    ),
  );
  const nextPage = logPage(next);
  assert.deepEqual(shown(nextPage), ["error model request failed"]);
  assert.equal(views().length, 2);
  const after = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(cursorFrom(nextPage))}`),
  );
  assert.deepEqual(shown(logPage(after)), []);

  // The download applies the same floor.
  const download = await fixture.request(
    "GET",
    target.logsPath("source=gateway&minLevel=error&download=true"),
  );
  assert.equal(download.status, 200, download.text);
  assert.deepEqual(
    download.text
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(" ").slice(1, 2)[0]),
    ["UNKNOWN", "ERROR"],
  );

  const reads = driverReads(fixture).length;
  const invalid = await fixture.request("GET", target.logsPath("source=gateway&minLevel=unknown"));
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(driverReads(fixture).length, reads);
});

test("an expired runtime log cursor starts a new audited view with a labelled gap", async (t) => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });

  const first = logPage(await fixture.request("GET", target.logsPath()));
  const expired = cursorFrom(first);
  const views = () => logAuditEvents(fixture.auditSink, VIEW_ACTION);
  assert.equal(views().length, 1);

  // Advance the clock beyond the one-hour lifetime of the cursor issued by the API.
  t.mock.timers.setTime(now + 3_600_001);
  const resumed = logPage(
    await fixture.request(
      "GET",
      target.logsPath(`source=gateway&cursor=${encodeURIComponent(expired)}`),
    ),
  );
  assert.deepEqual(
    resumed.records.map((record) => (record.type === "gap" ? record.reason : record.type)),
    ["cursor_expired", "line"],
  );
  assert.notEqual(cursorFrom(resumed), expired);
  const [original, fresh] = views();
  assert.equal(views().length, 2);
  assert.equal(fresh?.kind, "access");
  const originalDetails = auditDetails(original, "runtimeLogs");
  const freshDetails = auditDetails(fresh, "runtimeLogs");
  assert.ok("viewId" in originalDetails && typeof originalDetails.viewId === "string");
  assert.ok("viewId" in freshDetails && typeof freshDetails.viewId === "string");
  assert.notEqual(freshDetails.viewId, originalDetails.viewId);
});

test("a cursor whose Pod is gone starts a new audited view of the Pod that is read", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  const state = fixture.computeDriver.state;
  state.lines = [runtimeLogLine(1)];
  const replacement = "gateway-replacement-0";
  state.extraPods = [{ name: replacement, uid: "4a1b2c3d-0000-4000-8000-000000000002" }];
  const views = () => logAuditEvents(fixture.auditSink, VIEW_ACTION);

  const first = await fixture.request("GET", target.logsPath(`source=gateway&pod=${replacement}`));
  const firstPage = logPage(first);
  assert.equal(views().length, 1);
  const initialView = auditDetails(views()[0], "runtimeLogs");
  assert.ok("pod" in initialView && "viewId" in initialView);
  assert.equal(initialView.pod, replacement);

  // The cursor's Pod disappears; the next poll falls back to the remaining Pod.
  state.extraPods = [];
  const next = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(cursorFrom(firstPage))}`),
  );
  const nextPage = logPage(next);
  const [gap] = nextPage.records;
  assert.equal(gap?.type, "gap");
  assert.equal(gap.reason, "stream_replaced");
  const primary = fixture.computeDriver.podName({ id: target.revisionId });
  assert.equal(nextPage.stream?.pod, primary);
  assert.equal(views().length, 2, "reading another Pod is a new view");
  const replacementView = auditDetails(views()[1], "runtimeLogs");
  assert.ok("pod" in replacementView && "viewId" in replacementView);
  assert.equal(replacementView.pod, primary);
  assert.notEqual(replacementView.viewId, initialView.viewId);

  // Polls of the new view are not re-audited.
  const again = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(cursorFrom(nextPage))}`),
  );
  assert.equal(again.status, 200, again.text);
  assert.equal(views().length, 2);
});

test("runtime routes reject the Agent draft and unknown revisions without a Driver call", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.calls.length = 0;
  const base = `/namespaces/${target.namespace.id}/agents/${target.agent.id}/deployments`;
  const unknown = target.revisionId.replace(/[0-9a-f]{12}$/, "000000000000");
  // The editable draft is not a revision: its id fails the route contract.
  for (const [revision, status, code] of [
    ["draft", 400, "INVALID_REQUEST"],
    [unknown, 404, "NOT_FOUND"],
  ] as const) {
    for (const path of [
      `${base}/${revision}/runtime`,
      `${base}/${revision}/runtime/logs?source=gateway`,
    ]) {
      const response = await fixture.request("GET", path);
      apiError(response, status, code, path);
    }
  }
  assert.equal(fixture.computeDriver.calls.length, 0);
});

test("log polls describe only the requested source and skip Event lists", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1)];
  fixture.computeDriver.state.events = [
    {
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 1,
      container: null,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];
  const status = await fixture.request("GET", target.runtimePath);
  assert.equal(runtimeDescription(status).pods[0]?.events.length, 1);
  const logs = logPage(await fixture.request("GET", target.logsPath()));
  const poll = await fixture.request(
    "GET",
    target.logsPath(`source=gateway&cursor=${encodeURIComponent(cursorFrom(logs))}`),
  );
  logPage(poll);
  const describes = fixture.computeDriver.calls.filter(
    (call): call is Extract<ComputeCall, { operation: "describe" }> =>
      call.operation === "describe",
  );
  assert.deepEqual(
    describes.map(({ options }) => options),
    [{}, { source: "gateway", events: false }, { source: "gateway", events: false }],
  );
});

test("runtime log failures are fixed, content-free and never read after an audit failure", async () => {
  class UnavailableLogAuditSink extends InMemoryAuditSink {
    failLogAccess = true;

    override async append(event: AuditEvent): Promise<void> {
      if (
        this.failLogAccess &&
        (event.action === VIEW_ACTION || event.action === DOWNLOAD_ACTION)
      ) {
        throw new Error("audit store unavailable");
      }
      await super.append(event);
    }
  }
  const auditSink = new UnavailableLogAuditSink();
  const fixture = await createSecurityFixture({ auditSink });
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [runtimeLogLine(1, "must not be returned")];

  const unaudited = await fixture.request("GET", target.logsPath());
  apiError(unaudited, 503, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
  assert.equal(unaudited.text.includes("must not be returned"), false);
  const undownloaded = await fixture.request(
    "GET",
    target.logsPath("source=gateway&download=true"),
  );
  apiError(undownloaded, 503, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
  assert.equal(undownloaded.text.includes("must not be returned"), false);
  assert.equal(driverReads(fixture).length, 0);
  auditSink.failLogAccess = false;

  const marker = `private-driver-detail-${randomUUID()}`;
  fixture.computeDriver.state.readError = new Error(marker);
  const failed = await fixture.request("GET", target.logsPath());
  apiError(failed, 503, "RUNTIME_LOGS_UNAVAILABLE");
  assert.equal(failed.text.includes(marker), false);
  assert.equal(JSON.stringify(fixture.auditSink.events).includes(marker), false);

  fixture.computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const rbac = await fixture.request("GET", target.logsPath());
  apiError(rbac, 503, "RUNTIME_LOGS_CLUSTER_RBAC");
  fixture.computeDriver.state.readError = undefined;

  fixture.computeDriver.state.describeError = new Error(marker);
  const status = await fixture.request("GET", target.runtimePath);
  assert.equal(status.status, 503);
  assert.equal(status.text.includes(marker), false);
  fixture.computeDriver.state.describeError = undefined;

  // Reject the entire Driver description when it contains an invalid Pod name.
  fixture.computeDriver.state.extraPods = [{ name: "Not A Pod!", uid: "x" }];
  const hostile = await fixture.request("GET", target.runtimePath);
  apiError(hostile, 503, "RUNTIME_LOGS_UNAVAILABLE");
});

// This embedded Agent revision has neither a Sandbox Driver nor a dedicated Agent container.
test("a version without a Sandbox names the log sources and policy suggestions it lacks", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  for (const source of ["sandbox", "agent"]) {
    const refused = await fixture.request("GET", target.logsPath(`source=${source}`));
    const error = apiError(refused, 400, "RUNTIME_LOGS_SOURCE_UNAVAILABLE", source);
    assert.equal(error.message, runtimeLogSourceUnavailable(source));
  }
  const suggestions = await fixture.request(
    "GET",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/revisions/${target.revisionId}/sandbox-policy/networking/recommendations`,
  );
  const error = apiError(suggestions, 409, "RESOURCE_CONFLICT");
  assert.equal(error.message, POLICY_RECOMMENDATIONS_NO_SANDBOX);
});

test("runtime log reads retain allowance through backward and restored wall clocks", async (t) => {
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const initial = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: initial });
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  const first = await fixture.request("GET", target.runtimePath);
  assert.equal(first.status, 200, first.text);

  // A host clock correction must not turn the nine unspent requests into token debt.
  t.mock.timers.setTime(initial - 3_600_000);
  for (let remaining = 9; remaining > 0; remaining -= 1) {
    const response = await fixture.request("GET", target.runtimePath);
    assert.equal(response.status, 200, response.text);
  }
  const exhausted = await fixture.request("GET", target.runtimePath);
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.headers.get("retry-after"), "1");

  // Restoring the wall clock must not mint a second burst: no time has elapsed.
  t.mock.timers.setTime(initial);
  assert.equal((await fixture.request("GET", target.runtimePath)).status, 429);

  // Only elapsed time refills the bucket, independently of wall-clock corrections.
  elapsed += 500;
  t.mock.timers.setTime(initial + 500);
  const refilled = await fixture.request("GET", target.runtimePath);
  assert.equal(refilled.status, 200, refilled.text);
  assert.equal((await fixture.request("GET", target.runtimePath)).status, 429);
});

test("runtime routes answer 501 when the Driver, its logging owner or the operator switch opts out", async () => {
  for (const [label, options] of [
    [
      "driver-owned logging",
      { computeDriver: createRuntimeLogComputeDriver({ runtimeLogging: "driver" }) },
    ],
    [
      "no Driver method",
      { computeDriver: createRuntimeLogComputeDriver({ withoutDescribe: true }) },
    ],
    ["feature disabled", { agentRuntimeLogs: { enabled: false, cursorSecret: "x".repeat(32) } }],
  ] as const) {
    const fixture = await createSecurityFixture(options);
    const target = await fixture.deployAgent();
    for (const path of [target.runtimePath, target.logsPath()]) {
      const response = await fixture.request("GET", path);
      apiError(response, 501, "NOT_IMPLEMENTED", `${label}: ${path}`);
    }
    assert.equal(fixture.computeDriver.calls.length, 0, label);
    if (label === "feature disabled") {
      // The operator switch is checked before authorization (documented), so a
      // principal without grants learns only that the feature is off.
      const outsider = await fixture.createPrincipal("runtime-disabled-outsider", target, []);
      const response = await fixture.request("GET", target.runtimePath, {
        session: outsider.session,
      });
      assert.equal(response.status, 501);
      assert.equal(fixture.computeDriver.calls.length, 0);
    }
  }
});

test("runtime log downloads use the log tier and are audited once per download", async () => {
  const fixture = await createSecurityFixture();
  const target = await fixture.deployAgent();
  fixture.computeDriver.state.lines = [
    runtimeLogLine(1),
    runtimeLogLine(2, '{"level":"warn","message":"slow start","subsystem":"gateway","status":503}'),
  ];
  const operator = await fixture.createPrincipal("download-operator", target, operateGrants);
  const administrator = await fixture.createPrincipal(
    "download-administrator",
    target,
    administerGrants,
  );
  const downloads = () => logAuditEvents(fixture.auditSink, DOWNLOAD_ACTION);
  const views = () => logAuditEvents(fixture.auditSink, VIEW_ACTION);
  fixture.computeDriver.calls.length = 0;

  // Status access is not enough; the denial never reaches the Driver.
  const denied = await fixture.request("GET", target.logsPath("source=gateway&download=true"), {
    session: operator.session,
  });
  assert.equal(denied.status, 403);
  assert.equal(fixture.auditSink.events.at(-1)?.kind, "authorization_denial");
  assert.equal(fixture.auditSink.events.at(-1)?.authorization?.action, "read_logs");
  // The denial names the download, not a view.
  assert.equal(fixture.auditSink.events.at(-1)?.action, "openclaw.agents.runtime_logs.download");
  assert.equal(driverReads(fixture).length, 0);
  const deniedDownloads = downloads().length;

  const path = target.logsPath("source=gateway&tailLines=5&download=true");
  const first = await fixture.request("GET", path, { session: administrator.session });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(first.headers.get("cache-control"), "no-store");
  const pod = fixture.computeDriver.podName({ id: target.revisionId });
  assert.equal(
    first.headers.get("content-disposition"),
    `attachment; filename="${target.agent.id}-${target.revisionId}-gateway-${pod}.log"`,
  );
  const lines = first.text.trimEnd().split("\n");
  const [header] = lines;
  assert.ok(header);
  assert.match(header, new RegExp(`^# agent=${target.agent.id} revision=${target.revisionId}`));
  assert.deepEqual(lines.slice(1), [
    `${runtimeLogLine(1).time} UNKNOWN text gateway output 1`,
    `${runtimeLogLine(2).time} WARN openclaw [gateway] slow start status=503`,
  ]);
  // A download always reads the maximum tail, whatever the caller asked for.
  assert.equal(driverReads(fixture).at(-1)?.tailLines, 1000);

  await fixture.request("GET", path, { session: administrator.session });
  const granted = () => downloads().filter(({ kind }) => kind === "access");
  assert.equal(downloads().length, deniedDownloads + 2);
  assert.equal(granted().length, 2, "every download is audited");
  assert.equal(views().length, 0, "a download is not a view");
  const [audit] = granted();
  assert.equal(audit?.kind, "access");
  assert.equal(audit.actor?.principalId, administrator.principal.id);
  const details = auditDetails(audit, "runtimeLogs");
  assert.ok("tailLines" in details && "pod" in details);
  assert.equal(details.tailLines, 1000);
  assert.equal(details.pod, pod);
  assert.equal(JSON.stringify(audit).includes("slow start"), false);

  // A download is a fresh snapshot and never continues a view.
  const page = await fixture.request("GET", target.logsPath(), { session: administrator.session });
  const readsBefore = driverReads(fixture).length;
  const withCursor = await fixture.request(
    "GET",
    target.logsPath(
      `source=gateway&download=true&cursor=${encodeURIComponent(cursorFrom(logPage(page)))}`,
    ),
    { session: administrator.session },
  );
  const error = apiError(withCursor, 400, "INVALID_REQUEST");
  assert.match(error.message, /\/cursor cannot be combined with \/download/);
  assert.deepEqual(error.details, [{ path: "/cursor", code: "INVALID_VALUE" }]);
  assert.equal(driverReads(fixture).length, readsBefore);
  assert.equal(granted().length, 2);

  // Failures stay JSON errors with fixed text.
  fixture.computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const rbac = await fixture.request("GET", path, { session: administrator.session });
  apiError(rbac, 503, "RUNTIME_LOGS_CLUSTER_RBAC");
});
