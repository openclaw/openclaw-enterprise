import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  FirstAgentModelError,
  gatewayProbeCommand,
  verifyFirstAgentModel,
} from "../../scripts/first-agent-model.mjs";
import { FixtureCommandTimeoutError } from "../fixtures/repository-credentials/process.mjs";
import { ConversationReplyError, createNativePluginAssertions } from "./plugin-driver-real.mjs";

const conversationStages = [
  "execution identity",
  "target discovery",
  "gateway identity",
  "model turn",
  "persisted reply",
] as const;
type ConversationStage = (typeof conversationStages)[number];
type GatewayFailureObservation =
  | "workspace_skill_discovery_failure_observed"
  | "unclassified"
  | "observation_unavailable"
  | "ambiguous";
const logByteLimit = 65_536;

function classifyGatewayFailure(
  logs: string,
  interval: { start: number; end: number },
): GatewayFailureObservation {
  // kubectl can return a truncated prefix at its byte limit. Never infer uniqueness from it.
  if (Buffer.byteLength(logs) >= logByteLimit || (logs && !logs.endsWith("\n"))) {
    return "observation_unavailable";
  }
  const failures: string[] = [];
  for (const line of logs.split("\n").filter(Boolean)) {
    const record = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) (.*)$/.exec(line);
    if (!record || !Number.isFinite(Date.parse(record[1]!))) {
      return "observation_unavailable";
    }
    // Admitted Gateways use JSON console logs. A message quoting a subsystem prefix
    // is not that subsystem's warning. Producer time selects records; capture can lag.
    if (!record[2]!.startsWith("{")) {
      continue;
    }
    const value = JSON.parse(record[2]!);
    if (
      value?.subsystem !== "openai-compat" ||
      value.level !== "warn" ||
      typeof value.message !== "string" ||
      !value.message.startsWith("chat completion failed: ")
    ) {
      continue;
    }
    if (
      typeof value.time !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(value.time) ||
      !Number.isFinite(Date.parse(value.time))
    ) {
      return "observation_unavailable";
    }
    const produced = Date.parse(value.time);
    if (produced >= interval.start && produced <= interval.end) {
      failures.push(value.message);
    }
  }
  if (failures.length > 1) {
    return "ambiguous";
  }
  return failures[0] ===
    "chat completion failed: WorkspaceAccessUnavailableError: Remote workspace skill discovery failed"
    ? "workspace_skill_discovery_failure_observed"
    : "unclassified";
}

class FiniteGitConversationError extends Error {
  readonly stage: ConversationStage;
  readonly detail: string;

  constructor(stage: ConversationStage, error?: unknown, observation?: GatewayFailureObservation) {
    let detail: string = stage;
    if (stage === "model turn" && error instanceof FirstAgentModelError) {
      detail += `; probe=${error.code}`;
      if (error.status !== undefined) {
        detail += `; HTTP=${error.status}`;
      }
    }
    if (stage === "persisted reply" && error instanceof ConversationReplyError) {
      detail += `; read=${error.reason}`;
    }
    if (observation !== undefined) {
      detail += `; gateway=${observation}`;
    }
    super(`Finite Git conversation verification failed (${detail}).`);
    this.stage = stage;
    this.detail = detail;
  }
}

export function finiteGitConversationFailureStage(error: unknown) {
  return error instanceof FiniteGitConversationError && conversationStages.includes(error.stage)
    ? error.detail
    : undefined;
}

type Agent = { id: string; namespaceId: string; revision: { id: string } };
type Tuple = { sessionId: string; threadId: string; userSeq: number; assistantSeq: number };
type Options = { input?: string; timeout?: number };
type Pod = {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec?: { containers?: { name: string }[]; volumes?: { configMap?: { name?: string } }[] };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string }[];
    containerStatuses?: {
      name: string;
      containerID: string;
      imageID: string;
      restartCount: number;
      state?: { running?: { startedAt?: string } };
    }[];
  };
};

