import { TransientDependencyError } from "@openclaw-enterprise/occ";
import type { GatewayClient } from "@openclaw/gateway-client";
import type {
  PredecessorCompletionContext,
  PredecessorCompletionResult,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { withGateway } from "./node-enrollment-client.ts";

export interface GatewayPredecessorCompletion {
  observe(
    url: string,
    requestId: string,
    context: PredecessorCompletionContext,
    signal: AbortSignal,
  ): Promise<PredecessorCompletionResult>;
}

export function createGatewayPredecessorCompletion(
  readApiKey: () => Promise<string>,
): GatewayPredecessorCompletion {
  return {
    observe: (url, requestId, context, signal) =>
      withGateway(url, readApiKey, signal, (client, requestSignal) =>
        completePredecessorOnConnection(client, requestId, context, requestSignal),
      ),
  };
}

/** All observations and the committed handoff refer to this same authenticated connection. */
export async function completePredecessorOnConnection(
  client: Pick<GatewayClient, "request">,
  requestId: string,
  context: PredecessorCompletionContext,
  signal: AbortSignal,
): Promise<PredecessorCompletionResult> {
  const info = asRecord(await client.request("system.info", {}, { signal }));
  if (info?.deferredStopHandoff !== true) {
    return "unsupported";
  }
  if (
    !Number.isSafeInteger(info.pid) ||
    Number(info.pid) < 1 ||
    typeof info.processInstanceId !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(info.processInstanceId)
  ) {
    throw new TransientDependencyError(
      "agent_gateway",
      "unavailable",
      "The predecessor did not identify its execution.",
    );
  }
  const target = { pid: Number(info.pid), processInstanceId: info.processInstanceId };
  const identity = `${target.pid}:${target.processInstanceId}`;
  if (
    (context.expectedExecutionIdentity !== undefined &&
      context.expectedExecutionIdentity !== identity) ||
    !(await context.recordExecutionIdentity(identity))
  ) {
    return "runtime-changed";
  }
  const prepared = asRecord(
    await client.request(
      "gateway.suspend.prepare",
      {
        requestId,
        terminalPolicy: "preserve",
        completionDeadlineMs: context.deadlineAtMs,
      },
      { signal },
    ),
  );
  if (prepared?.status === "busy" || prepared?.status === "draining") {
    return "waiting";
  }
  if (
    prepared?.status !== "ready" ||
    typeof prepared.suspensionId !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(prepared.suspensionId)
  ) {
    throw new TransientDependencyError(
      "agent_gateway",
      "unavailable",
      "The predecessor did not return a valid completion lease.",
    );
  }
  // Persist the common stopping boundary before any irreversible host fence.
  await context.commitStopping(identity);
  try {
    const handed = asRecord(
      await client.request(
        "gateway.suspend.handoff",
        {
          suspensionId: prepared.suspensionId,
          target,
          commit: true,
          deferExit: true,
        },
        { signal },
      ),
    );
    return handed?.status === "committed" && handed.suspensionId === prepared.suspensionId
      ? "ready"
      : "handoff-unconfirmed";
  } catch {
    // Stopping is durable already. Continue the normal bounded stop, without claiming completion.
    signal.throwIfAborted();
    return "handoff-unconfirmed";
  }
}
