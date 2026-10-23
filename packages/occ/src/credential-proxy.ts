import type {
  EgressSendReceipts,
  SendAttempt,
  StoredSendReceipt,
  SendObservation,
  AcceptedEgressAssociation,
  AuthorizedSend,
} from "./egress-send-receipts.ts";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CapturedEgressUse,
  CredentialProxyExchange,
  EgressExchangeOwner,
  EgressPeer,
  EgressResolution,
  EgressSendDecision,
  EgressStreamLease,
  EgressStreamProgress,
  CredentialProviderDefinition,
  CredentialReadLifetime,
  EgressInstallation,
  EgressRefusal,
  EgressRequest,
  EgressResponse,
  EgressRoute,
  EgressMaterialEvidence,
  EgressSelectionEvidence,
  ProtectedEgressSource,
  PreparedTokenIssuer,
  PreparedTokenSource,
  StaticEgressSource,
  VersionedSecretValue,
} from "@openclaw-enterprise/contracts";
import { egressAssociationInstallation } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";

export type {
  CapturedEgressUse,
  CredentialProxyExchange,
  EgressExchangeOwner,
  EgressPeer,
  EgressResolution,
  EgressSendDecision,
  EgressStreamLease,
  EgressStreamProgress,
} from "@openclaw-enterprise/contracts";

export interface EgressAuthorityPorts {
  readonly exchangeOwner: EgressExchangeOwner;
  readonly now: () => number;
  installation(peer: EgressPeer): Promise<EgressInstallation | undefined>;
  provider(route: EgressRoute): CredentialProviderDefinition | undefined;
  /**
   * Each call must open a new policy unit, independent of the capture and Secret read.
   * With `stream`, the check runs during a leased response: it is bounded by the lease,
   * not the original deadline, and material evidence is not re-evaluated.
   */
  check(
    use: CapturedEgressUse,
    material?: EgressSelectionEvidence,
    stream?: { readonly until: string },
  ): Promise<ProtectedEgressSource | EgressRefusal>;
  read(
    source: StaticEgressSource,
    lifetime: CredentialReadLifetime,
  ): Promise<VersionedSecretValue & { readonly materialId: string }>;
  readonly readPrepared?: PreparedTokenIssuer["readWarm"];
  /** The exact current selection and the possible-send receipt share this transaction. */
  authorizePrepared?(
    use: CapturedEgressUse,
    source: PreparedTokenSource,
    attempt: SendAttempt,
    authorization: AuthorizedSend,
  ): Promise<StoredSendReceipt | EgressRefusal>;
  readonly receipts: Pick<EgressSendReceipts, "begin" | "authorize" | "record" | "observe">;
}

/**
 * A permitted response stream is renewed on progress only. The operation deadline still
 * bounds the first response byte; the idle horizon matches the client's own stream idle
 * timeout so the authority never gives up a turn the client is still waiting for.
 */
export const STREAM_LEASE_IDLE_MS = 300_000;
/** Hard ceiling from UUIDv7 creation; no progress extends a stream past it. */
export const STREAM_LEASE_CEILING_MS = 15 * 60_000;
/** Progress sooner than this after the last policy check keeps the lease unchanged. */
export const STREAM_LEASE_RECHECK_MS = 15_000;
const maximumStreamBodyBytes = 4 * 1024 * 1024;
/**
 * Default bound on remembered request IDs across all Sandboxes of this process. Each ID is
 * held until its UUIDv7 creation time plus 30 s, so this also bounds the protected request
 * rate (about 270/s).
 */
export const REPLAY_TABLE_CAPACITY = 8192;
/**
 * Default share of the replay table for one Sandbox (about 68 protected requests/s
 * sustained), so a single Sandbox cannot refuse every other Agent in the installation.
 */
export const REPLAY_SANDBOX_SHARE = REPLAY_TABLE_CAPACITY / 4;
/**
 * Default bound on operations in progress across all Sandboxes of this process: requests
 * still authenticating, pending policy, Secret or receipt work, and outstanding handles.
 */
export const OPERATION_CAPACITY = 1024;
/**
 * Default budget for requests still authenticating, across all Sandboxes. Only an
 * unauthenticated Sandbox ID is known here, so this budget is global; verification is in
 * memory, so it bounds bursts.
 */
export const OPERATION_AUTHENTICATION_BUDGET = OPERATION_CAPACITY / 4;
/** Default share of the operations in progress for one authenticated Sandbox. */
export const OPERATION_SANDBOX_SHARE = OPERATION_CAPACITY / 4;

/**
 * The request registry's in-memory bounds, per API process. Every value is a count. Installation
 * startup sets them from `drivers.credential_proxy.requestCapacity`.
 */
export interface CredentialProxyCapacity {
  /** Operations in progress, all Sandboxes. */
  readonly operations: number;
  /** Operations still authenticating, all Sandboxes. At most `operations`. */
  readonly authenticatingOperations: number;
  /** Operations in progress for one verified Sandbox. At most `operations`. */
  readonly sandboxOperations: number;
  /** Request IDs remembered for replay refusal, all Sandboxes. */
  readonly requestIds: number;
  /** Request IDs remembered for one verified Sandbox. At most `requestIds`. */
  readonly sandboxRequestIds: number;
}

