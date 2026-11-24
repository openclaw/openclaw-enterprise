import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { Check } from "typebox/value";

import type {
  RuntimeLogRecord,
  RuntimeLogSourceId,
  RuntimeLogStream,
} from "../../packages/contracts/src/index.ts";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { redactFailure } from "../../scripts/ci/failure-redaction.ts";
import {
  assertNativeWorkNotFailed,
  waitForNativeRedeploy,
} from "../helpers/local-first-agent-native-diagnostics.ts";

type DiagnosticOptions = NonNullable<Parameters<typeof assertNativeWorkNotFailed>[2]>;
type ReadDiagnostic = DiagnosticOptions["request"];
type ReadProbePod = NonNullable<DiagnosticOptions["readProbePod"]>;
type WorkStatus = NonNullable<
  Awaited<ReturnType<typeof waitForNativeRedeploy>>["deployment"]
>["status"];

interface Failure {
  code: string;
  message: string;
}

interface ProvisioningWork {
  workId: string;
  url: string;
  phase: "configuration" | "handoff";
  status: WorkStatus;
  attemptCount: number;
  agentId: string | undefined;
  configurationId: string;
  revisionId: string | undefined;
  error: Failure | undefined;
}

interface DeploymentWork {
  namespaceId: string;
  agentId: string;
  deploymentId: string;
  status: WorkStatus;
  progress: { lastAttempt: Failure } | null;
  error: Failure | null;
}

type ProbeFields = NonNullable<Extract<RuntimeLogRecord, { type: "line" }>["fields"]>;

// Gap and echoed-line fixtures supply only the fields read by the diagnostics.
type ProbeRecord =
  | RuntimeLogRecord
  | Pick<Extract<RuntimeLogRecord, { type: "gap" }>, "type" | "reason" | "stream">
  | Pick<Extract<RuntimeLogRecord, { type: "line" }>, "type" | "kind" | "message" | "fields">;

interface ProbePage {
  revisionId: string;
  source: RuntimeLogSourceId;
  stream: RuntimeLogStream;
  records: readonly ProbeRecord[];
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const unavailable = Type.Literal("unavailable");
const observationSchema = Type.Object({
  provisioning: Type.Optional(
    Type.Object({
      status: Type.String(),
      phase: Type.String(),
      attemptCount: Type.Union([Type.Number(), Type.Literal("unknown")]),
      agentIdPresent: Type.Boolean(),
      configurationIdPresent: Type.Boolean(),
      revisionIdPresent: Type.Boolean(),
      errorCode: Type.String(),
    }),
  ),
  deployment: Type.Optional(
    Type.Union([
      unavailable,
      Type.Object({
        status: Type.String(),
        errorCode: Type.String(),
        lastAttemptCode: Type.String(),
      }),
    ]),
  ),
  modelProbe: Type.Optional(
    Type.Union([
      unavailable,
      Type.Object({
        probes: Type.Number(),
        code: Type.String(),
        providerStatus: Type.Union([Type.Number(), Type.String()]),
        providerCode: Type.String(),
        responseHeaderMarker: Type.String(),
        bodyShape: Type.String(),
        providerErrorCode: Type.String(),
        providerErrorType: Type.String(),
      }),
    ]),
  ),
  probePodImage: Type.Optional(
    Type.Union([unavailable, Type.Object({ digest: Type.String(), podUid: Type.String() })]),
  ),
  credentialAttachment: Type.Optional(Type.Literal("not observed")),
});

function reportedFailure(message: string) {
  assert.doesNotMatch(message, /sentinel|ns_|agt_|rev_/i);
  const [, category, json] = message.match(/: (\S+) (\{.*\})$/) ?? [];
  assert.ok(category && json, message);
  const observation: unknown = JSON.parse(json);
  assert.ok(Check(observationSchema, observation), "Invalid native failure observation");

  // The CI result can clip the assertion even after the runtime log was sanitized.
  if (typeof observation.modelProbe === "object") {
    const { message: retained } = redactFailure({ message }, [], repoRoot);
    assert.ok(retained, "Expected CI to retain the native failure message");
    assert.ok(retained.includes(category), retained);
    for (const [key, value] of Object.entries(observation.modelProbe)) {
      assert.ok(retained.includes(`"${key}":${JSON.stringify(value)}`), retained);
    }
    if (typeof observation.probePodImage === "object") {
      assert.ok(retained.includes(JSON.stringify(observation.probePodImage)), retained);
    }
    if (observation.modelProbe.providerStatus === 401) {
      assert.match(retained, /"credentialAttachment":"not observed"/);
    }
  }
  return { category, ...observation };
}

async function assertFailureMessage(operation: Promise<unknown>) {
  let message: string | undefined;
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error, "Expected a native work assertion");
    assert.equal(error.name, "AssertionError");
    message = error.message;
    return true;
  });
  assert.ok(message !== undefined, "Expected a native work assertion message");
  return message;
}

