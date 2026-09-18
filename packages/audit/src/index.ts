import { deepFreeze } from "@openclaw-enterprise/utils";
import type {
  AuditEvent,
  AuditEventKind,
  AuditOutcome,
  AuthorizationRequest,
} from "@openclaw-enterprise/contracts";

export type { AuditEvent, AuditEventKind, AuditOutcome } from "@openclaw-enterprise/contracts";

export type AuditEventInput = Omit<AuditEvent, "id" | "occurredAt" | "kind" | "outcome">;

export interface AuditActor {
  readonly principalId?: string;
  readonly id?: string;
  readonly kind?: "principal" | "service_principal";
  readonly issuer?: string;
  readonly subject?: string;
  readonly unresolved?: true;
}

export interface AuditEventCreationInput extends Omit<AuditEventInput, "actorId" | "actor"> {
  readonly actorId?: string;
  readonly actor?: AuditActor;
  readonly kind?: AuditEventKind;
  readonly outcome?: AuditOutcome;
  readonly source?: "occ";
  readonly requestId?: string;
  readonly admissionDecisionId?: string;
  readonly iamDriverId?: string;
  readonly authorization?: AuthorizationRequest;
  readonly decisionReason?: string;
  readonly reasonCode?: string;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface AuditTransaction extends AuditSink {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface AuditEventFactoryOptions {
  readonly clock?: () => Date | string;
  readonly idGenerator?: () => string;
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|password|private[_-]?key|provider[_-]?(?:credential|token)|refresh[_-]?token|secret|session[_-]?(?:cookie|token)|token|body|content|message|prompt|text|transcript)/i;
const SAFE_REFERENCE_KEY = /(?:id|ids|ref|reference|name|names|kind|count)$/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+[\w.+/=-]+|\b(?:sk|ghp|gho|xox[baprs])-[\w-]{8,})/gi;
const UNSAFE_PROPERTY = /^(?:__proto__|constructor|prototype)$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;

function redact(value: unknown, visited: WeakSet<object>, depth: number): unknown {
  if (depth > 16) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return value.replace(SENSITIVE_VALUE, REDACTED).replace(CONTROL_CHARACTER, " ");
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (visited.has(value)) {
    return REDACTED;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, visited, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, reason: REDACTED };
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_PROPERTY.test(key)) {
      continue;
    }
    const sensitive = SENSITIVE_KEY.test(key) && !SAFE_REFERENCE_KEY.test(key);
    sanitized[key] = sensitive ? REDACTED : redact(entry, visited, depth + 1);
  }
  return sanitized;
}

export function redactAuditDetails(value: unknown): unknown {
  return redact(value, new WeakSet<object>(), 0);
}

function sanitizeEvent(event: AuditEvent): AuditEvent {
  if (
    event.actor?.kind !== undefined &&
    event.actor.kind !== "principal" &&
    event.actor.kind !== "service_principal"
  ) {
    throw new Error("Audit actors must be human or service principals.");
  }
  const details =
    event.details === undefined
      ? undefined
      : (redactAuditDetails(event.details) as Readonly<Record<string, unknown>>);
  const actor =
    event.actor === undefined
      ? undefined
      : (redactAuditDetails(event.actor) as NonNullable<AuditEvent["actor"]>);
  const authorization =
    event.authorization === undefined
      ? undefined
      : {
          ...event.authorization,
          resource: { ...event.authorization.resource },
        };
  return deepFreeze({
    ...event,
    resource: { ...event.resource },
    ...(actor === undefined ? {} : { actor }),
    ...(authorization === undefined ? {} : { authorization }),
    ...(details === undefined ? {} : { details }),
  });
}

export class InMemoryAuditSink implements AuditSink {
  private readonly recorded: AuditEvent[] = [];

  get events(): readonly AuditEvent[] {
    return Object.freeze([...this.recorded]);
  }

  list(): readonly AuditEvent[] {
    return this.events;
  }

  async append(event: AuditEvent): Promise<void> {
    this.recorded.push(sanitizeEvent(event));
  }

  checkpoint(): number {
    return this.recorded.length;
  }