export const DEFAULT_CREDENTIAL_PROXY_CAPACITY: CredentialProxyCapacity = Object.freeze({
  operations: OPERATION_CAPACITY,
  authenticatingOperations: OPERATION_AUTHENTICATION_BUDGET,
  sandboxOperations: OPERATION_SANDBOX_SHARE,
  requestIds: REPLAY_TABLE_CAPACITY,
  sandboxRequestIds: REPLAY_SANDBOX_SHARE,
});

/**
 * Largest accepted value for each bound. An operation in progress can hold its request body
 * (up to 1 MiB) and selected material, so the operation bounds stop at 8x the default; a
 * remembered request ID costs well under 1 KiB, so the ID bounds stop at 16x (about 4,300
 * protected requests/s per API process).
 */
export const CREDENTIAL_PROXY_CAPACITY_MAXIMUM: CredentialProxyCapacity = Object.freeze({
  operations: 8 * OPERATION_CAPACITY,
  authenticatingOperations: 8 * OPERATION_CAPACITY,
  sandboxOperations: 8 * OPERATION_CAPACITY,
  requestIds: 16 * REPLAY_TABLE_CAPACITY,
  sandboxRequestIds: 16 * REPLAY_TABLE_CAPACITY,
});

/** Pools first: each share's default and bound read its pool's resolved value. */
const capacityPools = ["operations", "requestIds"] as const;
/** Each share is bounded by its pool, and an omitted share defaults to a quarter of it. */
const capacityShares = [
  ["authenticatingOperations", "operations"],
  ["sandboxOperations", "operations"],
  ["sandboxRequestIds", "requestIds"],
] as const;
const capacityFields: readonly (keyof CredentialProxyCapacity)[] = [
  ...capacityPools,
  ...capacityShares.map(([share]) => share),
];

/** One refused capacity field. The message names the field, never the configured value. */
export interface CredentialProxyCapacityFault {
  /** Absent when the block itself is refused, for example for an unknown key. */
  readonly field?: keyof CredentialProxyCapacity;
  readonly code: "UNKNOWN_FIELD" | "INVALID_TYPE" | "INVALID_RANGE";
  readonly message: string;
}

/**
 * Validate configured bounds and fill omitted ones. Pools default to today's values; an omitted
 * share defaults to a quarter of its configured pool (at least 1). `path` prefixes messages.
 */
export function resolveCredentialProxyCapacity(
  input: Readonly<Record<string, unknown>>,
  path: string,
):
  | { readonly capacity: CredentialProxyCapacity; readonly faults?: undefined }
  | {
      readonly capacity?: undefined;
      readonly faults: readonly [CredentialProxyCapacityFault, ...CredentialProxyCapacityFault[]];
    } {
  const faults: CredentialProxyCapacityFault[] = [];
  if (Object.keys(input).some((key) => !(capacityFields as readonly string[]).includes(key))) {
    faults.push({
      code: "UNKNOWN_FIELD",
      message: `${path} supports only ${capacityFields.join(", ")}.`,
    });
  }
  const resolved: Partial<Record<keyof CredentialProxyCapacity, number>> = {};
  const configured = (
    field: keyof CredentialProxyCapacity,
    of?: keyof CredentialProxyCapacity,
  ): void => {
    const value = input[field];
    const maximum = CREDENTIAL_PROXY_CAPACITY_MAXIMUM[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      faults.push({ field, code: "INVALID_TYPE", message: `${path}.${field} must be an integer.` });
    } else if (value < 1 || value > maximum) {
      faults.push({
        field,
        code: "INVALID_RANGE",
        message: `${path}.${field} must be from 1 to ${maximum}.`,
      });
    } else if (of !== undefined && value > resolved[of]!) {
      faults.push({
        field,
        code: "INVALID_RANGE",
        message: `${path}.${field} must not exceed ${path}.${of}.`,
      });
    } else {
      resolved[field] = value;
    }
  };
  for (const field of capacityPools) {
    if (input[field] === undefined) {
      resolved[field] = DEFAULT_CREDENTIAL_PROXY_CAPACITY[field];
    } else {
      configured(field);
    }
  }
  for (const [field, of] of capacityShares) {
    const pool = resolved[of];
    if (input[field] !== undefined) {
      // A refused pool is already a fault: check the share's own type and range only.
      configured(field, pool === undefined ? undefined : of);
    } else if (pool !== undefined) {
      resolved[field] = Math.max(1, Math.floor(pool / 4));
    }
  }
  if (faults.length > 0) {
    return { faults: faults as [CredentialProxyCapacityFault, ...CredentialProxyCapacityFault[]] };
  }
  // Fail closed: a missing bound would compare as never reached.
  if (capacityFields.some((field) => !Number.isSafeInteger(resolved[field]))) {
    throw new Error("Credential Proxy capacity resolution left a bound unset.");
  }
  return { capacity: Object.freeze(resolved as Record<keyof CredentialProxyCapacity, number>) };
}

// One slot is shared by the live handle and every still-running phase. It counts toward
// the authentication budget until verification settles, then toward one Sandbox's share.
interface OperationCharge {
  holds: number;
  share?: string;
}

interface OperationRecord {
  readonly charge: OperationCharge;
  readonly use: CapturedEgressUse;
  readonly provider: CredentialProviderDefinition;
  readonly source: ProtectedEgressSource;
  readonly evidence: EgressSelectionEvidence;
  readonly attempt: SendAttempt;
  readonly digest: string;
  readonly association: AcceptedEgressAssociation;
  value: string | undefined;
  phase: "resolved" | "checking" | "permitted" | "renewing" | "protecting" | "observing";
  /** Liveness bound: the request deadline until the first stream renewal. */
  expiresAt: number;
  /** Narrowest authenticated peer lifetime observed, independent of the idle deadline. */
  peerExpiresAt: number;
  /** Null when progress kept the original deadline without a successful policy check. */
  stream?: {
    readonly bodyBytes: number;
    readonly ceiling: number;
    readonly checkedAt: number;
  } | null;
  timer?: ReturnType<typeof setTimeout>;
  release?: () => void;
}