function diagnosticRequests(responses: readonly (DeploymentWork | ProbePage | Error)[]) {
  const calls: Array<{
    method: "GET";
    path: string;
    body: undefined;
    signal: AbortSignal | undefined;
  }> = [];
  const request: ReadDiagnostic = async (method, path, body, signal) => {
    calls.push({ method, path, body, signal });
    const response = responses[calls.length - 1];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { calls, request };
}

export function registerNativeTerminalFailureCases(): void {
  test("native terminal failures report only fixed failure codes", async (t) => {
    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const provisioningPath = `/namespaces/${namespaceId}/agents/provision/work`;
    const deploymentPath = `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`;
    const logPath = `${deploymentPath}/runtime/logs?source=agent&tailLines=1000`;
    const expectation = "Guided native provisioning must succeed";
    const failure = (code: string): Failure => ({ code, message: "private-sentinel" });
    const handoff: ProvisioningWork = {
      workId: "work",
      url: provisioningPath,
      phase: "handoff",
      status: "failed",
      attemptCount: 1,
      agentId,
      configurationId: "private-sentinel",
      revisionId,
      error: failure("RUNTIME_AUTHENTICATION_FAILED"),
    };
    const deployment: DeploymentWork = {
      namespaceId,
      agentId,
      deploymentId: revisionId,
      status: "failed",
      progress: null,
      error: failure("RUNTIME_AUTHENTICATION_FAILED"),
    };
    const probeStream = {
      source: "agent",
      container: "agent",
      pod: "native-agent",
      podUid: randomUUID(),
      restartCount: 0,
    } satisfies RuntimeLogStream;
    const probeLog = (fields: ProbeFields) =>
      sanitizeRuntimeLogChunk({
        stream: probeStream,
        lines: [
          {
            time: null,
            raw: JSON.stringify({ event: "openclaw.model_probe", elapsedMs: 5, ...fields }),
          },
          { time: null, raw: "private-sentinel" },
        ],
        truncated: false,
      }).records;
    const page = (records: readonly ProbeRecord[]): ProbePage => ({
      revisionId,
      source: "agent",
      stream: probeStream,
      records,
    });

    async function observe(
      response: ProvisioningWork | DeploymentWork,
      provisioned: ProvisioningWork,
      responses: readonly (DeploymentWork | ProbePage | Error)[],
      expectedPaths: readonly string[],
      readProbePod?: ReadProbePod,
    ) {
      const { calls, request } = diagnosticRequests(responses);
      const signal = AbortSignal.timeout(30_000);
      const message = await assertFailureMessage(
        assertNativeWorkNotFailed(response, expectation, {
          request,
          namespaceId,
          provisioningPath,
          provisioned,
          readProbePod,
          signal,
        }),
      );
      const diagnosticSignal = calls[0]?.signal;
      assert.deepEqual(
        calls.map(({ path }) => path),
        expectedPaths,
      );
      for (const call of calls) {
        assert.ok(call.signal instanceof AbortSignal && call.signal !== signal);
        assert.equal(call.signal, diagnosticSignal, "all reads must share one diagnostic budget");
        assert.equal(call.method, "GET");
        assert.equal(call.body, undefined);
      }
      return reportedFailure(message);
    }

    await t.test("name the held failure and its provider response", async () => {
      const provider = {
        providerStatus: 401,
        providerCode: "invalid_api_key",
        responseHeaderMarker: "provider-like",
        bodyShape: "json-error-code",
        providerErrorCode: "invalid_api_key",
        providerErrorType: "invalid_request_error",
      };
      const records = probeLog({ code: "AUTHENTICATION_FAILED", ...provider });
      // The provider fields reach the assertion's input through the production sanitizer.
      for (const [name, value] of Object.entries(provider)) {
        assert.equal(
          records[0]?.type === "line" ? records[0].fields?.[name] : undefined,
          value,
          name,
        );
      }
      const observed = await observe(
        handoff,
        handoff,
        [deployment, page(records)],
        [deploymentPath, logPath],
      );
      assert.deepEqual(observed, {
        category: "RUNTIME_AUTHENTICATION_FAILED",
        provisioning: {
          status: "failed",
          phase: "handoff",
          attemptCount: 1,
          agentIdPresent: true,
          configurationIdPresent: true,
          revisionIdPresent: true,
          errorCode: "RUNTIME_AUTHENTICATION_FAILED",
        },
        deployment: {
          status: "failed",
          errorCode: "RUNTIME_AUTHENTICATION_FAILED",
          lastAttemptCode: "none",
        },
        modelProbe: { probes: 1, code: "AUTHENTICATION_FAILED", ...provider },
        credentialAttachment: "not observed",
      });

      const firstRecord = records[0];
      assert.ok(firstRecord, "Expected a sanitized model probe");
      const { pod, podUid } = firstRecord.stream;
      assert.ok(podUid, "Expected the model probe Pod UID");
      const digest = `sha256:${"a".repeat(64)}`;
      const row = `${pod} ${podUid} 0 private-sentinel@${digest}`;
      const imageFor = async (
        result: string | undefined,
        lines: readonly ProbeRecord[] = records,
      ) => {
        const failure = await observe(
          handoff,
          handoff,
          [deployment, page(lines)],
          [deploymentPath, logPath],
          async () => {
            if (result === undefined) {
              throw new Error("private-sentinel");
            }
            return result;
          },
        );
        assert.ok(typeof failure.modelProbe === "object");
        assert.equal(failure.modelProbe.providerStatus, 401);
        return failure.probePodImage;
      };
      assert.deepEqual(await imageFor(row), { digest, podUid });
      for (const other of [
        row.replace(podUid, randomUUID()),
        row.replace(" 0 ", " 1 "),
        `${row}\n${row}`,
        row.slice(0, -1),
        undefined,
      ]) {
        assert.equal(await imageFor(other), "unavailable");
      }
      const gap: ProbeRecord = { type: "gap", reason: "stream_replaced", stream: probeStream };
      assert.equal(await imageFor(row, [gap, ...records]), "unavailable");

      // A later READY keeps the observed 401, and the image can belong only to that 401.
      const ready = probeLog({ code: "READY" });
      const recovered = await observe(
        handoff,
        handoff,
        [deployment, page([...records, ...ready])],
        [deploymentPath, logPath],
        async () => row,
      );
      assert.deepEqual(recovered.modelProbe, {
        probes: 2,
        code: "AUTHENTICATION_FAILED",
        ...provider,
      });
      assert.deepEqual(recovered.probePodImage, { digest, podUid });

      // A success-only, ambiguous, mismatched or mixed-stream page reads no Pod.
      // The diagnostic catch would swallow a throw here, so count reads instead.
      let podReads = 0;
      const noPodRead = async () => {
        podReads += 1;
        return row;
      };
      const otherStream = { ...probeStream, podUid: randomUUID() };
      const mixed = [...records, ...ready.map((record) => ({ ...record, stream: otherStream }))];
      const unattributed: ReadonlyArray<readonly [DeploymentWork, readonly ProbeRecord[]]> = [
        [deployment, ready],
        [deployment, [...records, ...records]],
        [deployment, mixed],
        [
          { ...deployment, error: failure("RUNTIME_MODEL_PROBE_FAILED") },
          probeLog({ code: "AUTHENTICATION_FAILED", ...provider }),
        ],
      ];
      for (const [current, lines] of unattributed) {
        const { probePodImage } = await observe(
          handoff,
          handoff,
          [current, page(lines)],
          [deploymentPath, logPath],
          noPodRead,
        );
        assert.equal(probePodImage, "unavailable");
      }
      assert.equal(podReads, 0);
    });

    await t.test("print other for values outside the fixed vocabularies", async () => {
      const records = probeLog({
        code: "PRIVATE_SENTINEL",
        providerStatus: 200,
        providerCode: "private-sentinel",
        responseHeaderMarker: "private-sentinel-source",
        bodyShape: "private-sentinel-shape",
        providerErrorCode: "private-sentinel-code",
        providerErrorType: "private-sentinel-type",
      });
      const record = records[0];
      assert.ok(record?.type === "line");
      assert.equal(record.fields?.providerCode, "private-sentinel");
      assert.equal(record.fields?.responseHeaderMarker, "private-sentinel-source");
      assert.equal(record.fields?.bodyShape, "private-sentinel-shape");
      assert.equal(record.fields?.providerErrorCode, "private-sentinel-code");
      assert.equal(record.fields?.providerErrorType, "private-sentinel-type");
      const failed = { ...deployment, error: failure("RUNTIME_MODEL_PROBE_FAILED") };
      const observed = await observe(
        failed,
        { ...handoff, status: "succeeded", error: undefined },
        [failed, page([...records, ...probeLog({ providerStatus: "401 private-sentinel" })])],
        [deploymentPath, logPath],
      );
      assert.equal(observed.category, "RUNTIME_MODEL_PROBE_FAILED");
      assert.ok(observed.provisioning);
      assert.equal(observed.provisioning.errorCode, "none");
      assert.deepEqual(observed.modelProbe, {
        probes: 2,
        code: "none",
        providerStatus: "other",
        providerCode: "none",
        responseHeaderMarker: "absent",
        bodyShape: "absent",
        providerErrorCode: "absent",
        providerErrorType: "absent",
      });
      const single = await observe(
        failed,
        handoff,
        [failed, page(records)],
        [deploymentPath, logPath],
      );
      assert.deepEqual(single.modelProbe, {
        probes: 1,
        code: "other",
        providerStatus: "other",
        providerCode: "other",
        responseHeaderMarker: "other",
        bodyShape: "other",
        providerErrorCode: "other",
        providerErrorType: "other",
      });
      for (const providerStatus of [399, 401.5, 600]) {
        const statusPage = page(probeLog({ providerStatus }));
        const { modelProbe } = await observe(
          failed,
          handoff,
          [failed, statusPage],
          [deploymentPath, logPath],
        );
        assert.ok(typeof modelProbe === "object");
        assert.equal(modelProbe.providerStatus, "other");
      }
    });

    await t.test("read no provider response without a held model-check failure", async () => {
      const unknown = { ...handoff, error: failure("RUNTIME_PRIVATE_SENTINEL") };
      const pending: DeploymentWork = {
        ...deployment,
        status: "running",
        error: null,
        progress: { lastAttempt: { code: "PRIVATE_SENTINEL", message: "private-sentinel" } },
      };
      const observed = await observe(unknown, unknown, [pending], [deploymentPath]);
      assert.equal(observed.category, "unrecognized");
      assert.ok(observed.provisioning);
      assert.equal(observed.provisioning.errorCode, "unrecognized");
      assert.deepEqual(observed.deployment, {
        status: "running",
        errorCode: "none",
        lastAttemptCode: "unknown",
      });
      assert.equal(observed.modelProbe, undefined);
      const starved = { ...deployment, error: failure("RUNTIME_CPU_STARVED") };
      const running: DeploymentWork = { ...deployment, status: "running" };
      for (const current of [starved, running]) {
        assert.equal(
          (await observe(handoff, handoff, [current], [deploymentPath])).modelProbe,
          undefined,
        );
      }
    });

    await t.test("bind every read to the exact revision", async () => {
      const wrongPage = { ...page(probeLog({ providerStatus: 401 })), revisionId: "another" };
      assert.equal(
        (await observe(handoff, handoff, [deployment, wrongPage], [deploymentPath, logPath]))
          .modelProbe,
        "unavailable",
      );
      const gatewayPage: ProbePage = {
        ...page(probeLog({ providerStatus: 401 })),
        source: "gateway",
      };
      assert.equal(
        (await observe(handoff, handoff, [deployment, gatewayPage], [deploymentPath, logPath]))
          .modelProbe,
        "unavailable",
      );
      // Runtime output that merely names the event is not the wrapper's model check.
      const echoed = {
        type: "line",
        kind: "openclaw",
        message: "openclaw.model_probe",
      } satisfies ProbeRecord;
      const unechoed = await observe(
        handoff,
        handoff,
        [deployment, page([{ ...echoed, fields: { providerStatus: 401 } }])],
        [deploymentPath, logPath],
      );
      assert.deepEqual(unechoed.modelProbe, {
        probes: 0,
        code: "none",
        providerStatus: "none",
        providerCode: "none",
        responseHeaderMarker: "absent",
        bodyShape: "absent",
        providerErrorCode: "absent",
        providerErrorType: "absent",
      });
      for (const other of [
        { ...deployment, deploymentId: "another-revision" },
        { ...deployment, agentId: `agt_${randomUUID()}` },
        { ...deployment, namespaceId: `ns_${randomUUID()}` },
      ]) {
        assert.equal(
          (await observe(handoff, handoff, [other], [deploymentPath])).deployment,
          "unavailable",
        );
      }
      const early: ProvisioningWork = {
        ...handoff,
        phase: "configuration",
        agentId: undefined,
        revisionId: undefined,
      };
      const observed = await observe(early, early, [], []);
      assert.equal(observed.deployment, undefined);
      assert.ok(observed.provisioning);
      assert.equal(observed.provisioning.phase, "configuration");
      const unbound = { ...handoff, revisionId: "private-sentinel" };
      assert.equal((await observe(unbound, unbound, [], [])).deployment, "unavailable");

      // A failed optional read preserves the original assertion and redacts the read error.
      const failedRead = await observe(
        handoff,
        handoff,
        [deployment, new Error("private-sentinel")],
        [deploymentPath, logPath],
      );
      assert.equal(failedRead.category, "RUNTIME_AUTHENTICATION_FAILED");
      assert.equal(failedRead.modelProbe, "unavailable");

      // A read that settles during cancellation cannot supply evidence for the held failure.
      const controller = new AbortController();
      const cancelledReads: string[] = [];
      await assert.rejects(
        assertNativeWorkNotFailed(handoff, expectation, {
          namespaceId,
          provisioningPath,
          provisioned: handoff,
          signal: controller.signal,
          request: async (_method, path) => {
            cancelledReads.push(path);
            controller.abort(new Error("private-sentinel"));
            return deployment;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error, "Expected a native work assertion");
          const held = reportedFailure(error.message);
          assert.equal(held.category, "RUNTIME_AUTHENTICATION_FAILED");
          assert.equal(held.deployment, "unavailable");
          return true;
        },
      );
      assert.deepEqual(cancelledReads, [deploymentPath]);
    });

    await t.test("pass work that has not failed", async () => {
      for (const status of ["queued", "running", "succeeded"] as const) {
        await assertNativeWorkNotFailed({ status }, expectation);
      }
      await assert.rejects(assertNativeWorkNotFailed({ status: "failed" }, expectation), {
        name: "AssertionError",
        message: /^Guided native provisioning must succeed: unrecognized \{"provisioning":/,
      });
    });

    await t.test("name a failed redeploy's code and model check without peer text", async (t) => {
      const replacementId = `rev_${randomUUID()}`;
      const agentPath = `/namespaces/${namespaceId}/agents/${agentId}`;
      const replacementPath = `${agentPath}/deployments/${replacementId}`;
      const replacementLogPath = `${replacementPath}/runtime/logs?source=agent&tailLines=1000`;
      const failed = { ...deployment, deploymentId: replacementId };
      const replacementPage = (records: readonly ProbeRecord[]) => ({
        ...page(records),
        revisionId: replacementId,
      });
      async function redeploy(
        responses: readonly (DeploymentWork | ProbePage)[],
        expectedPaths: readonly string[],
      ) {
        const { calls, request } = diagnosticRequests(responses);
        const signal = AbortSignal.timeout(30_000);
        const message = await assertFailureMessage(
          waitForNativeRedeploy({
            request,
            namespaceId,
            agentId,
            revisionId: replacementId,
            signal,
          }),
        );
        assert.deepEqual(
          calls.map(({ path }) => path),
          expectedPaths,
        );
        for (const call of calls.slice(1)) {
          assert.ok(call.signal instanceof AbortSignal && call.signal !== signal);
        }
        return reportedFailure(message);
      }

      const provider = { providerStatus: 429, providerCode: "rate_limit_exceeded" };
      const records = probeLog({ code: "MODEL_PROBE_FAILED", ...provider });
      const probeFailed = { ...failed, error: failure("RUNTIME_MODEL_PROBE_FAILED") };
      assert.deepEqual(
        await redeploy(
          [probeFailed, replacementPage(records)],
          [replacementPath, replacementLogPath],
        ),
        {
          category: "RUNTIME_MODEL_PROBE_FAILED",
          deployment: {
            status: "failed",
            errorCode: "RUNTIME_MODEL_PROBE_FAILED",
            lastAttemptCode: "none",
          },
          // The full probe's provider summary names no responder.
          modelProbe: {
            probes: 1,
            code: "MODEL_PROBE_FAILED",
            ...provider,
            responseHeaderMarker: "absent",
            bodyShape: "absent",
            providerErrorCode: "absent",
            providerErrorType: "absent",
          },
        },
      );
      // Codes outside the closed vocabulary print as unrecognized, with no log read.
      const unknown = {
        ...failed,
        error: failure("RUNTIME_PRIVATE_SENTINEL"),
        progress: { lastAttempt: { code: "PRIVATE_SENTINEL", message: "private-sentinel" } },
      };
      assert.deepEqual(await redeploy([unknown], [replacementPath]), {
        category: "unrecognized",
        deployment: { status: "failed", errorCode: "unrecognized", lastAttemptCode: "unknown" },
      });
      // A different binding is rejected before status, diagnostics or an agent read.
      const otherBinding = {
        namespaceId: `ns_${randomUUID()}`,
        agentId: `agt_${randomUUID()}`,
        deploymentId: revisionId,
      };
      for (const [field, otherId] of Object.entries(otherBinding)) {
        for (const status of ["failed", "succeeded", "queued", "running"] as const) {
          const mismatched: DeploymentWork = {
            ...failed,
            [field]: otherId,
            status,
            error: status === "failed" ? failed.error : null,
          };
          const calls: string[] = [];
          await assert.rejects(
            waitForNativeRedeploy({
              request: async (_method, path) => {
                calls.push(path);
                // Even an active replacement cannot legitimize the mismatched record.
                return calls.length === 1 ? mismatched : { activeRevisionId: replacementId };
              },
              namespaceId,
              agentId,
              revisionId: replacementId,
              signal: AbortSignal.timeout(30_000),
              timeoutMs: 100,
              pollMs: 1,
            }),
            {
              name: "AssertionError",
              message: "The native redeploy returned a mismatched deployment binding",
            },
            `${field} mismatch in a ${status} deployment must stop the poll`,
          );
          assert.deepEqual(calls, [replacementPath]);
        }
      }
      // Only the replacement revision's own log page is reported.
      const firstPage = page(probeLog({ providerStatus: 401 }));
      const stale = await redeploy([failed, firstPage], [replacementPath, replacementLogPath]);
      assert.equal(stale.modelProbe, "unavailable");

      // A redeploy returns once it succeeded and is active, without diagnostic reads.
      const ready: DeploymentWork = { ...failed, status: "succeeded", error: null };
      const currentAgent = { id: agentId, namespaceId, activeRevisionId: revisionId };
      const replacementAgent = { ...currentAgent, activeRevisionId: replacementId };
      const calls: string[] = [];
      const responses: readonly (DeploymentWork | typeof currentAgent)[] = [
        { ...ready, status: "running" },
        currentAgent,
        ready,
        currentAgent,
        ready,
        replacementAgent,
      ];
      const active = await waitForNativeRedeploy({
        request: async (_method, path) => {
          calls.push(path);
          return responses[calls.length - 1];
        },
        namespaceId,
        agentId,
        revisionId: replacementId,
        signal: AbortSignal.timeout(30_000),
        pollMs: 1,
      });
      assert.deepEqual(active, { deployment: ready, agent: replacementAgent });
      assert.deepEqual(calls, [
        replacementPath,
        agentPath,
        replacementPath,
        agentPath,
        replacementPath,
        agentPath,
      ]);

      for (const other of [
        { id: otherBinding.agentId },
        { namespaceId: otherBinding.namespaceId },
      ]) {
        await assert.rejects(
          waitForNativeRedeploy({
            request: async (_method, path) =>
              path === replacementPath ? ready : { ...replacementAgent, ...other },
            namespaceId,
            agentId,
            revisionId: replacementId,
            signal: AbortSignal.timeout(30_000),
          }),
          /mismatched Agent binding/,
        );
      }

      // An Agent read that begins in time but settles after the deadline cannot prove readiness.
      t.mock.timers.enable({ apis: ["Date"] });
      const lateCalls: string[] = [];
      const late = await waitForNativeRedeploy({
        request: async (_method, path) => {
          lateCalls.push(path);
          if (path === agentPath) {
            t.mock.timers.tick(51);
            return replacementAgent;
          }
          return ready;
        },
        namespaceId,
        agentId,
        revisionId: replacementId,
        signal: AbortSignal.timeout(30_000),
        timeoutMs: 50,
        pollMs: 1,
      });
      assert.deepEqual(lateCalls, [replacementPath, agentPath]);
      assert.deepEqual(late, { deployment: undefined, agent: undefined });
    });
  });
}
