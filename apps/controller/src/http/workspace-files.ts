import type { AuditSink } from "@openclaw-enterprise/audit";
import type { OccApiRoute, UpdateWorkspaceFileBody } from "@openclaw-enterprise/contracts";
import { NoActiveAgentRevisionError } from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  ControllerWorkspaceFileUnknownOutcomeError,
  isAllowedWorkspaceFileName,
  type ControllerWorkspaceFileReadResult,
  type ControllerWorkspaceFilesAccess,
  type ControllerWorkspaceFileWriteResult,
} from "../gateway/contracts.ts";
import type { ErrorDetail } from "./error-details.ts";
import { dependencyUnavailable, failure, workspaceWithoutRunningVersion } from "./errors.ts";
import type { ResourceHandler, ResourceHandlers } from "./types.ts";

const WORKSPACE_FILE_CONTENT_LIMIT = 16 * 1024;
// 16 KiB of content may need six bytes per UTF-8 byte in JSON (`\u0001`), plus `{"content":""}`.
export const WORKSPACE_FILE_BODY_LIMIT = 6 * WORKSPACE_FILE_CONTENT_LIMIT + 1024;

interface WorkspaceFileHandlerOptions {
  readonly access: ControllerWorkspaceFilesAccess | undefined;
  readonly timeoutMs: number;
  readonly auditSink: AuditSink;
  readonly requireCsrf: (request: FastifyRequest, requireOrigin: boolean) => void;
  readonly isAuditManaged: (request: FastifyRequest) => boolean;
  readonly logAuditFailure: (
    request: FastifyRequest,
    operation: OccApiRoute,
    error: unknown,
  ) => void;
}

type WorkspaceFileWriteFailure = "DEPENDENCY_UNAVAILABLE" | "FILE_MISSING" | "UNKNOWN_OUTCOME";

function workspaceFileRequestSignal(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = (message: string) => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(message));
    }
  };
  const timeout = setTimeout(
    () => abort(`The workspace file request exceeded its ${timeoutMs}ms deadline.`),
    timeoutMs,
  );
  timeout.unref?.();
  const onRequestAborted = () =>
    abort("The HTTP client disconnected before the workspace file request completed.");
  const onReplyClosed = () => {
    if (!reply.raw.writableEnded) {
      abort("The HTTP client disconnected before the workspace file request completed.");
    }
  };
  if (request.raw.aborted || reply.raw.destroyed) {
    abort("The HTTP client disconnected before the workspace file request.");
  }
  request.raw.once("aborted", onRequestAborted);
  reply.raw.once("close", onReplyClosed);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      request.raw.off("aborted", onRequestAborted);
      reply.raw.off("close", onReplyClosed);
    },
  };
}

async function withWorkspaceFileRequestSignal<T>(
  signal: AbortSignal,
  operation: Promise<T>,
  abortError: () => Error = dependencyUnavailable,
): Promise<T> {
  if (signal.aborted) {
    // The operation has already started; observe any rejection after the HTTP deadline.
    void operation.catch(() => {});
    throw abortError();
  }
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
  }
}

function hasInvalidWorkspaceFileText(content: string): boolean {
  const isWellFormed = (String.prototype as unknown as { isWellFormed: (this: string) => boolean })
    .isWellFormed;
  return content.includes("\u0000") || !isWellFormed.call(content);
}

function validateWorkspaceFileBody(body: UpdateWorkspaceFileBody): void {
  const details: ErrorDetail[] = [];
  if (Buffer.byteLength(body.content, "utf8") > WORKSPACE_FILE_CONTENT_LIMIT) {
    details.push({ path: "/content", code: "TOO_LONG" });
  }
  if (hasInvalidWorkspaceFileText(body.content)) {
    details.push({ path: "/content", code: "INVALID_VALUE" });
  }
  if (details.length > 0) {
    throw failure(
      400,
      "INVALID_REQUEST",
      "The request does not match the operation contract.",
      details,
    );
  }
}

function workspaceFileNotFound() {
  return failure(404, "NOT_FOUND", "The requested workspace file was not found.");
}