function refuse(
  code: Extract<EgressRefusal, { kind: "denied" }>["code"],
): EgressResolution & { kind: "refused" } {
  return { kind: "refused", error: { kind: "denied", code } };
}

/** Expiry is checked separately: renewed authentication cannot change captured identity. */
function samePeerIdentity(captured: EgressPeer, fresh: EgressPeer): boolean {
  return (
    isDeepStrictEqual(captured.sender, fresh.sender) &&
    captured.sandboxId === fresh.sandboxId &&
    captured.instanceId === fresh.instanceId &&
    captured.exchangeId === fresh.exchangeId &&
    captured.peerKeyId === fresh.peerKeyId
  );
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** UUIDv7 creation time fixes the replay horizon independently of a resubmitted deadline. */
function operationCreatedAt(id: string): number | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    : undefined;
}

/** Matches the wire contract: ordered UTF-8 names and values with u64 big-endian lengths. */
export function egressInjectionDigest(headers: readonly (readonly [string, string])[]): string {
  const hash = createHash("sha256");
  for (const pair of headers) {
    for (const item of pair) {
      const bytes = Buffer.from(item, "utf8");
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(size).update(bytes);
    }
  }
  return hash.digest("hex");
}

/**
 * Trusted request registry shared by the transport's resolve, send and response phases.
 * Restart loses outstanding handles and fails closed. No permit or material is reusable.
 */
export class CredentialProxy implements CredentialProxyExchange {
  private readonly records = new Map<string, OperationRecord>();
  private readonly requests = new Map<
    string,
    { readonly expiresAt: number; readonly share: string }
  >();
  private readonly replayShares = new Map<string, number>();
  private readonly operationShares = new Map<string, number>();
  private activeOperations = 0;
  private authenticating = 0;
  private readonly ports: EgressAuthorityPorts;
  /** The bounds this registry enforces, fixed at construction. */
  readonly capacity: CredentialProxyCapacity;

  /** `capacity` is validated like Installation startup; omitted bounds take their defaults. */
  constructor(ports: EgressAuthorityPorts, capacity: Partial<CredentialProxyCapacity> = {}) {
    const resolved = resolveCredentialProxyCapacity(
      capacity as Readonly<Record<string, unknown>>,
      "Credential Proxy capacity",
    );
    if (resolved.faults) {
      throw new RangeError(resolved.faults.map((fault) => fault.message).join(" "));
    }
    this.ports = ports;
    this.capacity = resolved.capacity;
  }

  private async verifyPeer(authorization: string): Promise<EgressPeer | undefined> {
    const peer = await this.ports.exchangeOwner.verify(authorization);
    // Driver-owned descriptors may be reused. Detach identity, including sender,
    // before any subsequent Driver, policy or receipt await can change it.
    return peer === undefined ? undefined : immutableCopy(peer);
  }

  private releaseCharge(charge: OperationCharge): void {
    charge.holds -= 1;
    if (charge.holds === 0) {
      this.activeOperations -= 1;
      if (charge.share === undefined) {
        this.authenticating -= 1;
      } else {
        const held = this.operationShares.get(charge.share)! - 1;
        if (held === 0) {
          this.operationShares.delete(charge.share);
        } else {
          this.operationShares.set(charge.share, held);
        }
      }
    }
  }

  /** Moves an authenticated request's slot from the authentication budget to its share. */
  private chargeShare(charge: OperationCharge, share: string): boolean {
    const held = this.operationShares.get(share) ?? 0;
    if (held >= this.capacity.sandboxOperations) {
      return false;
    }
    this.authenticating -= 1;
    charge.share = share;
    this.operationShares.set(share, held + 1);
    return true;
  }

  private discard(handle: string, record: OperationRecord): void {
    if (this.records.get(handle) !== record) {
      return;
    }
    clearTimeout(record.timer);
    record.release?.();
    record.value = undefined;
    this.records.delete(handle);
    this.releaseCharge(record.charge);
  }

  private prune(): void {
    const now = this.ports.now();
    for (const [handle, record] of this.records) {
      if (record.expiresAt <= now) {
        this.discard(handle, record);
      }
    }
    this.pruneReplay(now);
  }

  private pruneReplay(now: number): void {
    for (const [key, { expiresAt, share }] of this.requests) {
      if (expiresAt <= now) {
        this.requests.delete(key);
        const held = this.replayShares.get(share)! - 1;
        if (held === 0) {
          this.replayShares.delete(share);
        } else {
          this.replayShares.set(share, held);
        }
      }
    }
  }

  /** Check and reserve in one turn: a concurrent duplicate cannot pass between them. */
  private reserveReplay(
    key: string,
    share: string,
    expiresAt: number,
  ): (EgressResolution & { kind: "refused" }) | undefined {
    if (this.requests.has(key)) {
      return refuse("invalid_handle");
    }
    const full = () =>
      this.requests.size >= this.capacity.requestIds ||
      (this.replayShares.get(share) ?? 0) >= this.capacity.sandboxRequestIds;
    if (full()) {
      // Entries may have expired while the installation lookup was pending.
      this.pruneReplay(this.ports.now());
      if (full()) {
        return { kind: "refused", error: { kind: "unavailable", code: "resolver" } };
      }
    }
    this.requests.set(key, { expiresAt, share });
    this.replayShares.set(share, (this.replayShares.get(share) ?? 0) + 1);
  }

