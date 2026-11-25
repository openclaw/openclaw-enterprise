import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { protectedText } from "./qa-secrets.ts";
import { waitFor } from "./qa-wait.ts";

type Revision = { id: string };
type DeploymentAgent = {
  id: string;
  namespaceId: string;
  preset: string;
  stopped?: boolean;
  revision?: Revision;
  deployRequestId?: string | undefined;
};

// Only the OpenClaw authentication failure diagnostic needs a Kubernetes command.
interface DeploymentFixture {
  api(
    method: "GET" | "POST",
    path: string,
    body?: object,
    options?: { onMeta(meta: unknown): void },
  ): Promise<unknown>;
  record(name: string, value: unknown): Promise<unknown>;
  kubectl?(...args: string[]): Promise<string>;
}
interface DeploymentOptions {
  timeout?: number;
  interval?: number;
  now?: () => number;
  harnessOverrides?: Record<string, unknown>;
}

function record(value: unknown, label: string) {
  const result = asRecord(value);
  assert.ok(result, `expected ${label} to be an object`);
  return result;
}

function list(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `expected ${label} to be an array`);
  return value;
}

function assertRevision(value: unknown): asserts value is Revision {
  assert.ok(typeof asRecord(value)?.id === "string", "expected deployed revision ID");
}

async function recordAuthenticationDiagnostic(
  f: DeploymentFixture,
  agentId: string,
  revisionId: string,
) {
  // A failed deployment holds its Pod for diagnosis. Check delivery and
  // provider rejection there without exporting the Pod's credential.
  try {
    assert.ok(f.kubectl, "authentication diagnostic requires Kubernetes access");
    const data: unknown = JSON.parse(
      await f.kubectl(
        "get",
        "pods",
        "-A",
        "-l",
        `openclaw.dev/agent=${agentId},openclaw.dev/revision=${revisionId},openclaw.dev/workload-role=gateway`,
        "-o",
        "json",
      ),
    );
    const pods = list(record(data, "PodList").items, "PodList items")
      .map((pod) => record(record(pod, "Pod").metadata, "Pod metadata"))
      .filter((metadata) => !metadata.deletionTimestamp);
    assert.equal(pods.length, 1);
    const [metadata] = pods;
    assert.ok(
      metadata && typeof metadata.namespace === "string" && typeof metadata.name === "string",
      "expected diagnostic Pod identity",
    );
    const expected = createHash("sha256")
      .update(await protectedText(process.env.OCC_TEST_QA_OPENAI_KEY_FILE, "model credential"))
      .digest("hex");
    const script = `
            const crypto = require('node:crypto');
            const key = process.env[process.env.OPENCLAW_HARNESS_CREDENTIAL_ENV] ?? '';
            const matchesInput = crypto.createHash('sha256').update(key).digest('hex') === process.argv[1];
            const allowed = new Set(['invalid_api_key', 'insufficient_quota', 'model_not_found', 'unsupported_country_region_territory', 'account_deactivated', 'permission_denied', 'missing_required_parameter', 'invalid_organization', 'project_not_found']);
            fetch('https://api.openai.com/v1/responses', {
              method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
              body: '{}', signal: AbortSignal.timeout(15000),
            }).then(async (response) => {
              const body = await response.json().catch(() => ({}));
              const code = body.error?.code;
              console.log(JSON.stringify({ credentialPresent: key.length > 0, matchesInput, httpStatus: response.status, code: allowed.has(code) ? code : 'other' }));
            }, () => console.log(JSON.stringify({ credentialPresent: key.length > 0, matchesInput, networkFailure: true })));
          `;
    const diagnostic: unknown = JSON.parse(
      await f.kubectl(
        "-n",
        metadata.namespace,
        "exec",
        metadata.name,
        "-c",
        "gateway",
        "--",
        "node",
        "-e",
        script,
        expected,
      ),
    );
    await f.record(`${agentId}-${revisionId}-authentication`, diagnostic);
  } catch {
    await f.record(`${agentId}-${revisionId}-authentication`, {
      unavailable: true,
    });
  }
}

// Log lookup is best effort: never replace the deployment refusal with a log-read failure.
async function modelProbeDetail(
  f: DeploymentFixture,
  base: string,
  revisionId: string,
  component: string,
) {
  try {
    const logs = await f.api(
      "GET",
      base + `/deployments/${revisionId}/runtime/logs?source=${component}&minLevel=error`,
    );
    const entries = list(record(logs, "log page").records, "log records");
    const entry = asRecord(
      entries.findLast((item) => {
        const { message } = record(item, "runtime log record");
        if (message === null || message === undefined) {
          return false;
        }
        assert.ok(typeof message === "string", "expected runtime log message");
        return message.endsWith(".model_probe");
      }),
    );
    return entry ? ` probe log: ${JSON.stringify(entry.fields ?? {})}` : "";
  } catch {
    return " probe log: unavailable";
  }
}

