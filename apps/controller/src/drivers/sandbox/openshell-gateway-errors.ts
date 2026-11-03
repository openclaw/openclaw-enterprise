import {
  SANDBOX_DELETION_UNCONFIRMED,
  SandboxGatewayUnauthorizedError,
  SandboxGatewayUnavailableError,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

export class OpenShellGatewayFailure extends Error {}

const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

/** Runs one gateway call; see `gatewayIdentityRefusal`. */
export type GatewayCall = <T>(call: () => Promise<T>) => Promise<T>;

/**
 * Wraps the gateway calls of one Sandbox operation in `workspace`. A refusal of the
 * controller's own gateway identity (grpc-js PERMISSION_DENIED or UNAUTHENTICATED, which
 * `unary` passes through raw) becomes `SandboxGatewayUnauthorizedError`, so the worker fails
 * the work with that code instead of spending its attempts on a generic failure: at once for
 * PERMISSION_DENIED (a role the identity lacks), after its attempt budget for UNAUTHENTICATED,
 * which OpenShell also answers while a token file or its JWKS is between refreshes (`transient`,
 * finding 1694). `unconfirmed` names what the refusal leaves unconfirmed, for example "the
 * Harness exposure of Sandbox x cannot be confirmed withdrawn".
 */
export function gatewayIdentityRefusal(workspace: string, unconfirmed: string): GatewayCall {
  return async (call) => {
    try {
      return await call();
    } catch (error) {
      const record = asRecord(error);
      // grpc-js ServiceError: a numeric status code and a string details field.
      const code = typeof record?.details === "string" ? record.code : undefined;
      if (code === GRPC_PERMISSION_DENIED || code === GRPC_UNAUTHENTICATED) {
        throw new SandboxGatewayUnauthorizedError(
          `OpenShell refused the controller gateway identity in Workspace ${workspace}, so ${unconfirmed}.`,
          { cause: error, transient: code === GRPC_UNAUTHENTICATED },
        );
      }
      throw error;
    }
  };
}

/**
 * DeleteSandbox or DeleteService answered NOT_FOUND for a target a read had just found: the
 * target went away in between (a failed candidate retired by the next activation while the
 * sweep was withdrawing its exposure, finding 1696) or the identity lost sight of it. Either way
 * nothing is confirmed; the next attempt settles it through `confirmSandboxAbsent`.
 */
export class OpenShellDeletionUnconfirmedError extends OpenShellGatewayFailure {
  readonly code = SANDBOX_DELETION_UNCONFIRMED;
}

/**
 * Decides whether a target's NOT_FOUND (a Sandbox, its exposed service or its provider
 * attachment) means the target is gone. OpenShell answers NOT_FOUND alike for a target that
 * does not exist and for one this identity may not see (no existence oracle: GetSandbox,
 * DeleteSandbox, GetService, DeleteService, DetachSandboxProvider all hide it), so an identity
 * that lost its Workspace role would otherwise read every Sandbox as removed while it, its
 * exposure and its credentials stay live (findings 1670, 1676). GetWorkspace keeps
 * PERMISSION_DENIED, so a Workspace this identity can still read is the proof; a refusal there
 * fails with `SANDBOX_GATEWAY_UNAUTHORIZED` through `refused`, and a Workspace OpenShell reports
 * missing fails closed with `absent()`. With the documented `user` role a Workspace deleted out
 * of band presents as a refusal too, since OpenShell drops the membership before the record, so
 * `absent()` is defense in depth for identities with a platform role.
 *
 * GetWorkspace proves the role now, not at the earlier read: a role restored between the two
 * would otherwise confirm a live target (finding 1692). So `reread` repeats the target read
 * after GetWorkspace, and only a target still missing is absent (`undefined`); one the identity
 * now sees is returned, and the caller deletes or withdraws it instead of recording absence.
 * What remains needs the role lost again between GetWorkspace and that read, after it was
 * hidden at the first: two flaps within two round trips.
 */
export async function confirmSandboxAbsent<T>(
  client: { getWorkspace(name: string, signal: AbortSignal): Promise<unknown> },
  workspace: string,
  signal: AbortSignal,
  refused: GatewayCall,
  absent: () => Error,
  reread: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if ((await refused(() => client.getWorkspace(workspace, signal))) === undefined) {
    throw absent();
  }
  return refused(reread);
}

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

/**
 * gRPC UNAVAILABLE: grpc-js's status when it cannot reach the gateway or loses its connection,
 * and also one the gateway itself answers with for some failures (finding 2042).
 */
export const GRPC_UNAVAILABLE = 14;
/** gRPC DEADLINE_EXCEEDED: also grpc-js's status for a call that never got a connection. */
export const GRPC_DEADLINE_EXCEEDED = 4;

/**
 * The gateway did not answer a request: grpc-js reached no gateway, lost the connection under
 * the call, or still had no connection at the request deadline (a status grpc-js made up
 * itself), so it is down or restarting. A status the gateway sent itself is not this error
 * (findings 2042, 2048). A revision pass waits for it within the deployment deadline instead of
 * spending attempts (finding 2040); every other caller sees a DependencyUnavailableError, as for
 * any other failed request.
 */
export class OpenShellGatewayUnavailableError extends SandboxGatewayUnavailableError {
  readonly grpcStatus: number;

  constructor(message: string, grpcStatus: number) {
    super(message);
    this.grpcStatus = grpcStatus;
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
