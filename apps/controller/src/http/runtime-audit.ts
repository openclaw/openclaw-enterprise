import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { AuditEventFactory, redactAuditDetails } from "@openclaw-enterprise/audit";
import {
  RUNTIME_AUDIT_ACTIONS,
  RUNTIME_AUDIT_DETAIL_SCHEMAS,
  RUNTIME_AUDIT_REASON_LIMIT,
  runtimeAuditObservationSchema,
  type RuntimeAuditAction,
  type RuntimeAuditObservation,
  type RuntimeAuditSource,
} from "@openclaw-enterprise/contracts";
import type { OpenClawController } from "@openclaw-enterprise/occ";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { failure } from "./errors.ts";
import { createOpenShellAuditDecoder, OPENSHELL_AUDIT_BYTES } from "./openshell-runtime-audit.ts";

const grantProperties = {
  tokenDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  namespaceId: Type.String({ minLength: 1, maxLength: 200 }),
  agentId: Type.String({ minLength: 1, maxLength: 200 }),
  agentRevisionId: Type.String({ minLength: 1, maxLength: 200 }),
};
const grantSchema = Type.Object(
  {
    ...grantProperties,
    runtimeSource: Type.Union([Type.Literal("openclaw"), Type.Literal("codex")]),
  },
  { additionalProperties: false },
);
const openShellGrantSchema = Type.Object(
  {
    ...grantProperties,
    runtimeSource: Type.Literal("openshell"),
    openshellSandboxId: Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    }),
  },
  { additionalProperties: false },
);
const grantFileSchema = Type.Array(Type.Union([grantSchema, openShellGrantSchema]), {
  minItems: 1,
  maxItems: 1000,
});

type HarnessGrant = Omit<Static<typeof grantSchema>, "tokenDigest">;
type Grant = Omit<HarnessGrant, "runtimeSource"> & { readonly runtimeSource: RuntimeAuditSource };
type OpenShellGrants = ReadonlyMap<string, Grant>;

export type RuntimeAuditAdmission = {
  (authorization: string | undefined): HarnessGrant | undefined;
  readonly admitOpenShell?: (authorization: string | undefined) => OpenShellGrants | undefined;
};

function credentialDigest(authorization: string | undefined): string | undefined {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  return token === undefined ? undefined : createHash("sha256").update(token).digest("hex");
}

export async function loadRuntimeAuditAdmission(path: string): Promise<RuntimeAuditAdmission> {
  if (!isAbsolute(path)) {
    throw new Error("OCC_RUNTIME_AUDIT_GRANTS_PATH must be an absolute path.");
  }
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Cannot read the runtime audit grants file.");
  }
  if (!Check(grantFileSchema, document)) {
    throw new Error("The runtime audit grants file is invalid.");
  }
  const grants = new Map<string, HarnessGrant>();
  const openShellGrants = new Map<string, Map<string, Grant>>();
  const enrolledSandboxes = new Set<string>();
  for (const { tokenDigest, ...grant } of document) {
    if ("openshellSandboxId" in grant) {
      const { openshellSandboxId, ...scope } = grant;
      if (enrolledSandboxes.has(openshellSandboxId)) {
        throw new Error("An OpenShell Sandbox UUID has more than one runtime audit grant.");
      }
      enrolledSandboxes.add(openshellSandboxId);
      const sandboxes = openShellGrants.get(tokenDigest) ?? new Map<string, Grant>();
      sandboxes.set(openshellSandboxId, Object.freeze(scope));
      openShellGrants.set(tokenDigest, sandboxes);
      continue;
    }
    if (grants.has(tokenDigest)) {
      throw new Error("A runtime audit credential has more than one grant.");
    }
    grants.set(tokenDigest, Object.freeze(grant));
  }
  for (const digest of openShellGrants.keys()) {
    if (grants.has(digest)) {
      throw new Error(
        "An OpenShell exporter credential is also a scoped runtime audit credential.",
      );
    }
  }
  const admit = (authorization: string | undefined) => {
    const digest = credentialDigest(authorization);
    return digest === undefined ? undefined : grants.get(digest);
  };
  if (openShellGrants.size === 0) {
    return admit;
  }
  return Object.assign(admit, {
    admitOpenShell: (authorization: string | undefined) => {
      const digest = credentialDigest(authorization);
      return digest === undefined ? undefined : openShellGrants.get(digest);
    },
  });
}

