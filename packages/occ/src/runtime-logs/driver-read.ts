import type {
  AgentRuntimeDescribeOptions,
  AgentRuntimeDescription,
  ComputeAgentRevisionBinding,
  ComputeDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import {
  NotImplementedError,
  RuntimeLogsError,
  RuntimeLogsForbiddenByClusterError,
  RuntimeLogsSandboxNotFoundError,
} from "../errors.ts";
import type { RuntimeLogCursorCodec } from "./cursor.ts";
import { validRuntimeDescription } from "./description.ts";
import {
  readRuntimeLogPage,
  runtimeLogPageAtLevel,
  RuntimeLogReadError,
  type RuntimeLogPage,
  type RuntimeLogQuery,
  type RuntimeLogViewAdmission,
} from "./read.ts";
import { readSandboxLogPage, SANDBOX_LOG_RETENTION } from "./sandbox.ts";

/** Overall deadline for one runtime status or log request, Driver calls included. */
const RUNTIME_LOG_REQUEST_TIMEOUT_MS = 10_000;

type ResolveSandboxLogDriver = () => SandboxDriver | undefined;

interface DriverLogReadOptions {
  readonly codec: RuntimeLogCursorCodec;
  readonly admitView: (admission: RuntimeLogViewAdmission) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly resolveSandboxLogDriver: ResolveSandboxLogDriver;
  readonly clock: () => Date;
}

export async function readDriverRuntimeLogs(
  principalId: string,
  agentId: string,
  driver: ComputeDriver,
  binding: ComputeAgentRevisionBinding,
  query: RuntimeLogQuery,
  optionsForRead: () => DriverLogReadOptions,
): Promise<Readonly<RuntimeLogPage>> {
  const options = optionsForRead();
  const source = query.source;
  if (source === "sandbox") {
    return runtimeLogPageAtLevel(
      await readSandboxLogs(principalId, agentId, driver, binding, query, options),
      query.minLevel,
    );
  }
  if (typeof driver.readAgentRuntimeLogs !== "function") {
    throw new NotImplementedError(
      "readAgentRuntimeLogs",
      "The selected Compute Driver does not expose runtime logs.",
    );
  }
  return runtimeLogOperation(options.signal, async (deadline) => {
    // Every follow poll describes the runtime again for the ownership re-check; it
    // needs only the requested source's Pods, not their Events.
    const description = await describedAgentRuntime(driver, binding, deadline, {
      source,
      events: false,
    });
    try {
      const page = await readRuntimeLogPage({
        description,
        query,
        codec: options.codec,
        binding: {
          principalId,
          agentId,
          revisionId: binding.revision.id,
          source: query.source,
        },
        signal: deadline,
        admitView: options.admitView,
        readLogs: async (request) => {
          try {
            return await driver.readAgentRuntimeLogs!(binding, request);
          } catch (error) {
            throw runtimeLogDriverFailure(error, deadline);
          }
        },
      });
      return runtimeLogPageAtLevel(page, query.minLevel);
    } catch (error) {
      if (error instanceof RuntimeLogReadError) {
        throw runtimeLogPageFailure(error, query.source);
      }
      throw error;
    }
  });
}

/**
 * The revision's Sandbox log, read through the Sandbox Driver that provisioned it. The
 * Sandbox is derived from the revision; no caller-named Sandbox reaches the Driver.
 */
async function readSandboxLogs(
  principalId: string,
  agentId: string,
  compute: ComputeDriver,
  binding: ComputeAgentRevisionBinding,
  query: RuntimeLogQuery,
  options: DriverLogReadOptions,
): Promise<Readonly<RuntimeLogPage>> {
  const sandbox = options.resolveSandboxLogDriver();
  if (sandbox === undefined) {
    throw new RuntimeLogsError("RUNTIME_LOGS_SOURCE_UNAVAILABLE", undefined, "sandbox");
  }
  // The first lookup binds the reader. Source availability is checked again after
  // recording the observation time, before the deadline starts.
  const description = withSandboxLogSource(
    Object.freeze({
      revisionId: binding.revision.id,
      observedAt: options.clock().toISOString(),
      pods: Object.freeze([]),
      sources: Object.freeze([]),
    }),
    options.resolveSandboxLogDriver,
  );
  return runtimeLogOperation(options.signal, async (deadline) => {
    try {
      return await readSandboxLogPage({
        description,
        query,
        codec: options.codec,
        binding: { principalId, agentId, revisionId: binding.revision.id, source: "sandbox" },
        admitView: options.admitView,
        readLogs: async (request) => {
          try {
            // The Sandbox lives in Compute's placement of the Namespace, as at provisioning.
            const namespace = await compute.resolveSandboxNamespace!.call(
              compute,
              binding.namespace,
            );
            return await sandbox.readSandboxLogs!(
              { namespace, revision: binding.revision, signal: deadline },
              request,
            );
          } catch (error) {
            throw runtimeLogDriverFailure(error, deadline);
          }
        },
      });
    } catch (error) {
      if (error instanceof RuntimeLogReadError) {
        throw runtimeLogPageFailure(error, "sandbox");
      }
      throw error;
    }
  });
}

/** Appends the `sandbox` source when the revision's Sandbox Driver exposes its log. */
export function withSandboxLogSource(
  description: Readonly<AgentRuntimeDescription>,
  resolveSandboxLogDriver: ResolveSandboxLogDriver,
): Readonly<AgentRuntimeDescription> {
  if (
    resolveSandboxLogDriver() === undefined ||
    description.sources.some(({ id }) => id === "sandbox")
  ) {
    return description;
  }
  return Object.freeze({
    ...description,
    sources: Object.freeze([
      ...description.sources,
      Object.freeze({
        id: "sandbox" as const,
        kind: "sandbox" as const,
        pods: Object.freeze([]),
        available: true,
        retention: SANDBOX_LOG_RETENTION,
      }),
    ]),
  });
}

export async function runtimeLogOperation<T>(
  signal: AbortSignal | undefined,
  operation: (deadline: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(RUNTIME_LOG_REQUEST_TIMEOUT_MS);
  const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    return await operation(deadline);
  } catch (error) {
    if (timeout.aborted && !(error instanceof RuntimeLogsError)) {
      throw new RuntimeLogsError("RUNTIME_LOGS_TIMEOUT");
    }
    throw error;
  }
}

export async function describedAgentRuntime(
  driver: ComputeDriver,
  binding: ComputeAgentRevisionBinding,
  signal: AbortSignal,
  options?: AgentRuntimeDescribeOptions,
): Promise<Readonly<AgentRuntimeDescription>> {
  let described: unknown;
  try {
    described = await driver.describeAgentRuntime!(binding, signal, options);
  } catch (error) {
    throw runtimeLogDriverFailure(error, signal);
  }
  try {
    return validRuntimeDescription(described, binding.revision.id);
  } catch {
    throw new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
  }
}

function runtimeLogPageFailure(
  error: RuntimeLogReadError,
  source: RuntimeLogQuery["source"],
): RuntimeLogsError {
  switch (error.reason) {
    case "cursor_invalid":
      return new RuntimeLogsError("RUNTIME_LOGS_CURSOR_INVALID", undefined, source);
    case "pod_invalid":
      return new RuntimeLogsError("RUNTIME_LOGS_POD_INVALID", undefined, source);
    case "source_unavailable":
      return new RuntimeLogsError("RUNTIME_LOGS_SOURCE_UNAVAILABLE", undefined, source);
    default:
      return new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE", undefined, source);
  }
}

/** Driver and cluster error text can hold private runtime details; never propagate it. */
function runtimeLogDriverFailure(error: unknown, signal: AbortSignal): RuntimeLogsError {
  if (error instanceof RuntimeLogsForbiddenByClusterError) {
    return new RuntimeLogsError("RUNTIME_LOGS_CLUSTER_RBAC");
  }
  if (error instanceof RuntimeLogsSandboxNotFoundError) {
    return new RuntimeLogsError("RUNTIME_LOGS_SANDBOX_NOT_FOUND");
  }
  if (signal.aborted) {
    return new RuntimeLogsError("RUNTIME_LOGS_TIMEOUT");
  }
  return new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
}