export function createFiniteGitConversation({
  kube,
  agent,
  signal,
  readExecution,
  originalIdentity,
}: {
  kube: (args: string[], options?: Options) => Promise<string>;
  agent: Agent;
  signal: AbortSignal;
  readExecution: () => Promise<{ identity: unknown }>;
  originalIdentity: unknown;
}) {
  const selected = structuredClone(agent);
  const sessionKey = `agent:main:git-withdrawal-${randomUUID()}`;
  const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);
  const revisionMap = `gateway-${hash(selected.id)}-rev-${hash(selected.revision.id)}`;
  let pinned: ReturnType<typeof identity> | undefined;
  let deadline = 0;
  let stage: ConversationStage = "execution identity";
  function fail(error?: unknown): never {
    throw new FiniteGitConversationError(stage, error);
  }
  function remaining() {
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      if (stage === "persisted reply") {
        throw new ConversationReplyError("timeout");
      }
      fail();
    }
    return Math.max(1, deadline - Date.now());
  }
  async function command(args: string[], options: Options = {}) {
    try {
      const output = await kube(args, {
        ...options,
        timeout: Math.min(options.timeout ?? 15_000, remaining()),
      });
      remaining();
      return output;
    } catch (error) {
      if (stage === "persisted reply") {
        if (error instanceof ConversationReplyError) {
          throw error;
        }
        throw new ConversationReplyError(
          error instanceof FixtureCommandTimeoutError ? "timeout" : "command",
        );
      }
      // Never expose command arguments, output, or a raw transport error as a cause.
      return fail();
    }
  }
  function validDiscoveryPod(value: unknown): value is Pod {
    const record = (field: unknown): field is Record<string, unknown> =>
      typeof field === "object" && field !== null && !Array.isArray(field);
    const optionalString = (field: unknown) => field === undefined || typeof field === "string";
    if (
      !record(value) ||
      !record(value.metadata) ||
      typeof value.metadata.name !== "string" ||
      !value.metadata.name ||
      !optionalString(value.metadata.deletionTimestamp)
    ) {
      return false;
    }
    const { spec, status } = value;
    // Missing readiness is pending; malformed discovery data must not become a retry.
    return (
      (spec === undefined ||
        (record(spec) &&
          (spec.volumes === undefined ||
            (Array.isArray(spec.volumes) &&
              spec.volumes.every(
                (volume: unknown) =>
                  record(volume) &&
                  (volume.configMap === undefined ||
                    (record(volume.configMap) && optionalString(volume.configMap.name))),
              ))))) &&
      (status === undefined ||
        (record(status) &&
          optionalString(status.phase) &&
          (status.conditions === undefined ||
            (Array.isArray(status.conditions) &&
              status.conditions.every(
                (condition: unknown) =>
                  record(condition) &&
                  optionalString(condition.type) &&
                  optionalString(condition.status),
              )))))
    );
  }
  function eligible(pod: Pod) {
    return Boolean(
      pod.metadata?.name &&
      !pod.metadata.deletionTimestamp &&
      pod.spec?.volumes?.some((v) => v.configMap?.name === revisionMap) &&
      pod.status?.phase === "Running" &&
      pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
  }
  function identity(pod: Pod, namespace: string) {
    const meta = pod.metadata;
    const containers = pod.status?.containerStatuses?.filter((c) => c.name === "gateway");
    const container = containers?.[0];
    const startedAt = container?.state?.running?.startedAt;
    if (
      !eligible(pod) ||
      !meta?.name ||
      !meta.uid ||
      meta.namespace !== namespace ||
      meta.labels?.["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
      meta.labels?.["openclaw.dev/workload-role"] !== "gateway" ||
      meta.labels?.["openclaw.dev/namespace"] !== selected.namespaceId ||
      meta.labels?.["openclaw.dev/agent"] !== selected.id ||
      pod.spec?.containers?.filter((c) => c.name === "gateway").length !== 1 ||
      containers?.length !== 1 ||
      !container?.containerID ||
      !container.imageID ||
      !startedAt ||
      !Number.isSafeInteger(container.restartCount) ||
      container.restartCount < 0
    ) {
      return fail();
    }
    return {
      namespace,
      name: meta.name,
      uid: meta.uid,
      containerId: container.containerID,
      imageId: container.imageID,
      startedAt,
      restartCount: container.restartCount,
    };
  }
  async function guard(target: ReturnType<typeof identity>) {
    const previousStage = stage;
    stage = "gateway identity";
    const pod = JSON.parse(
      await command(["get", "pod", target.name, "--namespace", target.namespace, "-o", "json"]),
    ) as Pod;
    const current = identity(pod, target.namespace);
    if (!isDeepStrictEqual(current, target) || (pinned && !isDeepStrictEqual(current, pinned))) {
      fail();
    }
    pinned = current;
    stage = previousStage;
  }
  async function observeGatewayFailure(
    error: FirstAgentModelError,
  ): Promise<GatewayFailureObservation> {
    const target = pinned;
    const interval = error.requestInterval;
    if (!target || !interval) {
      return "observation_unavailable";
    }
    const previousDeadline = deadline;
    const previousStage = stage;
    deadline = Math.min(deadline, Date.now() + 5_000);
    try {
      await guard(target);
      const logs = await command([
        "logs",
        target.name,
        "--namespace",
        target.namespace,
        "-c",
        "gateway",
        "--timestamps=true",
        "--tail=-1",
        `--limit-bytes=${logByteLimit}`,
        `--since-time=${new Date(interval.start).toISOString()}`,
      ]);
      await guard(target);
      return classifyGatewayFailure(logs, interval);
    } catch {
      // Preserve the original model failure; raw logs and subprocess errors stay in memory.
      return "observation_unavailable";
    } finally {
      deadline = previousDeadline;
      stage = previousStage;
    }
  }
  async function exec(target: ReturnType<typeof identity>, args: string[], options?: Options) {
    await guard(target);
    const output = await command(args, options);
    await guard(target);
    return output;
  }
  const reader = createNativePluginAssertions({
    proofMode: "codex",
    gatewayUrl: undefined,
    execCodex: undefined,
    waitFor: undefined,
    readRuntimeLogs: undefined,
    recordRuntimeLogs: undefined,
    execGateway: async (requested: Agent, argv: string[]) => {
      if (!isDeepStrictEqual(requested, selected) || !pinned) {
        return fail();
      }
      return {
        label: "finite-git-gateway",
        stdout: await exec(pinned, [
          "exec",
          "--namespace",
          pinned.namespace,
          pinned.name,
          "-c",
          "gateway",
          "--",
          ...argv,
        ]),
      };
    },
  });
  async function checkExecution() {
    stage = "execution identity";
    remaining();
    if (!isDeepStrictEqual((await readExecution()).identity, originalIdentity)) {
      fail();
    }
    remaining();
  }
  async function turn(key: string, previous: Tuple | undefined, timeout: number) {
    deadline = Date.now() + timeout;
    const stopped = new AbortController();
    try {
      await checkExecution();
      let observed: ReturnType<typeof identity> | undefined;
      stage = "target discovery";
      const proof = await verifyFirstAgentModel(
        async (...arguments_: (string | Options)[]) => {
          try {
            const options = arguments_.pop();
            if (!options || typeof options !== "object") {
              return fail();
            }
            const args = arguments_.filter((value): value is string => typeof value === "string");
            if (args.length !== arguments_.length) {
              return fail();
            }
            if (args[0] === "get" && ["namespaces", "pods"].includes(args[1] ?? "")) {
              // Forward the verifier's live discovery. Only this revision's eligible candidates
              // matter; old-revision Pods can coexist without making the current target ambiguous.
              const output = await command(args, options);
              if (args[1] === "pods") {
                const namespace = args[args.indexOf("--namespace") + 1];
                const pods: unknown = JSON.parse(output).items;
                if (!namespace || !Array.isArray(pods) || !pods.every(validDiscoveryPod)) {
                  return fail();
                }
                const matches = pods.filter(eligible);
                if (matches.length > 1) {
                  return fail();
                }
                // Absence is normal startup readiness, not an invalid target.
                observed = matches[0] ? identity(matches[0], namespace) : undefined;
              }
              return output;
            }
            if (
              !observed ||
              !isDeepStrictEqual(args, [
                "exec",
                "-i",
                "--namespace",
                observed.namespace,
                observed.name,
                "-c",
                "gateway",
                "--",
                ...gatewayProbeCommand,
              ])
            ) {
              return fail();
            }
            stage = "model turn";
            return await exec(observed, args, options);
          } catch {
            // Discovery normally retries errors. Abort this proof instead of hiding a bad target.
            stopped.abort();
            return fail();
          }
        },
        {
          namespaceId: selected.namespaceId,
          agentId: selected.id,
          revisionId: selected.revision.id,
          prompt: undefined,
          apiKey: undefined,
          expectProviderKey: false,
          sessionKey: key,
          signal: AbortSignal.any([signal, stopped.signal, AbortSignal.timeout(remaining())]),
        },
      );
      stage = "persisted reply";
      const reply = await reader.readConversationReply(selected, {
        sessionKey: key,
        turnMarker: proof.nonce,
        runId: proof.runId,
        previous,
      });
      await checkExecution();
      return { reply, nonce: proof.nonce, runId: proof.runId };
    } catch (error) {
      if (
        stage === "model turn" &&
        error instanceof FirstAgentModelError &&
        error.code === "upstream" &&
        error.status === 500
      ) {
        const observation = await observeGatewayFailure(error);
        throw new FiniteGitConversationError(stage, error, observation);
      }
      return fail(error);
    }
  }
  return {
    async turn(previous: Tuple | undefined, timeout: number) {
      return (await turn(sessionKey, previous, timeout)).reply;
    },
    async rejectSubstitution(previous: Tuple, timeout: number) {
      const alternate = `agent:main:git-withdrawal-${randomUUID()}`;
      const fresh = await turn(alternate, undefined, timeout);
      // Validate the new conversation first, then require the original identity to mismatch.
      stage = "persisted reply";
      try {
        await reader.readConversationReply(selected, {
          sessionKey: alternate,
          turnMarker: fresh.nonce,
          runId: fresh.runId,
          previous,
        });
      } catch (error) {
        if (error instanceof ConversationReplyError && error.reason === "continuity") {
          return;
        }
        return fail(error);
      }
      fail();
    },
  };
}