  async resolve(
    authorization: string,
    sandboxId: string,
    input: EgressRequest,
    signal: AbortSignal,
  ): Promise<EgressResolution> {
    if (input.body.byteLength > 1024 * 1024) {
      return refuse("unsupported_operation");
    }
    this.prune();
    // Reserve before authentication or any other await. Pending Secret/policy I/O
    // consumes the same capacity as an outstanding material handle.
    if (
      this.activeOperations >= this.capacity.operations ||
      this.authenticating >= this.capacity.authenticatingOperations
    ) {
      return { kind: "refused", error: { kind: "unavailable", code: "resolver" } };
    }
    this.activeOperations += 1;
    this.authenticating += 1;
    const charge: OperationCharge = { holds: 1 };
    try {
      // Copy body bytes separately without moving the field: the sender's request digest
      // covers their original serialization order. Uint8Array also detaches a Node Buffer.
      const request: EgressRequest = {
        ...immutableCopy({ ...input, body: undefined }),
        body: new Uint8Array(input.body),
      };
      return await this.resolveReserved(authorization, sandboxId, request, signal, charge);
    } finally {
      this.releaseCharge(charge);
    }
  }

  private async resolveReserved(
    authorization: string,
    sandboxId: string,
    request: EgressRequest,
    signal: AbortSignal,
    charge: OperationCharge,
  ): Promise<EgressResolution> {
    if (signal.aborted) {
      return { kind: "refused", error: { kind: "cancelled" } };
    }
    const peer = await this.verifyPeer(authorization);
    const now = this.ports.now();
    if (!peer || peer.sandboxId !== sandboxId || !(Date.parse(peer.expiresAt) > now)) {
      return refuse("identity");
    }
    // The sender and Sandbox are authenticated from here, so a share keyed on them cannot
    // be spent by another Sandbox's traffic. A full share refuses before the replay check.
    const share = JSON.stringify([peer.sender, sandboxId]);
    if (!this.chargeShare(charge, share)) {
      return { kind: "refused", error: { kind: "unavailable", code: "resolver" } };
    }
    const deadline = Date.parse(request.deadlineAt);
    const createdAt = operationCreatedAt(request.id);
    if (
      createdAt === undefined ||
      createdAt > now + 1000 ||
      !Number.isFinite(deadline) ||
      deadline <= now ||
      deadline <= createdAt ||
      deadline > createdAt + 30_000 ||
      deadline > Date.parse(peer.expiresAt)
    ) {
      return { kind: "refused", error: { kind: "deadline_exceeded" } };
    }
    const replayKey = JSON.stringify([peer.sender, sandboxId, peer.instanceId, request.id]);
    // Refuse a known replay before any I/O; the reservation below checks again.
    if (this.requests.has(replayKey)) {
      return refuse("invalid_handle");
    }
    const installation = await this.ports.installation(peer);
    if (
      !installation ||
      !isDeepStrictEqual(installation.sender, peer.sender) ||
      installation.enforcement?.instanceId !== peer.instanceId ||
      installation.enforcement.peerKeyId !== peer.peerKeyId
    ) {
      return { kind: "refused", error: { kind: "not_ready", code: "attachment_pending" } };
    }
    const policyHash = request.verifiedExecutionPolicyHash;
    if (
      installation.enforcement.authorityScope !== "execution" ||
      !policyHash ||
      !/^[a-f0-9]{64}$/.test(policyHash) ||
      policyHash !== installation.enforcement.policyHash
    ) {
      return refuse("identity");
    }
    const matches = installation.plan.routes.flatMap((route) => {
      if (request.bindingId !== undefined && route.binding.binding.id !== request.bindingId) {
        return [];
      }
      const provider = this.ports.provider(route);
      const operation = provider?.classify(route, request);
      return provider && operation ? [{ route, provider, operation }] : [];
    });
    if (matches.length !== 1) {
      return refuse(matches.length > 1 ? "ambiguous_route" : "unsupported_operation");
    }
    const { route, provider, operation } = matches[0]!;
    // The lookup may outlast the deadline, and with it the replay horizon a key would keep.
    if (deadline > createdAt + route.deadlineMs || this.ports.now() >= deadline) {
      return { kind: "refused", error: { kind: "deadline_exceeded" } };
    }
    // Reserve after the side-effect-free installation and route refusals, before capture,
    // policy or Secret I/O. From here a failed attempt cannot reuse its request ID.
    const reserved = this.reserveReplay(replayKey, share, createdAt + 30_000);
    if (reserved) {
      return reserved;
    }
    const captured: CapturedEgressUse = {
      ...immutableCopy({
        id: request.id,
        peer,
        installation,
        route,
        operation,
      }),
      request,
    };
    const accepted = this.ports.exchangeOwner.capture(captured);
    const association = accepted === undefined ? undefined : immutableCopy(accepted);
    if (!association || !this.owns(association, captured)) {
      return refuse("identity");
    }
    let source: ProtectedEgressSource | EgressRefusal;
    try {
      source = await this.ports.check(captured);
    } catch {
      return { kind: "refused", error: { kind: "unavailable", code: "authority" } };
    }
    if (!("key" in source)) {
      return { kind: "refused", error: source };
    }
    // Policy and installation I/O may have been queued when the accepted stream
    // closed. Losing that sender revokes material access, not just a later send.
    const accessEnded = (): EgressRefusal | undefined => {
      if (signal.aborted || !this.owns(association, captured)) {
        return { kind: "cancelled" };
      }
      if (this.ports.now() >= deadline) {
        return { kind: "deadline_exceeded" };
      }
    };
    const beforeSelection = accessEnded();
    if (beforeSelection) {
      return { kind: "refused", error: beforeSelection };
    }
    try {
      // Recheck the same accepted response owner after selection, including any independent material read.
      const material = await this.selectMaterial(source, captured, signal);
      const afterSelection = accessEnded();
      if (afterSelection) {
        return { kind: "refused", error: afterSelection };
      }
      if (!("evidence" in material)) {
        return { kind: "refused", error: material };
      }
      const { evidence } = material;
      if (evidence.kind !== "no_material_required" && material.value === undefined) {
        return { kind: "refused", error: { kind: "not_ready", code: "material_missing" } };
      }
      const headers =
        evidence.kind === "no_material_required" ? [] : provider.inject(material.value!);
      const digest = egressInjectionDigest(headers);
      const handle = randomUUID();
      const record: OperationRecord = {
        charge,
        use: captured,
        association: immutableCopy(association),
        provider,
        source,
        evidence,
        digest,
        attempt: immutableCopy({
          sender: peer.sender,
          instanceId: peer.instanceId,
          useId: captured.id,
          // OpenShell has one attempt per UUIDv7 use. Keep that ID across authority restarts.
          attemptId: captured.id,
          material: evidence,
          deadlineAt: request.deadlineAt,
        }),
        value: material.value,
        phase: "resolved",
        expiresAt: deadline,
        peerExpiresAt: Date.parse(peer.expiresAt),
      };
      charge.holds += 1;
      this.records.set(handle, record);
      const closed = () => this.discard(handle, record);
      signal.addEventListener("abort", closed, { once: true });
      record.release = () => signal.removeEventListener("abort", closed);
      this.expireAt(handle, record, deadline);
      return evidence.kind === "no_material_required"
        ? { kind: "ready_without_material", handle }
        : { kind: "ready", handle, evidence, headers, injectionDigest: digest };
    } catch {
      return {
        kind: "refused",
        error: accessEnded() ?? { kind: "unavailable", code: "secret_store" },
      };
    }
  }