export function createWorkspaceFileHandlers(
  options: WorkspaceFileHandlerOptions,
): ResourceHandlers {
  const handleWorkspaceFile: ResourceHandler = async ({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) => {
    const agentId = params.agentId;
    if (!agentId) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }

    const { operation } = context;
    const writing = operation.operationId === "putAgentWorkspaceFile";
    const { timeoutMs } = options;
    const { signal, dispose } = workspaceFileRequestSignal(request, reply, timeoutMs);
    const deadline = new Date(Date.now() + timeoutMs);
    try {
      options.requireCsrf(request, writing);
      const filename = params.name;
      if (filename === undefined || !isAllowedWorkspaceFileName(filename)) {
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      }
      if (signal.aborted) {
        throw dependencyUnavailable();
      }
      const { agent, revision } = await withWorkspaceFileRequestSignal(
        signal,
        writing
          ? controller.getOperableActiveAgentRevision(context.actorId, namespaceId, agentId)
          : controller.getReadableActiveAgentRevision(context.actorId, namespaceId, agentId),
      ).catch((error: unknown) => {
        // Only a caller who passed Agent authorization may learn that the Agent has no running version.
        throw error instanceof NoActiveAgentRevisionError
          ? workspaceWithoutRunningVersion(agentId, error.stopped)
          : error;
      });
      // Authorize before disclosing whether workspace access is configured.
      const { access } = options;
      if (access === undefined || signal.aborted) {
        throw dependencyUnavailable();
      }

      if (!writing) {
        let result: ControllerWorkspaceFileReadResult;
        try {
          if (signal.aborted) {
            throw dependencyUnavailable();
          }
          result = await withWorkspaceFileRequestSignal(
            signal,
            access.read({ revision, filename, signal, deadline }),
          );
        } catch {
          throw dependencyUnavailable();
        }
        if (result.status === "missing") {
          throw workspaceFileNotFound();
        }
        if (
          result.status === "unavailable" ||
          Buffer.byteLength(result.file.content, "utf8") > WORKSPACE_FILE_CONTENT_LIMIT ||
          hasInvalidWorkspaceFileText(result.file.content)
        ) {
          throw dependencyUnavailable();
        }
        reply.send({
          data: { name: filename, content: result.file.content },
          meta: { requestId: request.id },
        });
        return;
      }

      const writeBody = body as UpdateWorkspaceFileBody;
      validateWorkspaceFileBody(writeBody);
      const target = { kind: "agent" as const, id: agent.id, namespaceId: agent.namespaceId };
      const appendWriteAudit = async (
        reasonCode?: WorkspaceFileWriteFailure,
        onAbort?: () => Error,
      ): Promise<void> => {
        const audit = mutationEvent(
          target,
          { workspaceFileName: filename },
          undefined,
          reasonCode === undefined ? undefined : { reasonCode },
        );
        try {
          await withWorkspaceFileRequestSignal(signal, options.auditSink.append(audit), onAbort);
        } catch (error) {
          if (options.isAuditManaged(request)) {
            options.logAuditFailure(request, operation, error);
          }
          throw error;
        }
      };
      let result: ControllerWorkspaceFileWriteResult;
      try {
        if (signal.aborted) {
          throw dependencyUnavailable();
        }
        result = await withWorkspaceFileRequestSignal(
          signal,
          access.write({ revision, filename, content: writeBody.content, signal, deadline }),
          () =>
            new ControllerWorkspaceFileUnknownOutcomeError(
              "The workspace file write reached the OCC request deadline before the controller observed its outcome.",
            ),
        );
      } catch (error) {
        if (error instanceof ControllerWorkspaceFileUnknownOutcomeError) {
          await appendWriteAudit(
            "UNKNOWN_OUTCOME",
            () => new ControllerWorkspaceFileUnknownOutcomeError(error.message),
          ).catch(() => {});
          throw failure(503, "UNKNOWN_OUTCOME", error.message);
        }
        result = { status: "unavailable" };
      }
      if (result.status === "missing") {
        try {
          await appendWriteAudit("FILE_MISSING");
        } catch {
          if (!options.isAuditManaged(request)) {
            throw dependencyUnavailable();
          }
        }
        throw workspaceFileNotFound();
      }
      if (result.status === "unavailable") {
        await appendWriteAudit("DEPENDENCY_UNAVAILABLE").catch(() => {});
        throw dependencyUnavailable();
      }
      try {
        await appendWriteAudit(
          undefined,
          () =>
            new ControllerWorkspaceFileUnknownOutcomeError(
              "The workspace file was written, but its final audit outcome could not be persisted before the request ended.",
            ),
        );
      } catch {
        throw failure(
          503,
          "UNKNOWN_OUTCOME",
          "The workspace file was written, but its final audit outcome could not be persisted.",
        );
      }
      reply.send({
        data: { name: filename, size: Buffer.byteLength(writeBody.content, "utf8") },
        meta: { requestId: request.id },
      });
    } finally {
      dispose();
    }
  };

  return {
    getAgentWorkspaceFile: handleWorkspaceFile,
    putAgentWorkspaceFile: handleWorkspaceFile,
  };
}
