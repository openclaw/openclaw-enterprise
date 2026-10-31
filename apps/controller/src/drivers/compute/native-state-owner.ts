/** Native custody is useful only when Compute also knows the exact owning container. */
export interface NativeGatewayStateOwner {
  readonly databasePath: string;
  readonly ownerId: string;
  readonly role: "gateway";
  readonly pid: number;
  readonly startTime: number;
  readonly processNamespace: {
    readonly platform: "linux";
    readonly host: string;
    readonly identity: string;
    readonly pidNsInode: string;
  };
}

export interface NativeGatewayOwnerRecord {
  readonly kind: "state-owner" | "state-lock" | "config-lock" | "gateway-lease";
  readonly owner: NativeGatewayStateOwner;
}

export interface NativeGatewayStateObservation {
  readonly revisionId: string;
  readonly container: "gateway";
  readonly gatewayState: {
    readonly toolBoundary: typeof TRUSTED_GATEWAY_TOOL_BOUNDARY;
    readonly stateOrigin: typeof GATEWAY_PRIVATE_STATE_ORIGIN;
    readonly storageId: string;
    readonly instanceId: string;
    readonly sourceProtection?: typeof GATEWAY_RECOVERY_SOURCE_PROTECTION;
    readonly liveOwner?: NativeGatewayStateOwner;
    readonly recovery?: {
      readonly state: "waiting" | "manual" | "refused";
      readonly ownerRecords?: readonly NativeGatewayOwnerRecord[];
    };
  };
}

export interface GatewayStateOwnerBinding {
  readonly version: 1;
  readonly toolBoundary: GatewayToolBoundary;
  readonly sourceProtection: typeof GATEWAY_RECOVERY_SOURCE_PROTECTION;
  readonly stateOrigin: typeof GATEWAY_PRIVATE_STATE_ORIGIN;
  readonly pvcUid: string;
  readonly revisionId: string;
  readonly instanceId: string;
  readonly podName: string;
  readonly podUid: string;
  readonly containerId: string;
  readonly owner: NativeGatewayStateOwner;
  readonly termination?: {
    readonly containerId: string;
    readonly finishedAt: string;
    readonly exitCode: number;
  };
}

export const GATEWAY_STATE_OWNER_ANNOTATION = "openclaw.dev/gateway-state-owner";
export const GATEWAY_STATE_RECOVERY_ANNOTATION = "openclaw.dev/gateway-state-recovery";
export const GATEWAY_STATE_RECOVERY_VOLUME = "gateway-state-recovery";
export const GATEWAY_STATE_RECOVERY_DIRECTORY = "/etc/openclaw-state-recovery";
export const GATEWAY_STATE_RECOVERY_PATH = `${GATEWAY_STATE_RECOVERY_DIRECTORY}/request.json`;
export const GATEWAY_STATE_DATABASE_PATH = "/home/node/.openclaw/state/openclaw.sqlite";
export const GATEWAY_STATE_TERMINATION_PATH = "/dev/termination-log";
export const TRUSTED_GATEWAY_TOOL_BOUNDARY = "oce-gateway-tools/v1";
export const GATEWAY_RECOVERY_SOURCE_PROTECTION = "bundled-image/v1";
export const GATEWAY_STATE_ORIGIN_ANNOTATION = "openclaw.dev/gateway-state-origin";
export const GATEWAY_PRIVATE_STATE_ORIGIN = "private-dedicated/v1";

export interface DockerGatewayStateOwnerBinding {
  readonly version: 1;
  readonly toolBoundary: typeof TRUSTED_GATEWAY_TOOL_BOUNDARY;
  readonly sourceProtection: typeof GATEWAY_RECOVERY_SOURCE_PROTECTION;
  readonly stateOrigin: typeof GATEWAY_PRIVATE_STATE_ORIGIN;
  readonly storageId: string;
  readonly revisionId: string;
  readonly instanceId: string;
  readonly containerId: string;
  readonly startedAt: string;
  readonly owner: NativeGatewayStateOwner;
  readonly termination?: {
    readonly containerId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly exitCode: number;
  };
}

