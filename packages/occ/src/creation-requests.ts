import { createHash } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "./errors.ts";

export interface CreationRequestScope {
  readonly namespaceId: string;
  readonly actorId: string;
  readonly operation: "createConfiguration" | "createAgent";
  readonly idempotencyKey: string;
}

export interface CreationRequestIdentity extends CreationRequestScope {
  readonly fingerprint: string;
}

export interface CreationRequest extends CreationRequestIdentity {
  readonly resourceId: string;
  readonly createdAt: string;
}

export interface CreationRequestRepository {
  find(scope: CreationRequestScope): Promise<Readonly<CreationRequest> | undefined>;
  record(request: CreationRequest): Promise<void>;
}

/** Safe messages distinguish conflicting intent from an unavailable prior result. */
export class CreationRequestConflictError extends ResourceConflictError {
  constructor(reason: "inputs" | "unavailable") {
    super(
      reason === "inputs"
        ? "The idempotency key was already used with different creation inputs."
        : "The resource created by this idempotency key is no longer available.",
    );
    this.name = "CreationRequestConflictError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new ScopeViolationError("Creation inputs must be JSON values.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([first], [second]) => {
      if (first === second) {
        return 0;
      }
      return first < second ? -1 : 1;
    })
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function creationRequestIdentity(
  actorId: string,
  operation: CreationRequestScope["operation"],
  input: { readonly namespaceId: string; readonly idempotencyKey?: string },
): CreationRequestIdentity | undefined {
  const { namespaceId, idempotencyKey, ...body } = input;
  if (idempotencyKey === undefined) {
    return undefined;
  }
  if (
    typeof idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)
  ) {
    throw new ScopeViolationError("The creation idempotency key is invalid.");
  }
  return {
    namespaceId,
    actorId,
    operation,
    idempotencyKey,
    fingerprint: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  };
}

/** Call under the Namespace lock also held by creation and deletion. */
export async function findCreationResult(
  repository: CreationRequestRepository,
  identity: CreationRequestIdentity | undefined,
): Promise<string | undefined> {
  if (identity === undefined) {
    return undefined;
  }
  const request = await repository.find(identity);
  if (request === undefined) {
    return undefined;
  }
  if (request.fingerprint !== identity.fingerprint) {
    throw new CreationRequestConflictError("inputs");
  }
  return request.resourceId;
}

export async function recordCreationResult(
  repository: CreationRequestRepository,
  identity: CreationRequestIdentity | undefined,
  resource: { readonly id: string; readonly createdAt: string },
): Promise<void> {
  if (identity !== undefined) {
    await repository.record({
      ...identity,
      resourceId: resource.id,
      createdAt: resource.createdAt,
    });
  }
}
