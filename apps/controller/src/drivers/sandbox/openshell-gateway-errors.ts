import { TransientDependencyError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

export class OpenShellGatewayFailure extends Error {}

export class OpenShellSandboxAlreadyExistsError extends Error {
  readonly sandboxName: string;

  constructor(sandboxName: string) {
    super(`OpenShell Sandbox ${sandboxName} already exists.`);
    this.sandboxName = sandboxName;
  }
}

/**
 * The gateway refused a request_id it had already admitted: an earlier call with this ID
 * errored server-side (REQUEST_OUTCOME_UNCERTAIN, permanent), carried another payload
 * (REQUEST_ID_PAYLOAD_MISMATCH), or succeeded but can no longer be replayed
 * (REQUEST_REPLAY_UNAVAILABLE). Nothing ran for this call.
 */
export class OpenShellRequestReplayRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(`OpenShell refused the request_id (${reason}): ${message}`);
    this.reason = reason;
  }
}

// OpenShell's exact refusal once the caller holds 1000 durable request admissions
// (crates/openshell-server/src/grpc/mutation_replay.rs). Other RESOURCE_EXHAUSTED
// refusals, such as the rate limit or busy admission workers, stay the raw gRPC error.
export const ADMISSION_LIMIT_DETAILS = "caller has reached the durable mutation admission limit";

/**
 * OpenShell refused a mutation because OCC's gateway identity holds its maximum of 1000
 * durable request admissions. Completed admissions free up 24 h after completion, so the
 * worker holds the revision pending without spending attempts; admissions left unresolved
 * never expire, so a limit still reached at the deployment deadline fails it.
 */
export class OpenShellAdmissionLimitError extends TransientDependencyError {
  constructor(method: string, cause: unknown) {
    super(
      "sandbox_admission",
      "unavailable",
      `OpenShell refused ${method}: the controller's gateway identity holds OpenShell's limit of 1000 durable request admissions. ` +
        "Completed admissions free up 24 h after completion; unresolved ones never expire and OpenShell has no reset API, " +
        "so if the limit persists, investigate the unresolved admissions in the OpenShell gateway database, then redeploy.",
      { cause },
    );
    this.name = "OpenShellAdmissionLimitError";
  }
}

export const REPLAY_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  "REQUEST_OUTCOME_UNCERTAIN",
  "REQUEST_ID_PAYLOAD_MISMATCH",
  "REQUEST_REPLAY_UNAVAILABLE",
]);
const OPENSHELL_ERROR_DOMAIN = "openshell.nvidia.com";
const ERROR_INFO_TYPE_URL = "type.googleapis.com/google.rpc.ErrorInfo";

interface ProtobufFields {
  readonly varints: Map<number, number[]>;
  readonly bytes: Map<number, Uint8Array[]>;
}

/** The varint and length-delimited fields of one protobuf message, or undefined if malformed. */
function protobufFields(bytes: Uint8Array): ProtobufFields | undefined {
  const fields: ProtobufFields = { varints: new Map(), bytes: new Map() };
  const append = <T>(map: Map<number, T[]>, field: number, value: T) => {
    const values = map.get(field) ?? [];
    values.push(value);
    map.set(field, values);
  };
  let offset = 0;
  const varint = (): number | undefined => {
    let value = 0;
    for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) {
        return value;
      }
    }
    return undefined;
  };
  while (offset < bytes.length) {
    const key = varint();
    if (key === undefined) {
      return undefined;
    }
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      const value = varint();
      if (value === undefined) {
        return undefined;
      }
      append(fields.varints, field, value);
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
    } else if (wireType === 2) {
      const length = varint();
      if (length === undefined || length > bytes.length - offset) {
        return undefined;
      }
      append(fields.bytes, field, bytes.subarray(offset, offset + length));
      offset += length;
    } else {
      return undefined;
    }
  }
  return offset === bytes.length ? fields : undefined;
}

function utf8(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
}

/** OpenShell's google.rpc.ErrorInfo reason from a FAILED_PRECONDITION status details trailer. */
export function openShellErrorReason(
  error: unknown,
  failedPrecondition: number,
): string | undefined {
  const metadata = asRecord(error)?.metadata as { get?: unknown } | undefined;
  const values =
    typeof metadata?.get === "function"
      ? (metadata.get as (key: string) => unknown)("grpc-status-details-bin")
      : undefined;
  const details = Array.isArray(values) ? values[0] : undefined;
  if (!(details instanceof Uint8Array)) {
    return undefined;
  }
  // google.rpc.Status: 1 = code, 3 = repeated Any details; Any: 1 = type_url,
  // 2 = value; ErrorInfo: 1 = reason, 2 = domain. Scalars are last-wins.
  const status = protobufFields(details);
  if (status === undefined || (status.varints.get(1)?.at(-1) ?? 0) !== failedPrecondition) {
    return undefined;
  }
  for (const any of status.bytes.get(3) ?? []) {
    const fields = protobufFields(any)?.bytes;
    const value = fields?.get(2)?.at(-1);
    if (utf8(fields?.get(1)?.at(-1)) !== ERROR_INFO_TYPE_URL || value === undefined) {
      continue;
    }
    const info = protobufFields(value)?.bytes;
    if (utf8(info?.get(2)?.at(-1)) === OPENSHELL_ERROR_DOMAIN) {
      return utf8(info?.get(1)?.at(-1));
    }
  }
  return undefined;
}

export class OpenShellProviderAlreadyExistsError extends Error {
  readonly providerName: string;

  constructor(providerName: string) {
    super(`OpenShell provider ${providerName} already exists.`);
    this.providerName = providerName;
  }
}

export class OpenShellWorkspaceAlreadyExistsError extends Error {
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(`OpenShell Workspace ${workspaceName} already exists.`);
    this.workspaceName = workspaceName;
  }
}

export function statusCode(error: unknown): number | undefined {
  const candidate = asRecord(error)?.code;
  return typeof candidate === "number" ? candidate : undefined;
}