  restore(checkpoint: number): void {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0 || checkpoint > this.recorded.length) {
      throw new RangeError("Invalid audit checkpoint.");
    }
    this.recorded.length = checkpoint;
  }

  beginTransaction(): AuditTransaction {
    const staged: AuditEvent[] = [];
    let completed = false;

    return {
      append: async (event: AuditEvent): Promise<void> => {
        if (completed) {
          throw new Error("Audit transaction is closed.");
        }
        staged.push(sanitizeEvent(event));
      },
      commit: async (): Promise<void> => {
        if (completed) {
          throw new Error("Audit transaction is closed.");
        }
        if (this.append === InMemoryAuditSink.prototype.append) {
          this.recorded.push(...staged);
          completed = true;
          return;
        }

        const checkpoint = this.checkpoint();
        try {
          for (const event of staged) {
            await this.append(event);
          }
          completed = true;
        } catch (error) {
          this.restore(checkpoint);
          completed = true;
          throw error;
        }
      },
      rollback: async (): Promise<void> => {
        if (completed) {
          return;
        }
        staged.length = 0;
        completed = true;
      },
    };
  }
}

function validateInput(input: AuditEventInput): void {
  if (!input.installationId || !input.actorId || !input.action || !input.resource?.id) {
    throw new Error("Audit events require an exact scope, actor, action, and resource.");
  }
  if (input.resource.namespaceId !== input.namespaceId) {
    throw new Error("Audit event and resource scopes must match exactly.");
  }
}

function safeReason(value: string): string {
  return value.replace(SENSITIVE_VALUE, REDACTED).replace(CONTROL_CHARACTER, " ").slice(0, 120);
}

function safeReasonCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 64);
}

export class AuditEventFactory {
  private readonly clock: () => Date | string;
  private readonly idGenerator: () => string;

  constructor(options: AuditEventFactoryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `aud_${crypto.randomUUID()}`);
  }

  create(input: AuditEventCreationInput): AuditEvent {
    const actorId = input.actorId ?? input.actor?.principalId ?? input.actor?.id ?? "unresolved";
    const kind = input.kind ?? "mutation";
    const outcome =
      input.outcome ?? (kind === "bootstrap" || kind === "mutation" ? "success" : "denied");
    const actor = input.actor ?? { principalId: actorId };
    const occurredAt = this.clock();
    const timestamp =
      typeof occurredAt === "string"
        ? new Date(occurredAt).toISOString()
        : occurredAt.toISOString();

    const event: AuditEvent = {
      schemaVersion: 1,
      id: this.idGenerator(),
      installationId: input.installationId,
      ...(input.namespaceId === undefined ? {} : { namespaceId: input.namespaceId }),
      occurredAt: timestamp,
      source: input.source ?? "occ",
      kind,
      actorId,
      actor,
      action: input.action,
      resource: input.resource,
      outcome,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.admissionDecisionId === undefined
        ? {}
        : { admissionDecisionId: input.admissionDecisionId }),
      ...(input.iamDriverId === undefined ? {} : { iamDriverId: input.iamDriverId }),
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      ...(input.decisionReason === undefined
        ? {}
        : { decisionReason: safeReason(input.decisionReason) }),
      ...(input.reasonCode === undefined ? {} : { reasonCode: safeReasonCode(input.reasonCode) }),
      ...(input.details === undefined ? {} : { details: input.details }),
    };

    validateInput(event);
    return sanitizeEvent(event);
  }
}

export { AuditEventFactory as DefaultAuditEventFactory };

export class AuditRecorder {
  private readonly sink: AuditSink;
  private readonly factory: AuditEventFactory;

  constructor(sink: AuditSink, factory: AuditEventFactory = new AuditEventFactory()) {
    this.sink = sink;
    this.factory = factory;
  }

  async record(input: AuditEventCreationInput): Promise<AuditEvent> {
    const event = this.factory.create(input);
    await this.sink.append(event);
    return event;
  }

  async recordBootstrap(input: AuditEventCreationInput): Promise<AuditEvent> {
    return this.record({ ...input, kind: "bootstrap", outcome: "success" });
  }

  async recordMutation(input: AuditEventCreationInput): Promise<AuditEvent> {
    return this.record({ ...input, kind: "mutation", outcome: "success" });
  }

  async recordAuthorizationDenial(input: AuditEventCreationInput): Promise<AuditEvent> {
    return this.record({ ...input, kind: "authorization_denial", outcome: "denied" });
  }
}

export async function recordMutation(sink: AuditSink, input: AuditEventInput): Promise<AuditEvent> {
  return new AuditRecorder(sink).recordMutation(input);
}

export async function recordAuthorizationDenial(
  sink: AuditSink,
  input: AuditEventInput,
): Promise<AuditEvent> {
  return new AuditRecorder(sink).recordAuthorizationDenial(input);
}

export async function recordBootstrap(
  sink: AuditSink,
  input: AuditEventCreationInput,
): Promise<AuditEvent> {
  return new AuditRecorder(sink).recordBootstrap(input);
}
