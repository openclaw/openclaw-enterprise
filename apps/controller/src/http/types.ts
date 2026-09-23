import type {
  AuditEvent,
  OccApiOperationId,
  OccApiRoute,
  ResourceRef,
} from "@openclaw-enterprise/contracts";
import type { OpenClawController } from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface RequestContext {
  readonly actorId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly admissionDecisionId: string;
  readonly operation: OccApiRoute;
}

type ResourceHandler = (input: {
  readonly controller: OpenClawController;
  readonly context: RequestContext;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly params: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
  readonly namespaceId: string;
  // Build the event inside the handler's transaction, alongside the mutation.
  readonly mutationEvent: (resource: ResourceRef) => AuditEvent;
}) => Promise<void>;

export type ResourceHandlers = Readonly<Partial<Record<OccApiOperationId, ResourceHandler>>>;
