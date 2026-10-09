import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { ResourceStateConflictError } from "./errors.ts";

/** Private Secret-backed state; provider payloads never enter platform rows or API responses. */
export interface DeviceAuthorizationSession {
  readonly kind: "harness_device_authorization";
  readonly version: 1;
  readonly actorId: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly harnessId: string;
  readonly credentialGatewayId: string;
  readonly sourceId: string;
  readonly phase: "pending" | "polling" | "ready" | "cancelled";
  readonly expiresAt: string;
  readonly nextPollAt: string;
  readonly authorization: {
    readonly verificationUrl: string;
    readonly userCode: string;
    readonly intervalSeconds: number;
  };
  readonly privateState?: string;
}

export function deviceAuthorizationSession(value: string): DeviceAuthorizationSession {
  let record: Record<string, unknown> | undefined;
  try {
    record = asRecord(JSON.parse(value));
  } catch {
    // Unsupported or consumed credentials cannot be reopened as an OCE login session.
  }
  const authorization = asRecord(record?.authorization);
  if (
    record?.kind !== "harness_device_authorization" ||
    record.version !== 1 ||
    !isNonEmptyString(record.actorId) ||
    !isNonEmptyString(record.namespaceId) ||
    !isNonEmptyString(record.harnessId) ||
    !isNonEmptyString(record.credentialGatewayId) ||
    !isNonEmptyString(record.sourceId) ||
    (record.agentId !== undefined && !isNonEmptyString(record.agentId)) ||
    !["pending", "polling", "ready", "cancelled"].includes(String(record.phase)) ||
    !isNonEmptyString(record.expiresAt) ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    !isNonEmptyString(record.nextPollAt) ||
    !Number.isFinite(Date.parse(record.nextPollAt)) ||
    !isNonEmptyString(authorization?.verificationUrl) ||
    !isNonEmptyString(authorization?.userCode) ||
    typeof authorization.intervalSeconds !== "number" ||
    authorization.intervalSeconds < 1 ||
    (record.phase !== "ready" &&
      record.phase !== "cancelled" &&
      !isNonEmptyString(record.privateState))
  ) {
    throw new ResourceStateConflictError(
      "This login is no longer available in OCE. Connect again.",
    );
  }
  return record as unknown as DeviceAuthorizationSession;
}