export function parseDockerGatewayStateOwnerBinding(
  value: unknown,
): DockerGatewayStateOwnerBinding | undefined {
  const binding = nativeStateRecord(value);
  const owner = parseNativeGatewayStateOwner(binding?.owner);
  if (
    binding?.version !== 1 ||
    binding.toolBoundary !== TRUSTED_GATEWAY_TOOL_BOUNDARY ||
    binding.sourceProtection !== GATEWAY_RECOVERY_SOURCE_PROTECTION ||
    binding.stateOrigin !== GATEWAY_PRIVATE_STATE_ORIGIN ||
    owner === undefined ||
    !nativeStateText(binding.storageId, 512) ||
    !nativeStateText(binding.revisionId) ||
    !nativeStateText(binding.instanceId, 128) ||
    !nativeStateText(binding.containerId) ||
    !/^[a-f0-9]{64}$/.test(binding.containerId) ||
    !nativeStateText(binding.startedAt, 128) ||
    !(Date.parse(binding.startedAt) > 0)
  ) {
    return undefined;
  }
  const termination = nativeStateRecord(binding.termination);
  if (
    binding.termination !== undefined &&
    (termination === undefined ||
      termination.containerId !== binding.containerId ||
      termination.startedAt !== binding.startedAt ||
      !nativeStateText(termination.finishedAt, 128) ||
      !(Date.parse(termination.finishedAt) >= Date.parse(binding.startedAt)) ||
      typeof termination.exitCode !== "number" ||
      !Number.isInteger(termination.exitCode))
  ) {
    return undefined;
  }
  return {
    version: 1,
    toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
    sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION,
    stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
    storageId: binding.storageId,
    revisionId: binding.revisionId,
    instanceId: binding.instanceId,
    containerId: binding.containerId,
    startedAt: binding.startedAt,
    owner,
    ...(termination === undefined
      ? {}
      : {
          termination: {
            containerId: binding.containerId,
            startedAt: binding.startedAt,
            finishedAt: termination.finishedAt as string,
            exitCode: termination.exitCode as number,
          },
        }),
  };
}

/** Call only after trusted Compute stops this exact observed container. */
export function dockerGatewayOwnerTermination(
  inspected: unknown,
  binding: DockerGatewayStateOwnerBinding,
): DockerGatewayStateOwnerBinding["termination"] {
  const container = nativeStateRecord(inspected);
  const state = nativeStateRecord(container?.State);
  if (
    container?.Id !== binding.containerId ||
    state?.StartedAt !== binding.startedAt ||
    state.Running !== false ||
    state.Pid !== 0 ||
    !["exited", "dead"].includes(String(state.Status)) ||
    !nativeStateText(state.FinishedAt, 128) ||
    !(Date.parse(state.FinishedAt) >= Date.parse(binding.startedAt)) ||
    typeof state.ExitCode !== "number" ||
    !Number.isInteger(state.ExitCode)
  ) {
    return undefined;
  }
  return {
    containerId: binding.containerId,
    startedAt: binding.startedAt,
    finishedAt: state.FinishedAt,
    exitCode: state.ExitCode,
  };
}
export type GatewayToolBoundary = typeof TRUSTED_GATEWAY_TOOL_BOUNDARY;

