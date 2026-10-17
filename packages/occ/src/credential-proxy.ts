import type {
  EgressSendReceipts,
  SendAttempt,
  SendObservation,
  AcceptedEgressAssociation,
  AuthorizedSend,
} from "./egress-send-receipts.ts";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProviderDefinition,
  CredentialReadLifetime,
  EgressInstallation,
  EgressRef,
  EgressRefusal,
  EgressRequest,
  EgressResponse,
  EgressRoute,
  EgressOperation,
  EgressMaterialEvidence,
  EgressSelectionEvidence,
  ProtectedEgressSource,
  PreparedGitHubEgressLifecycle,
  StaticEgressSource,
  VersionedSecretValue,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";

export interface EgressPeer {
  readonly sender: EgressRef;
  readonly sandboxId: string;
  readonly instanceId: string;
  readonly expiresAt: string;
  readonly exchangeId?: string;
  /** Public key identifier authenticated by the transport, pinned separately at installation. */
  readonly peerKeyId?: string;
}

export interface CapturedEgressUse {
  readonly id: string;
  readonly peer: EgressPeer;
  readonly installation: EgressInstallation;
  readonly route: EgressRoute;
  readonly request: EgressRequest;
  readonly operation: EgressOperation;
}

/** Installed transport owner authenticates and captures the live request and response destination. */
export interface EgressExchangeOwner {
  verify(authorization: string): Promise<EgressPeer | undefined>;
  capture(use: CapturedEgressUse): AcceptedEgressAssociation | undefined;
  /** Match the active transport sender and reply custody, not just stored IDs or liveness. */
  owns(association: AcceptedEgressAssociation, use: CapturedEgressUse): boolean;
}

export interface EgressAuthorityPorts {
  readonly exchangeOwner: EgressExchangeOwner;
  readonly now: () => number;
  installation(peer: EgressPeer): Promise<EgressInstallation | undefined>;
  provider(route: EgressRoute): CredentialProviderDefinition | undefined;
  /** Each call must open a new policy unit, independent of the capture and Secret read. */
  check(
    use: CapturedEgressUse,
    material?: EgressSelectionEvidence,
  ): Promise<ProtectedEgressSource | EgressRefusal>;
  read(
    source: StaticEgressSource,
    lifetime: CredentialReadLifetime,
  ): Promise<VersionedSecretValue & { readonly materialId: string }>;
  readonly readPreparedGitHub?: PreparedGitHubEgressLifecycle["readWarm"];
  readonly receipts: Pick<EgressSendReceipts, "begin" | "authorize" | "record" | "observe">;
}

export type EgressResolution =
  | { readonly kind: "ready_without_material"; readonly handle: string }
  | { readonly kind: "refused"; readonly error: EgressRefusal }
  | {
      readonly kind: "ready";
      readonly handle: string;
      readonly evidence: EgressMaterialEvidence;
      readonly headers: readonly (readonly [string, string])[];
      readonly injectionDigest: string;
    };

export type EgressSendDecision =
  | { readonly kind: "refused"; readonly error: EgressRefusal }
  | {
      readonly kind: "allow";
      readonly authorization: AuthorizedSend;
      readonly sendStartBy: string;
      readonly injectionDigest: string;
      readonly noMaterialRequired: boolean;
    };

// One global slot is shared by the live handle and every still-running phase.
interface OperationCharge {
  holds: number;
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
  phase: "resolved" | "checking" | "permitted" | "protecting" | "observing";
  timer?: ReturnType<typeof setTimeout>;
  release?: () => void;
}