// Deploys a QA Agent's current configuration and waits for the deployment to succeed.
export async function deployQaAgentAndWait(
  f: DeploymentFixture,
  agent: DeploymentAgent,
  {
    timeout = 600_000,
    interval = 1000,
    now = () => Date.now(),
    harnessOverrides,
  }: DeploymentOptions = {},
) {
  const base = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  agent.stopped = false;
  const revision = await f.api(
    "POST",
    base + "/deploy",
    harnessOverrides === undefined ? undefined : { harnessOverrides },
    {
      onMeta(meta) {
        const { requestId } = record(meta, "deployment metadata");
        assert.ok(
          requestId === undefined || typeof requestId === "string",
          "expected deployment request ID",
        );
        agent.deployRequestId = requestId;
      },
    },
  );
  assertRevision(revision);
  agent.revision = revision;
  // A timeout names the deployment's last status and attempt, and how long it had that status
  // (finding 2106: six cells timed out at 600 s with no status).
  let last: Record<string, unknown> | undefined;
  let statusSince = now();
  const observeStatus = (value: Record<string, unknown>) => {
    if (value.status !== last?.status) {
      statusSince = now();
    }
    last = value;
  };
  const status = await waitFor(
    "Agent deployment",
    async () => {
      const value = record(
        await f.api("GET", base + `/deployments/${revision.id}`),
        "deployment status",
      );
      assert.ok(typeof value.status === "string", "expected deployment status");
      const error = asRecord(value.error);
      observeStatus(value);
      if (error?.code === "RUNTIME_AUTHENTICATION_FAILED" && agent.preset === "OpenClaw") {
        await recordAuthenticationDiagnostic(f, agent.id, revision.id);
      }
      // A failed startup model check names the provider's HTTP status and known
      // error code in its sanitized probe log record; CI shows them with the error.
      let probe = "";
      const component = asRecord(asRecord(error?.data)?.runtimeFailure)?.component;
      if (
        error?.code === "RUNTIME_MODEL_PROBE_FAILED" &&
        typeof component === "string" &&
        component
      ) {
        probe = await modelProbeDetail(f, base, revision.id, component);
      }
      assert.ok(
        !["failed", "cancelled"].includes(value.status),
        `Agent deployment ${value.status}: ${JSON.stringify(value.error)}${probe}`,
      );
      return value.status === "succeeded" && value;
    },
    timeout,
    {
      describe: () => describeDeploymentObservation(last, now() - statusSince),
      interval,
      now,
    },
  ).catch(async (error: unknown) => {
    // The deployment's Pods, when it has any, show whether it waited on scheduling, an image
    // or a container that does not start.
    if (error instanceof Error && /^Timed out: /.test(error.message)) {
      try {
        const runtime = await f.api("GET", base + `/deployments/${revision.id}/runtime`);
        error.message += `; runtime: ${describeDeploymentRuntime(runtime)}`;
      } catch (runtimeError) {
        const detail = asRecord(runtimeError)?.message ?? runtimeError;
        const message = typeof detail === "string" ? detail : "unknown error";
        error.message += `; runtime unavailable (${message})`;
      }
    }
    throw error;
  });
  await f.record(`${agent.preset}-${agent.id}-${revision.id}-deployment`, {
    agentId: agent.id,
    revisionId: revision.id,
    status,
  });
  return { revision, status };
}

// The last deployment observation, without native text: the API returns allowlisted codes and
// messages only.
export function describeDeploymentObservation(
  value: Record<string, unknown> | undefined,
  statusForMs: number,
) {
  if (!value) {
    return "none";
  }
  const progress = asRecord(value.progress);
  return JSON.stringify({
    status: value.status,
    statusForMs,
    lastAttempt: progress?.lastAttempt ?? null,
    nextAttemptAt: progress?.nextAttemptAt ?? null,
    error: asRecord(value.error)?.code ?? null,
  });
}

// Runtime text reaches the API as Kubernetes sent it, and OCC may shorten it there. QA
// redaction replaces whole registered values, so a shortened string could keep part of one.
// The timeout therefore names only familiar Kubernetes words and says "other" for the rest;
// event messages are left out.
const familiarPodPhases = new Set(["Pending", "Running", "Succeeded", "Failed", "Unknown"]);
const familiarContainerReasons = new Set([
  "ContainerCreating",
  "PodInitializing",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "PreStartHookError",
  "PostStartHookError",
  "StartError",
  "ContainerCannotRun",
  "ContainerStatusUnknown",
  "Completed",
  "Error",
  "OOMKilled",
  "DeadlineExceeded",
]);
const familiarEventReasons = new Set([
  "FailedScheduling",
  "FailedMount",
  "FailedAttachVolume",
  "FailedCreatePodSandBox",
  "FailedKillPod",
  "FailedPreStopHook",
  "FailedPostStartHook",
  "FailedSync",
  "FailedCreate",
  "Failed",
  "BackOff",
  "Unhealthy",
  "ProbeWarning",
  "InspectFailed",
  "ErrImageNeverPull",
  "NetworkNotReady",
  "Evicted",
  "NodeNotReady",
  "OutOfmemory",
  "OutOfcpu",
]);

function familiar(words: ReadonlySet<string>, value: unknown) {
  if (value === null || value === undefined) {
    return value;
  }
  return typeof value === "string" && words.has(value) ? value : "other";
}

export function describeDeploymentRuntime(value: unknown) {
  const runtime = asRecord(value);
  const pods = list(runtime?.pods ?? [], "runtime Pods")
    .slice(0, 4)
    .map((item) => {
      const pod = record(item, "runtime Pod");
      return {
        role: pod.role,
        phase: familiar(familiarPodPhases, pod.phase),
        ready: pod.ready,
        containers: list(pod.containers ?? [], "runtime containers").map((item) => {
          const { name, state, reason, restartCount } = record(item, "runtime container");
          return { name, state, reason: familiar(familiarContainerReasons, reason), restartCount };
        }),
        // The API lists events newest first. Never copy event messages into the timeout.
        warnings: list(pod.events ?? [], "Pod events")
          .map((event) => record(event, "Pod event"))
          .filter(({ type }) => type === "Warning")
          .slice(0, 3)
          .map(({ reason, count }) => ({ reason: familiar(familiarEventReasons, reason), count })),
      };
    });
  return JSON.stringify({ pods, ...(runtime?.harness ? { harness: runtime.harness } : {}) });
}