function parseObservation(
  body: unknown,
  runtimeSource: RuntimeAuditSource,
): RuntimeAuditObservation {
  if (body === null || typeof body !== "object" || !("action" in body)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit event is invalid.");
  }
  const { action } = body;
  if (typeof action !== "string" || !Object.hasOwn(RUNTIME_AUDIT_DETAIL_SCHEMAS, action)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit action is invalid.");
  }
  const isNetwork = action === RUNTIME_AUDIT_ACTIONS.networkDecision;
  if (isNetwork !== (runtimeSource === "openshell")) {
    throw failure(403, "FORBIDDEN", "The source cannot publish this audit action.");
  }
  if (!Check(runtimeAuditObservationSchema(action as RuntimeAuditAction), body)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit event is invalid.");
  }
  const event = body as RuntimeAuditObservation;
  const time = new Date(event.occurredAt);
  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString() !== event.occurredAt ||
    time.getTime() > Date.now() + 60_000
  ) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit timestamp is invalid.");
  }
  if (
    (event.action === RUNTIME_AUDIT_ACTIONS.turnCompleted &&
      event.blockedBy !== undefined &&
      event.outcome !== "blocked") ||
    ("messageId" in event && event.messageId !== undefined && event.sessionId === undefined)
  ) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit context is invalid.");
  }
  return event;
}

