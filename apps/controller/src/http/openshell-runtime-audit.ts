import { timingSafeEqual } from "node:crypto";

import type { PostgresPlatformState } from "@openclaw-enterprise/occ";
import type { FastifyInstance } from "fastify";

import { createOpenShellAuditDecoder, OPENSHELL_AUDIT_BYTES } from "./openshell-network-audit.ts";
import { failure } from "./errors.ts";
import { auditEvidence, requirePrivateAuditListener } from "./runtime-audit.ts";

export interface OpenShellRuntimeAuditOptions {
  readonly headers: string;
  readonly writer: Pick<PostgresPlatformState, "appendSandboxRuntimeAudit">;
}

export function registerOpenShellRuntimeAudit(
  app: FastifyInstance,
  options: OpenShellRuntimeAuditOptions,
) {
  const authorization = /^authorization=(Bearer [A-Za-z0-9_-]{43})\n?$/.exec(options.headers)?.[1];
  if (authorization === undefined) {
    throw new Error("The OpenShell audit exporter headers file is invalid.");
  }
  const expected = Buffer.from(authorization);
  const decode = createOpenShellAuditDecoder();
  const protobuf = "application/x-protobuf";
  app.register(async (receiver) => {
    receiver.removeAllContentTypeParsers();
    receiver.addContentTypeParser(
      protobuf,
      { parseAs: "buffer", bodyLimit: OPENSHELL_AUDIT_BYTES },
      (_request, body, done) => done(null, body),
    );
    receiver.post<{ Body: Buffer }>(
      "/internal/openshell-audit/v1/logs",
      {
        bodyLimit: OPENSHELL_AUDIT_BYTES,
        schema: { hide: true },
        onRequest: async (request) => {
          await requirePrivateAuditListener(request);
          const supplied = Buffer.from(request.headers.authorization ?? "");
          if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
            throw failure(401, "UNAUTHENTICATED", "An OpenShell exporter credential is required.");
          }
        },
      },
      async (request, reply) => {
        let observations;
        try {
          observations = decode(request.body);
        } catch {
          throw failure(400, "INVALID_REQUEST", "The OpenShell audit batch is invalid.");
        }
        const sandbox = observations[0]?.sandboxId;
        if (sandbox !== undefined) {
          await options.writer.appendSandboxRuntimeAudit(sandbox, (installationId, owner) =>
            observations.map((event) =>
              auditEvidence(installationId, { ...owner, runtimeSource: "openshell" }, event),
            ),
          );
        }
        // An empty protobuf ExportLogsServiceResponse acknowledges the batch.
        return reply.type(protobuf).send(Buffer.alloc(0));
      },
    );
  });
}