function refuse(
  code: Extract<EgressRefusal, { kind: "denied" }>["code"],
): EgressResolution & { kind: "refused" } {
  return { kind: "refused", error: { kind: "denied", code } };
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
export class CredentialProxy {
  private readonly records = new Map<string, OperationRecord>();
  private readonly requests = new Map<string, number>();
  private activeOperations = 0;
  private readonly ports: EgressAuthorityPorts;

  constructor(ports: EgressAuthorityPorts) {
    this.ports = ports;
  }

  private releaseCharge(charge: OperationCharge): void {
    charge.holds -= 1;
    if (charge.holds === 0) {
      this.activeOperations -= 1;
    }
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
      if (Date.parse(record.use.request.deadlineAt) <= now) {
        this.discard(handle, record);
      }
    }
    for (const [key, expiresAt] of this.requests) {
      if (expiresAt <= now) {
        this.requests.delete(key);
      }
    }
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
    if (this.activeOperations >= 1024) {
      return { kind: "refused", error: { kind: "unavailable", code: "resolver" } };
    }
    this.activeOperations += 1;
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
    const peer = await this.ports.exchangeOwner.verify(authorization);
    const now = this.ports.now();
    if (!peer || peer.sandboxId !== sandboxId || Date.parse(peer.expiresAt) <= now) {
      return refuse("identity");
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
    if (this.requests.has(replayKey)) {
      return refuse("invalid_handle");
    }
    if (this.requests.size >= 4096) {
      return { kind: "refused", error: { kind: "unavailable", code: "resolver" } };
    }
    // Reserve before installation/policy I/O. Failed attempts cannot reuse their request ID.
    this.requests.set(replayKey, createdAt + 30_000);
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
    if (deadline > createdAt + route.deadlineMs) {
      return { kind: "refused", error: { kind: "deadline_exceeded" } };
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
      };
      charge.holds += 1;
      this.records.set(handle, record);
      const closed = () => this.discard(handle, record);
      signal.addEventListener("abort", closed, { once: true });
      record.release = () => signal.removeEventListener("abort", closed);
      record.timer = setTimeout(
        () => {
          this.discard(handle, record);
        },
        Math.max(1, deadline - this.ports.now()),
      ).unref();
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
        use.operation.kind !== "github_repository_metadata" ||
        !isDeepStrictEqual(source.grant, route.binding.grant) ||
        !isDeepStrictEqual(source.key, route.binding.source)
      ) {
        return { kind: "denied", code: "scope_mismatch" };
      }

      const selected = await this.ports.readPreparedGitHub?.(source, lifetime);
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
          kind: "prepared_github",
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

  private owns(association: AcceptedEgressAssociation, use: CapturedEgressUse): boolean {
    return (
      isDeepStrictEqual(association.execution, use.route.binding.execution) &&
      isDeepStrictEqual(association.execution, use.installation.plan.execution) &&
      isDeepStrictEqual(association.installation, {
        sandboxId: use.installation.sandboxId,
        ...use.installation.enforcement,
        plan: { id: use.installation.plan.id, generation: use.installation.plan.generation },
      }) &&
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
    const peer = await this.ports.exchangeOwner.verify(authorization);
    if (
      !record ||
      this.records.get(handle) !== record ||
      record.phase !== "resolved" ||
      !peer ||
      peer.sandboxId !== sandboxId ||
      !isDeepStrictEqual(peer.sender, record.use.peer.sender) ||
      peer.instanceId !== record.use.peer.instanceId ||
      peer.exchangeId !== record.use.peer.exchangeId ||
      sandboxId !== record.use.peer.sandboxId ||
      requestId !== record.use.request.id ||
      deadlineAt !== record.use.request.deadlineAt ||
      (selection === true
        ? record.evidence.kind !== "no_material_required"
        : record.evidence.kind === "no_material_required" ||
          !isDeepStrictEqual(record.evidence, selection)) ||
      !sameSecret(record.digest, injectionDigest)
    ) {
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
      finalPeer = await this.ports.exchangeOwner.verify(authorization);
      if (!finalPeer || !isDeepStrictEqual(finalPeer, peer)) {
        return deny({ kind: "denied", code: "identity" });
      }
      decision = await this.ports.check(record.use, record.evidence);
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
    );
    if (sendStartBy <= now || this.records.get(handle) !== record || record.phase !== "checking") {
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
      const committed = await this.ports.receipts.authorize(
        peer.sender,
        record.attempt,
        authorized,
      );
      // Never repair/replay a lost acknowledgment or extend the bound across this await.
      if (
        !isDeepStrictEqual(committed.authorization, authorized) ||
        signal.aborted ||
        this.records.get(handle) !== record ||
        record.phase !== "checking" ||
        this.ports.now() >= sendStartBy ||
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

  /** Claim exactly one authenticated response stream before its preflight decision. */
  async beginResponse(
    authorization: string,
    sandboxId: string,
    requestId: string,
  ): Promise<string | undefined> {
    this.prune();
    const peer = await this.ports.exchangeOwner.verify(authorization);
    if (!peer || peer.sandboxId !== sandboxId || Date.parse(peer.expiresAt) <= this.ports.now()) {
      return undefined;
    }
    const entry = [...this.records].find(
      ([, record]) =>
        record.phase === "permitted" &&
        this.owns(record.association, record.use) &&
        record.use.request.id === requestId &&
        record.use.peer.sandboxId === sandboxId &&
        record.use.peer.instanceId === peer.instanceId &&
        record.use.peer.exchangeId === peer.exchangeId &&
        isDeepStrictEqual(record.use.peer.sender, peer.sender),
    );
    if (!entry) {
      return undefined;
    }
    const [handle, record] = entry;
    record.phase = "protecting";
    return handle;
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
    // Consume even while persistence is pending; no second stream/body can reuse this response.
    record.phase = "observing";
    record.charge.holds += 1;
    try {
      const rejected =
        inspect &&
        record.evidence.kind !== "no_material_required" &&
        record.provider.credentialRejected(response);
      const safe =
        inspect && !signal.aborted && Date.parse(record.use.request.deadlineAt) > this.ports.now()
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
      // Persistence may outlive the original deadline or cancellation. Never release late bytes.
      return this.records.get(handle) === record &&
        !signal.aborted &&
        Date.parse(record.use.request.deadlineAt) > this.ports.now() &&
        this.owns(record.association, record.use)
        ? safe
        : undefined;
    } finally {
      this.discard(handle, record);
      this.releaseCharge(record.charge);
    }
  }
}