function auditId(installationId: string, grant: Grant, eventId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([installationId, grant.agentRevisionId, grant.runtimeSource, eventId]))
    .digest("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 3) | 8).toString(16);
  return `aud_${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function auditEvidence(installationId: string, grant: Grant, event: RuntimeAuditObservation) {
  const { action, eventId, occurredAt, ...details } = event;
  const result =
    "outcome" in event ? event.outcome : "decision" in event ? event.decision : undefined;
  const outcome =
    result === "denied" || result === "blocked"
      ? "denied"
      : result === undefined || result === "allowed" || result === "ask" || result === "succeeded"
        ? "success"
        : "failure";

  const factory = new AuditEventFactory({
    clock: () => occurredAt,
    idGenerator: () => auditId(installationId, grant, eventId),
  });
  const evidence = factory.create({
    installationId,
    namespaceId: grant.namespaceId,
    kind: "runtime_activity",
    source: grant.runtimeSource,
    action,
    actor: { unresolved: true },
    resource: { kind: "agent", id: grant.agentId, namespaceId: grant.namespaceId },
    outcome,
    details: {
      ...details,
      ...("reason" in details && typeof details.reason === "string"
        ? { reason: auditReason(details.reason) }
        : {}),
      ...("rationale" in details && typeof details.rationale === "string"
        ? { rationale: auditReason(details.rationale) }
        : {}),
      agentRevisionId: grant.agentRevisionId,
      runtimeSource: grant.runtimeSource,
    },
  });
  if (!Check(RUNTIME_AUDIT_DETAIL_SCHEMAS[action], evidence.details)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit metadata is invalid.");
  }
  return evidence;
}

async function recordBatch(
  controller: OpenClawController,
  observations: readonly { grant: Grant; event: RuntimeAuditObservation }[],
): Promise<void> {
  if (observations.length === 0) {
    return;
  }
  await controller.transact(async (unit) => {
    const checked = new Set<Grant>();
    for (const { grant, event } of observations) {
      if (!checked.has(grant)) {
        const revision = await unit.revisions.findRevision(
          grant.namespaceId,
          grant.agentId,
          grant.agentRevisionId,
        );
        const agent = await unit.agents.findAgent(grant.namespaceId, grant.agentId);
        if (
          revision === undefined ||
          agent === undefined ||
          agent.status === "deleting" ||
          agent.servicePrincipalId !== revision.servicePrincipalId ||
          (grant.runtimeSource !== "openshell" && revision.harness.id !== grant.runtimeSource)
        ) {
          throw failure(
            403,
            "FORBIDDEN",
            "The runtime audit grant no longer has an Agent revision.",
          );
        }
        checked.add(grant);
      }
      await unit.audit.append(auditEvidence(controller.installation.id, grant, event));
    }
  });
}

function auditReason(reason: string): string {
  const safe = redactAuditDetails(reason);
  return [...(safe as string)].slice(0, RUNTIME_AUDIT_REASON_LIMIT).join("");
}

export function registerRuntimeAudit(
  app: FastifyInstance,
  admit: RuntimeAuditAdmission,
  getController: () => OpenClawController | undefined,
): void {
  const admittedRequests = new WeakMap<FastifyRequest, Grant>();
  app.post(
    "/internal/runtime-audit",
    {
      bodyLimit: 4096,
      onRequest: async (request) => {
        const grant = admit(request.headers.authorization);
        if (grant === undefined) {
          throw failure(401, "UNAUTHENTICATED", "A runtime audit credential is required.");
        }
        if (request.headers["x-openclaw-runtime-audit-source"] !== grant.runtimeSource) {
          throw failure(
            403,
            "FORBIDDEN",
            "The runtime audit credential does not match the source.",
          );
        }
        admittedRequests.set(request, grant);
      },
    },
    async (request, reply) => {
      const grant = admittedRequests.get(request);
      const controller = getController();
      if (grant === undefined || controller === undefined) {
        throw failure(503, "DEPENDENCY_UNAVAILABLE", "The runtime audit writer is unavailable.");
      }
      const event = parseObservation(request.body, grant.runtimeSource);
      await recordBatch(controller, [{ grant, event }]);
      await reply.code(204).send();
    },
  );
  if (admit.admitOpenShell !== undefined) {
    registerOpenShellRuntimeAudit(app, admit.admitOpenShell, getController);
  }
}

function registerOpenShellRuntimeAudit(
  app: FastifyInstance,
  admit: NonNullable<RuntimeAuditAdmission["admitOpenShell"]>,
  getController: () => OpenClawController | undefined,
): void {
  const decode = createOpenShellAuditDecoder();
  const admittedRequests = new WeakMap<FastifyRequest, OpenShellGrants>();
  app.register(async (instance) => {
    instance.addContentTypeParser(
      "application/x-protobuf",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );
    instance.post<{ Body: Buffer }>(
      "/internal/runtime-audit/openshell/v1/logs",
      {
        bodyLimit: OPENSHELL_AUDIT_BYTES,
        onRequest: async (request) => {
          const grants = admit(request.headers.authorization);
          if (grants === undefined) {
            throw failure(401, "UNAUTHENTICATED", "An OpenShell exporter credential is required.");
          }
          const encoding = request.headers["content-encoding"];
          if (
            request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
              "application/x-protobuf" ||
            (encoding !== undefined && encoding !== "identity")
          ) {
            throw failure(
              415,
              "UNSUPPORTED_MEDIA_TYPE",
              "An uncompressed OTLP protobuf batch is required.",
            );
          }
          admittedRequests.set(request, grants);
        },
      },
      async (request, reply) => {
        const grants = admittedRequests.get(request);
        const controller = getController();
        if (grants === undefined || controller === undefined) {
          throw failure(503, "DEPENDENCY_UNAVAILABLE", "The runtime audit writer is unavailable.");
        }
        const observations = decode(request.body, (sandboxId) => grants.has(sandboxId)).map(
          ({ sandboxId, event }) => ({
            grant: grants.get(sandboxId)!,
            event: parseObservation(event, "openshell"),
          }),
        );
        await recordBatch(controller, observations);
        // An empty protobuf message is a successful OTLP ExportLogsServiceResponse.
        await reply.code(200).type("application/x-protobuf").send(Buffer.alloc(0));
      },
    );
  });
}