export function nativeStateRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function nativeStateText(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

/** Legacy, foreign-role and incomplete identities cannot authorize automatic recovery. */
export function parseNativeGatewayStateOwner(value: unknown): NativeGatewayStateOwner | undefined {
  const owner = nativeStateRecord(value);
  const namespace = nativeStateRecord(owner?.processNamespace);
  if (
    owner === undefined ||
    !nativeStateText(owner.databasePath, 4096) ||
    !owner.databasePath.startsWith("/") ||
    !nativeStateText(owner.ownerId) ||
    owner.role !== "gateway" ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.startTime !== "number" ||
    !Number.isSafeInteger(owner.startTime) ||
    owner.startTime < 0 ||
    namespace?.platform !== "linux" ||
    !nativeStateText(namespace.host) ||
    !nativeStateText(namespace.identity) ||
    !nativeStateText(namespace.pidNsInode, 32) ||
    !/^\d+$/.test(namespace.pidNsInode)
  ) {
    return undefined;
  }
  return {
    databasePath: owner.databasePath,
    ownerId: owner.ownerId,
    role: "gateway",
    pid: owner.pid,
    startTime: owner.startTime,
    processNamespace: {
      platform: "linux",
      host: namespace.host,
      identity: namespace.identity,
      pidNsInode: namespace.pidNsInode,
    },
  };
}

export function parseNativeGatewayOwnerRecords(
  value: unknown,
): readonly NativeGatewayOwnerRecord[] | undefined {
  if (!Array.isArray(value) || value.length > 4) {
    return undefined;
  }
  const kinds = new Set<string>();
  const records: NativeGatewayOwnerRecord[] = [];
  for (const entry of value) {
    const record = nativeStateRecord(entry);
    const owner = parseNativeGatewayStateOwner(record?.owner);
    if (
      record === undefined ||
      owner === undefined ||
      typeof record.kind !== "string" ||
      !["state-owner", "state-lock", "config-lock", "gateway-lease"].includes(record.kind) ||
      kinds.has(record.kind)
    ) {
      return undefined;
    }
    kinds.add(record.kind);
    records.push({ kind: record.kind as NativeGatewayOwnerRecord["kind"], owner });
  }
  return records;
}

export function nativeGatewayOwnersMatch(
  records: readonly NativeGatewayOwnerRecord[],
  owner: NativeGatewayStateOwner,
): boolean {
  const expected = JSON.stringify(owner);
  return records.length > 0 && records.every((record) => JSON.stringify(record.owner) === expected);
}

export function parseGatewayStateOwnerBinding(
  value: unknown,
): GatewayStateOwnerBinding | undefined {
  const binding = nativeStateRecord(value);
  const owner = parseNativeGatewayStateOwner(binding?.owner);
  if (
    binding?.version !== 1 ||
    binding.toolBoundary !== TRUSTED_GATEWAY_TOOL_BOUNDARY ||
    binding.sourceProtection !== GATEWAY_RECOVERY_SOURCE_PROTECTION ||
    binding.stateOrigin !== GATEWAY_PRIVATE_STATE_ORIGIN ||
    owner === undefined ||
    !nativeStateText(binding.pvcUid) ||
    !nativeStateText(binding.revisionId) ||
    !nativeStateText(binding.instanceId) ||
    !nativeStateText(binding.podName) ||
    !nativeStateText(binding.podUid) ||
    !nativeStateText(binding.containerId)
  ) {
    return undefined;
  }
  const termination = nativeStateRecord(binding.termination);
  if (
    binding.termination !== undefined &&
    (termination?.containerId !== binding.containerId ||
      !nativeStateText(termination.finishedAt) ||
      !Number.isFinite(Date.parse(termination.finishedAt)) ||
      typeof termination.exitCode !== "number" ||
      !Number.isInteger(termination.exitCode))
  ) {
    return undefined;
  }
  return {
    version: 1,
    toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
    sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION,
    stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
    pvcUid: binding.pvcUid,
    revisionId: binding.revisionId,
    instanceId: binding.instanceId,
    podName: binding.podName,
    podUid: binding.podUid,
    containerId: binding.containerId,
    owner,
    ...(termination === undefined
      ? {}
      : {
          termination: {
            containerId: binding.containerId,
            finishedAt: termination.finishedAt as string,
            exitCode: termination.exitCode as number,
          },
        }),
  };
}

export function gatewayOwnerTerminationMessage(
  binding: Pick<
    GatewayStateOwnerBinding,
    | "toolBoundary"
    | "sourceProtection"
    | "stateOrigin"
    | "pvcUid"
    | "instanceId"
    | "podUid"
    | "revisionId"
    | "owner"
  >,
): string {
  return JSON.stringify({
    version: 1,
    toolBoundary: binding.toolBoundary,
    sourceProtection: binding.sourceProtection,
    stateOrigin: binding.stateOrigin,
    storageId: binding.pvcUid,
    instanceId: binding.instanceId,
    podUid: binding.podUid,
    revisionId: binding.revisionId,
    owner: binding.owner,
  });
}

/** Pod disappearance, deletion requests and synthetic unknown exits are not death evidence. */
export function gatewayOwnerTermination(
  value: unknown,
  binding: GatewayStateOwnerBinding,
): GatewayStateOwnerBinding["termination"] | undefined {
  const pod = nativeStateRecord(value);
  const metadata = nativeStateRecord(pod?.metadata);
  const status = nativeStateRecord(pod?.status);
  if (
    metadata?.uid !== binding.podUid ||
    metadata.name !== binding.podName ||
    metadata.deletionGracePeriodSeconds === 0 ||
    status?.reason === "NodeLost" ||
    !Array.isArray(status?.containerStatuses)
  ) {
    return undefined;
  }
  const container = status.containerStatuses
    .map(nativeStateRecord)
    .find((entry) => entry?.name === "gateway");
  for (const state of [container?.state, container?.lastState]) {
    const termination = nativeStateRecord(nativeStateRecord(state)?.terminated);
    const finishedAt =
      termination?.finishedAt instanceof Date
        ? termination.finishedAt.toISOString()
        : termination?.finishedAt;
    if (
      termination?.containerID === binding.containerId &&
      termination.message === gatewayOwnerTerminationMessage(binding) &&
      ["Completed", "Error", "OOMKilled"].includes(String(termination.reason)) &&
      typeof termination.exitCode === "number" &&
      Number.isInteger(termination.exitCode) &&
      nativeStateText(finishedAt) &&
      Number.isFinite(Date.parse(finishedAt)) &&
      Date.parse(finishedAt) > 0
    ) {
      return { containerId: binding.containerId, finishedAt, exitCode: termination.exitCode };
    }
  }
  return undefined;
}

/** Select only the nonsecret facts the fixed healthcheck may emit. */
export function parseNativeGatewayStateObservation(
  value: unknown,
): NativeGatewayStateObservation | undefined {
  const status = nativeStateRecord(value);
  const state = nativeStateRecord(status?.gatewayState);
  if (
    !nativeStateText(status?.revisionId) ||
    status.container !== "gateway" ||
    state?.toolBoundary !== TRUSTED_GATEWAY_TOOL_BOUNDARY ||
    state.stateOrigin !== GATEWAY_PRIVATE_STATE_ORIGIN ||
    !nativeStateText(state.storageId) ||
    !nativeStateText(state.instanceId, 128)
  ) {
    return undefined;
  }
  const qualified = state.sourceProtection === GATEWAY_RECOVERY_SOURCE_PROTECTION;
  if (state.sourceProtection !== undefined && !qualified) {
    return undefined;
  }
  const owner = parseNativeGatewayStateOwner(state.liveOwner);
  const recovery = nativeStateRecord(state.recovery);
  const records =
    recovery?.ownerRecords === undefined
      ? undefined
      : parseNativeGatewayOwnerRecords(recovery.ownerRecords);
  if (
    state.liveOwner !== undefined &&
    (!qualified || owner?.databasePath !== GATEWAY_STATE_DATABASE_PATH || recovery !== undefined)
  ) {
    return undefined;
  }
  if (state.recovery !== undefined) {
    if (
      recovery === undefined ||
      typeof recovery.state !== "string" ||
      !["waiting", "manual", "refused"].includes(recovery.state) ||
      (recovery.ownerRecords !== undefined && records === undefined) ||
      (recovery.state === "waiting" && (records === undefined || records.length === 0)) ||
      records?.some((record) => record.owner.databasePath !== GATEWAY_STATE_DATABASE_PATH)
    ) {
      return undefined;
    }
  } else if (owner === undefined && !qualified) {
    return undefined;
  }
  return {
    revisionId: status.revisionId,
    container: "gateway",
    gatewayState: {
      toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
      stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
      storageId: state.storageId,
      instanceId: state.instanceId,
      ...(qualified ? { sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION } : {}),
      ...(owner === undefined ? {} : { liveOwner: owner }),
      ...(recovery === undefined
        ? {}
        : {
            recovery: {
              state: recovery.state as "waiting" | "manual" | "refused",
              ...(records === undefined ? {} : { ownerRecords: records }),
            },
          }),
    },
  };
}

const NATIVE_OWNER_PARSERS = [
  nativeStateRecord,
  nativeStateText,
  parseNativeGatewayStateOwner,
  parseNativeGatewayOwnerRecords,
];

// The generated wrapper and Compute use the same identity checks.
export const NATIVE_STATE_OWNER_VALIDATORS = [
  ...NATIVE_OWNER_PARSERS,
  nativeGatewayOwnersMatch,
  gatewayOwnerTerminationMessage,
]
  .map((parser) => parser.toString())
  .join("\n");

export const NATIVE_GATEWAY_STATE_OBSERVATION_VALIDATORS = [
  `const TRUSTED_GATEWAY_TOOL_BOUNDARY = ${JSON.stringify(TRUSTED_GATEWAY_TOOL_BOUNDARY)};`,
  `const GATEWAY_PRIVATE_STATE_ORIGIN = ${JSON.stringify(GATEWAY_PRIVATE_STATE_ORIGIN)};`,
  `const GATEWAY_RECOVERY_SOURCE_PROTECTION = ${JSON.stringify(GATEWAY_RECOVERY_SOURCE_PROTECTION)};`,
  `const GATEWAY_STATE_DATABASE_PATH = ${JSON.stringify(GATEWAY_STATE_DATABASE_PATH)};`,
  ...NATIVE_OWNER_PARSERS.map((parser) => parser.toString()),
  parseNativeGatewayStateObservation.toString(),
].join("\n");