  private async selectMaterial(
    source: ProtectedEgressSource,
    use: CapturedEgressUse,
    signal: AbortSignal,
  ): Promise<{ value?: string; evidence: EgressSelectionEvidence } | EgressRefusal> {
    const { route, request } = use;
    const deadline = Date.parse(request.deadlineAt);
    if (source.adoption === "credential_free") {
      if (
        use.operation.kind !== "credential_free_repository_metadata" ||
        source.origin !== route.origin ||
        !isDeepStrictEqual(source.grant, route.binding.grant) ||
        !isDeepStrictEqual(source.key, route.binding.source)
      ) {
        return { kind: "denied", code: "scope_mismatch" };
      }
      const { binding, grantHash, isolationId } = route.binding;
      return {
        evidence: immutableCopy({
          kind: "no_material_required" as const,
          source: source.key,
          binding,
          grantHash,
          isolationId,
        }),
      };
    }
    const remaining = deadline - this.ports.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return { kind: "deadline_exceeded" };
    }
    const lifetime: CredentialReadLifetime = {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))]),
      deadlineAt: request.deadlineAt,
    };
    if (source.adoption === "prepared") {
      if (
        use.operation.kind !== source.grant.kind ||
        source.origin !== route.origin ||
        !isDeepStrictEqual(source.grant, route.binding.grant) ||
        !isDeepStrictEqual(source.key, route.binding.source)
      ) {
        return { kind: "denied", code: "scope_mismatch" };
      }

      const selected = await this.ports.readPrepared?.(source, lifetime);
      if (!selected) {
        return { kind: "not_ready", code: "material_missing" };
      }
      const { value, usableUntil, ...selection } = selected;
      const until = Math.min(
        deadline,
        Date.parse(usableUntil),
        Date.parse(selection.providerExpiresAt),
      );
      if (!Number.isFinite(until) || until <= this.ports.now() || lifetime.signal.aborted) {
        return { kind: "not_ready", code: "expired" };
      }
      return {
        value,
        evidence: immutableCopy({
          family: selection.family,
          ownerEpoch: selection.ownerEpoch,
          inputVersion: selection.inputVersion,
          preparationAttemptId: selection.preparationAttemptId,
          materialId: selection.materialId,
          materialVersion: selection.materialVersion,
          providerExpiresAt: selection.providerExpiresAt,
          kind: source.schemaVersion === 2 ? "prepared_github" : "prepared_token",
          source: source.key,
          binding: route.binding.binding,
          grantHash: route.binding.grantHash,
          isolationId: source.grant.isolationId,
          usableUntil: new Date(until).toISOString(),
        }),
      };
    }
    if (use.operation.kind !== "inference") {
      return { kind: "denied", code: "scope_mismatch" };
    }
    const material = await this.ports.read(source, lifetime);
    const observed = Date.parse(material.authoritativeObservedAt);
    const usableUntil = Math.min(
      deadline,
      material.expiresAt === undefined ? deadline : Date.parse(material.expiresAt),
    );
    if (
      !material.version ||
      !material.materialId ||
      !Number.isFinite(observed) ||
      observed > this.ports.now() ||
      !Number.isFinite(usableUntil) ||
      usableUntil <= this.ports.now()
    ) {
      return { kind: "not_ready", code: "expired" };
    }
    if (lifetime.signal.aborted) {
      return { kind: "cancelled" };
    }
    const evidence: EgressMaterialEvidence = immutableCopy({
      kind: "static",
      source: source.key,
      binding: route.binding.binding,
      grantHash: route.binding.grantHash,
      isolationId: route.binding.isolationId,
      adoption: source.adoption,
      materialRefId: source.materialRefId,
      secret: source.secret,
      secretDriver: source.secretDriver,
      materialId: material.materialId,
      materialVersion: material.version,
      authoritativeObservedAt: material.authoritativeObservedAt,
      usableUntil: new Date(usableUntil).toISOString(),
      retention: "none" as const,
    });

    return { value: material.value, evidence };
  }

  private expireAt(handle: string, record: OperationRecord, at: number): void {
    clearTimeout(record.timer);
    record.timer = setTimeout(
      () => {
        this.discard(handle, record);
      },
      Math.max(1, at - this.ports.now()),
    ).unref();
  }

  private narrowPeerLifetime(handle: string, record: OperationRecord, peer: EgressPeer): void {
    record.peerExpiresAt = Math.min(record.peerExpiresAt, Date.parse(peer.expiresAt));
    if (record.stream) {
      record.stream = {
        ...record.stream,
        ceiling: Math.min(record.stream.ceiling, record.peerExpiresAt),
      };
    }
    if (record.expiresAt > record.peerExpiresAt) {
      record.expiresAt = record.peerExpiresAt;
      this.expireAt(handle, record, record.expiresAt);
    }
  }

  private owns(association: AcceptedEgressAssociation, use: CapturedEgressUse): boolean {
    return (
      isDeepStrictEqual(association.execution, use.route.binding.execution) &&
      isDeepStrictEqual(association.execution, use.installation.plan.execution) &&
      isDeepStrictEqual(
        association.installation,
        egressAssociationInstallation(use.installation),
      ) &&
      this.ports.exchangeOwner.owns(association, use) === true
    );
  }

  async authorizeSend(
    authorization: string,
    sandboxId: string,
    requestId: string,
    handle: string,
    selection: EgressMaterialEvidence | true,
    injectionDigest: string,
    deadlineAt: string,
    signal: AbortSignal,
  ): Promise<EgressSendDecision> {
    this.prune();
    const record = this.records.get(handle);
    if (record) {
      record.charge.holds += 1;
    }
    try {
      return await this.authorizeSendReserved(
        authorization,
        sandboxId,
        requestId,
        handle,
        selection,
        injectionDigest,
        deadlineAt,
        signal,
        record,
      );
    } finally {
      if (record) {
        this.releaseCharge(record.charge);
      }
    }
  }

  private async authorizeSendReserved(
    authorization: string,
    sandboxId: string,
    requestId: string,
    handle: string,
    selection: EgressMaterialEvidence | true,
    injectionDigest: string,
    deadlineAt: string,
    signal: AbortSignal,
    record: OperationRecord | undefined,
  ): Promise<EgressSendDecision> {
    const peer = await this.verifyPeer(authorization);
    if (
      !record ||
      this.records.get(handle) !== record ||
      !(record.expiresAt > this.ports.now()) ||
      !peer ||
      peer.sandboxId !== sandboxId ||
      !samePeerIdentity(record.use.peer, peer) ||
      !(Date.parse(peer.expiresAt) > this.ports.now()) ||
      !(Date.parse(record.use.peer.expiresAt) > this.ports.now()) ||
      requestId !== record.use.request.id ||
      deadlineAt !== record.use.request.deadlineAt ||
      (selection === true
        ? record.evidence.kind !== "no_material_required"
        : record.evidence.kind === "no_material_required" ||
          !isDeepStrictEqual(record.evidence, selection)) ||
      !sameSecret(record.digest, injectionDigest) ||
      !this.owns(record.association, record.use)
    ) {
      return refuse("invalid_handle");
    }
    this.narrowPeerLifetime(handle, record, peer);
    // An exact authenticated duplicate can shorten custody, but cannot authorize again.
    if (record.phase !== "resolved") {
      return refuse("invalid_handle");
    }
    // Reserve before any persistence/policy I/O. A duplicate or unknown commit never permits send.
    record.phase = "checking";
    try {
      const begun = await this.ports.receipts.begin(peer.sender, record.attempt);
      if (!begun.created) {
        this.discard(handle, record);
        return refuse("invalid_handle");
      }
    } catch {
      this.discard(handle, record);
      return { kind: "refused", error: { kind: "unavailable", code: "authority" } };
    }
    const deny = async (error: EgressRefusal): Promise<EgressSendDecision> => {
      this.discard(handle, record);
      try {
        await this.ports.receipts.record(peer.sender, record.attempt, {
          kind: "refused",
          dispatched: false,
          error,
        });
        return { kind: "refused", error };
      } catch {
        return { kind: "refused", error: { kind: "unavailable", code: "authority" } };
      }
    };
    if (signal.aborted) {
      return deny({ kind: "cancelled" });
    }
    // Fresh transport and policy checks follow possibly slow durable persistence and exact selection.
    let decision: ProtectedEgressSource | EgressRefusal;
    let finalPeer: EgressPeer | undefined;
    try {
      finalPeer = await this.verifyPeer(authorization);
      if (!finalPeer || !isDeepStrictEqual(finalPeer, peer)) {
        return deny({ kind: "denied", code: "identity" });
      }
      // Prepared currentness must stay locked through receipt commit below.
      decision =
        record.source.adoption === "prepared"
          ? record.source
          : await this.ports.check(record.use, record.evidence);
    } catch {
      return deny({ kind: "unavailable", code: "authority" });
    }
    if (!("key" in decision) || !isDeepStrictEqual(decision, record.source)) {
      return deny("key" in decision ? { kind: "denied", code: "stale_configuration" } : decision);
    }
    if (signal.aborted) {
      return deny({ kind: "cancelled" });
    }
    const now = this.ports.now();
    const sendStartBy = Math.min(
      now + 1000,
      Date.parse(record.use.request.deadlineAt),
      record.evidence.kind === "no_material_required"
        ? Infinity
        : Date.parse(record.evidence.usableUntil),
      Date.parse(finalPeer.expiresAt),
      record.peerExpiresAt,
    );
    if (
      !(sendStartBy > now) ||
      this.records.get(handle) !== record ||
      record.phase !== "checking"
    ) {
      return deny({ kind: "deadline_exceeded" });
    }
    const authorized: AuthorizedSend = immutableCopy({
      association: record.association,
      requestDigest: createHash("sha256")
        .update(
          JSON.stringify({
            ...record.use.request,
            body: Buffer.from(record.use.request.body).toString("base64"),
          }),
        )
        .digest("hex"),
      injectionDigest: record.digest,
      authorizedAt: new Date(now).toISOString(),
      sendStartBy: new Date(sendStartBy).toISOString(),
    });
    if (!this.owns(record.association, record.use)) {
      return deny({ kind: "denied", code: "identity" });
    }
    try {
      const committed =
        record.source.adoption === "prepared"
          ? await this.ports.authorizePrepared!(
              record.use,
              record.source,
              record.attempt,
              authorized,
            )
          : await this.ports.receipts.authorize(peer.sender, record.attempt, authorized);
      if ("kind" in committed) {
        return deny(committed);
      }
      // Never repair/replay a lost acknowledgment or extend the bound across this await.
      if (
        !isDeepStrictEqual(committed.authorization, authorized) ||
        signal.aborted ||
        this.records.get(handle) !== record ||
        record.phase !== "checking" ||
        this.ports.now() >= sendStartBy ||
        sendStartBy > record.peerExpiresAt ||
        !this.owns(record.association, record.use)
      ) {
        this.discard(handle, record);
        return refuse("invalid_handle");
      }
    } catch {
      this.discard(handle, record);
      return { kind: "refused", error: { kind: "unavailable", code: "authority" } };
    }
    // This means permission issued, NOT confirmed dispatch. The durable receipt stays possible.
    record.phase = "permitted";
    return {
      kind: "allow",
      authorization: authorized,
      sendStartBy: new Date(sendStartBy).toISOString(),
      injectionDigest: record.digest,
      noMaterialRequired: record.evidence.kind === "no_material_required",
    };
  }

  /** The one permitted operation this authenticated stream may still claim, if any. */
  private permitted(
    peer: EgressPeer | undefined,
    sandboxId: string,
    requestId: string,
  ): { peer: EgressPeer; handle: string; record: OperationRecord } | undefined {
    this.prune();
    if (!peer || peer.sandboxId !== sandboxId || !(Date.parse(peer.expiresAt) > this.ports.now())) {
      return undefined;
    }
    const entry = [...this.records].find(
      ([, record]) =>
        record.use.request.id === requestId &&
        samePeerIdentity(record.use.peer, peer) &&
        Date.parse(record.use.peer.expiresAt) > this.ports.now() &&
        record.expiresAt > this.ports.now() &&
        this.owns(record.association, record.use),
    );
    if (!entry) {
      return undefined;
    }
    const [handle, record] = entry;
    // An accepted operation retains every shorter verified lifetime from its
    // exact owner; the phase only decides whether this call may claim it.
    this.narrowPeerLifetime(handle, record, peer);
    if (record.phase !== "permitted") {
      return undefined;
    }
    return { peer, handle, record };
  }

  /** Claim exactly one authenticated response stream before its preflight decision. */
  async beginResponse(
    authorization: string,
    sandboxId: string,
    requestId: string,
  ): Promise<string | undefined> {
    const peer = await this.verifyPeer(authorization);
    // Match, narrow and reserve in one turn, after authentication has settled.
    const claimed = this.permitted(peer, sandboxId, requestId);
    if (!claimed) {
      return undefined;
    }
    claimed.record.phase = "protecting";
    return claimed.handle;
  }

  /**
   * Renew the permitted operation while the origin's response streams. Only progress
   * renews: the first frame needs the response head (within the operation deadline) and
   * each later frame more body bytes. Progress can trigger a policy check no sooner than
   * STREAM_LEASE_RECHECK_MS after the last successful check; silence triggers no check.
   * An unavailable authority keeps the current bound without extending it. A lost
   * owner (custody or peer expiry) cuts without an observation: there is no stream left
   * to observe for. Nothing here releases bytes.
   */
  async renewResponse(
    authorization: string,
    sandboxId: string,
    requestId: string,
    progress: EgressStreamProgress,
  ): Promise<EgressStreamLease | undefined> {
    const authenticated = await this.verifyPeer(authorization);
    // No yield between the permitted check and either cached return or reservation.
    const claimed = this.permitted(authenticated, sandboxId, requestId);
    if (!claimed) {
      return undefined;
    }
    const { peer, handle, record } = claimed;
    const createdAt = operationCreatedAt(record.use.request.id);
    if (
      record.use.operation.kind !== "inference" ||
      createdAt === undefined ||
      !progress.headReceived ||
      !Number.isSafeInteger(progress.bodyBytes) ||
      progress.bodyBytes < 0 ||
      progress.bodyBytes > maximumStreamBodyBytes
    ) {
      this.discard(handle, record);
      return undefined;
    }
    const lease = (): EgressStreamLease => ({
      renewBy: new Date(record.expiresAt).toISOString(),
      expiresAt: new Date(record.stream?.ceiling ?? record.expiresAt).toISOString(),
    });
    // A frame without new bytes, or sooner than the recheck interval, keeps the
    // current bound; it cannot extend it.
    if (
      record.stream &&
      (progress.bodyBytes <= record.stream.bodyBytes ||
        this.ports.now() - record.stream.checkedAt < STREAM_LEASE_RECHECK_MS)
    ) {
      return lease();
    }
    record.phase = "renewing";
    // Capacity stays charged until the policy check and any observation settle.
    record.charge.holds += 1;
    try {
      const decision = await this.checkStreamPolicy(record);
      const now = this.ports.now();
      if (
        this.records.get(handle) !== record ||
        record.phase !== "renewing" ||
        !(record.expiresAt > now) ||
        !(Date.parse(record.use.peer.expiresAt) > now) ||
        !(Date.parse(peer.expiresAt) > now) ||
        !this.owns(record.association, record.use)
      ) {
        this.discard(handle, record);
        return undefined;
      }
      record.phase = "permitted";
      if (
        "key" in decision ? !isDeepStrictEqual(decision, record.source) : decision.kind === "denied"
      ) {
        // The origin already answered: record the cut like any other blocked response.
        this.discard(handle, record);
        try {
          await this.ports.receipts.observe(record.use.peer.sender, record.attempt, {
            kind: "response_blocked",
            dispatch: "confirmed",
            code: "response_policy",
          });
        } catch {
          // The stream is already cut; a lost observation cannot release bytes.
        }
        return undefined;
      }
      if (!("key" in decision)) {
        record.stream ??= null;
        return lease();
      }
      const ceiling = Math.min(createdAt + STREAM_LEASE_CEILING_MS, record.peerExpiresAt);
      const renewBy = Math.min(now + STREAM_LEASE_IDLE_MS, ceiling);
      if (!(renewBy > now)) {
        this.discard(handle, record);
        return undefined;
      }
      record.expiresAt = renewBy;
      record.stream = { bodyBytes: progress.bodyBytes, ceiling, checkedAt: now };
      this.expireAt(handle, record, renewBy);
      return lease();
    } finally {
      this.releaseCharge(record.charge);
    }
  }

  private async checkStreamPolicy(
    record: OperationRecord,
  ): Promise<ProtectedEgressSource | EgressRefusal> {
    try {
      return await this.ports.check(record.use, undefined, {
        until: new Date(record.expiresAt).toISOString(),
      });
    } catch {
      return { kind: "unavailable", code: "authority" };
    }
  }

  /** Store only observation metadata. Returning policy bytes is not supplier application proof. */
  async protectResponse(
    handle: string,
    response: EgressResponse,
    signal: AbortSignal,
    inspect = true,
  ): Promise<EgressResponse | undefined> {
    const record = this.records.get(handle);
    if (!record || record.phase !== "protecting") {
      return undefined;
    }
    // Claim the response before any await; a second stream cannot take it during observation or release.
    record.phase = "observing";
    record.charge.holds += 1;
    try {
      const rejected =
        inspect &&
        record.evidence.kind !== "no_material_required" &&
        record.provider.credentialRejected(response);
      const safe =
        inspect && !signal.aborted && record.expiresAt > this.ports.now()
          ? record.provider.protectResponse(
              response,
              record.value,
              record.use.request,
              record.use.operation,
            )
          : undefined;
      const observed: SendObservation =
        safe === undefined
          ? { kind: "response_blocked", dispatch: "confirmed", code: "response_policy" }
          : {
              kind: rejected ? "provider_rejected" : "response",
              dispatch: "confirmed",
              status: safe.status,
            };
      await this.ports.receipts.observe(
        record.use.peer.sender,
        record.attempt,
        observed,
        rejected ? { classification: "credential_rejected", evidence: record.evidence } : undefined,
      );
      // The receipt records the upstream response and any credential rejection, not delivery.
      // If persistence outlived our custody, there is no response left to authorize.
      const stillOwnsResponse = () =>
        this.records.get(handle) === record &&
        !signal.aborted &&
        record.expiresAt > this.ports.now() &&
        this.owns(record.association, record.use);
      if (safe === undefined || !stillOwnsResponse()) {
        return undefined;
      }
      if (record.stream !== undefined) {
        // Policy may have changed during a quiet stream or while committing the observation.
        // Check it last, then recheck local custody without another await before returning bytes.
        const policy = await this.checkStreamPolicy(record);
        if (
          !("key" in policy) ||
          !isDeepStrictEqual(policy, record.source) ||
          !stillOwnsResponse()
        ) {
          return undefined;
        }
      }
      return safe;
    } finally {
      this.discard(handle, record);
      this.releaseCharge(record.charge);
    }
  }
}
