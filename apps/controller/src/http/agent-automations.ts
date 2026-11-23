import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type GatewayClientOptions,
} from "@openclaw/gateway-client";
import type { OccApiRoute } from "@openclaw-enterprise/contracts";
import type { OpenClawController } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import type { FastifyReply, FastifyRequest } from "fastify";

import { dependencyUnavailable, failure } from "./errors.ts";

const methods = {
  createAgentAutomation: "cron.add",
  listAgentAutomations: "cron.list",
  getAgentAutomation: "cron.get",
  updateAgentAutomation: "cron.update",
  deleteAgentAutomation: "cron.remove",
  listAgentAutomationRuns: "cron.runs",
} as const;
type AutomationOperation = keyof typeof methods;
type Hello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

export function isAgentAutomationOperation(id: string): id is AutomationOperation {
  return Object.hasOwn(methods, id);
}

function unknownOutcome() {
  return failure(
    503,
    "UNKNOWN_OUTCOME",
    "The native cron mutation may have completed. Read its current state before retrying.",
  );
}

async function nativeRequest(
  endpoint: string,
  headers: Readonly<Record<string, string>>,
  method: (typeof methods)[AutomationOperation],
  mutation: boolean,
  params: (nativeAgentId: string) => Record<string, unknown>,
): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw dependencyUnavailable();
  }
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
    throw dependencyUnavailable();
  }
  const signal = AbortSignal.timeout(15_000);
  let resolveHello!: (hello: Hello) => void;
  let rejectHello!: (error: Error) => void;
  const connected = new Promise<Hello>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  void connected.catch(() => {});
  const client = new GatewayClient({
    url: url.href,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    deviceIdentity: null,
    scopes: [],
    edgeAuthHeaders: headers,
    hostDeps: { logError: () => {}, logDebug: () => {} },
    onHelloOk: resolveHello,
    onConnectError: () => rejectHello(new Error("Gateway connection failed.")),
    onClose: () => rejectHello(new Error("Gateway connection closed.")),
  });
  const abort = () => rejectHello(new Error("Gateway connection timed out."));
  signal.addEventListener("abort", abort, { once: true });
  let sent = false;
  try {
    client.start();
    const hello = await connected;
    const defaults = hello.snapshot.sessionDefaults;
    if (
      hello.auth?.role !== "operator" ||
      !hello.auth.scopes.includes("operator.admin") ||
      !hello.features.methods.includes(method) ||
      defaults?.ownership !== "sole" ||
      defaults.selectionRequired !== false ||
      typeof defaults.defaultAgentId !== "string" ||
      !defaults.defaultAgentId
    ) {
      throw dependencyUnavailable();
    }
    return await client.request(method, params(defaults.defaultAgentId), {
      signal,
      timeoutMs: 15_000,
      onSent: () => {
        sent = true;
      },
    });
  } catch (error) {
    if (error instanceof GatewayClientRequestError) {
      const code = asRecord(error.details)?.code;
      if (code === "CRON_JOB_CHANGED") {
        throw failure(409, "RESOURCE_CONFLICT", "The native cron job changed.");
      }
      if (code === "CRON_JOB_NOT_FOUND") {
        throw failure(404, "NOT_FOUND", "The native cron job was not found.");
      }
      if ((error.gatewayCode || error.code) === "INVALID_REQUEST") {
        throw failure(400, "INVALID_REQUEST", "OpenClaw rejected the cron request.");
      }
    }
    if (
      mutation &&
      (sent || (error instanceof GatewayClientRequestTimeoutError && error.requestSent))
    ) {
      throw unknownOutcome();
    }
    throw dependencyUnavailable();
  } finally {
    signal.removeEventListener("abort", abort);
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

export async function relayAgentAutomation(input: {
  controller: OpenClawController;
  installationId: string;
  actorId: string;
  operation: OccApiRoute;
  request: FastifyRequest;
  reply: FastifyReply;
  gatewayApiKey: (() => Promise<string>) | undefined;
  auditMutation: (reason?: string) => Promise<void>;
}): Promise<void> {
  const { controller, request, reply, operation } = input;
  const p = request.params as Record<string, string>;
  const q = request.query as Record<string, string | undefined>;
  const body = request.body as Record<string, unknown> | undefined;
  const selection = await controller.getAdministerableActiveAgentRevision(
    input.actorId,
    p.namespaceId!,
    p.agentId!,
  );
  if (selection.agent.desiredRuntimeState !== "running" || input.gatewayApiKey === undefined) {
    throw dependencyUnavailable();
  }
  const compute = controller.selectedDriver("compute");
  if (
    compute.id !== selection.revision.compute.id ||
    compute.implementation !== selection.revision.compute.implementation
  ) {
    throw dependencyUnavailable();
  }
  const transport = await compute.getGatewayBrowserRequest?.(
    selection.revision,
    { installationId: input.installationId, principalId: input.actorId, mode: "admin" },
    AbortSignal.timeout(15_000),
  );
  if (transport === undefined) {
    throw dependencyUnavailable();
  }
  const key = await input.gatewayApiKey();
  if (!key) {
    throw dependencyUnavailable();
  }
  const id = operation.operationId;
  if (!isAgentAutomationOperation(id)) {
    throw dependencyUnavailable();
  }
  const mutation =
    id === "createAgentAutomation" ||
    id === "updateAgentAutomation" ||
    id === "deleteAgentAutomation";
  const page = { offset: Number(q.offset ?? 0), limit: Number(q.limit ?? 100) };
  let result: unknown;
  try {
    result = await nativeRequest(
      transport.endpoint,
      { ...transport.headers, "x-api-key": key },
      methods[id],
      mutation,
      (nativeAgentId) => {
        switch (id) {
          case "createAgentAutomation":
            return {
              agentId: nativeAgentId,
              name: body!.name,
              enabled: body!.enabled,
              schedule: body!.schedule,
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: body!.prompt },
              delivery: { mode: "none" },
            };
          case "listAgentAutomations":
            return { includeDisabled: true, includeDeliveryPreviews: false, ...page };
          case "getAgentAutomation":
            return { id: p.automationId };
          case "updateAgentAutomation": {
            const patch = {
              ...(body!.name === undefined ? {} : { name: body!.name }),
              ...(body!.enabled === undefined ? {} : { enabled: body!.enabled }),
              ...(body!.schedule === undefined ? {} : { schedule: body!.schedule }),
              ...(body!.prompt === undefined
                ? {}
                : { payload: { kind: "agentTurn", message: body!.prompt } }),
            };
            return {
              id: p.automationId,
              patch,
              expectedConfigRevision: body!.expectedConfigRevision,
            };
          }
          case "deleteAgentAutomation":
            return { id: p.automationId, expectedConfigRevision: q.expectedConfigRevision };
          case "listAgentAutomationRuns":
            return { id: p.automationId, ...page };
        }
      },
    );
    if (id === "createAgentAutomation") {
      const acknowledgement = asRecord(result);
      const job = asRecord(acknowledgement?.job);
      if (acknowledgement?.created !== true || typeof job?.id !== "string" || !job.id) {
        throw unknownOutcome();
      }
      result = job;
    }
    if (!asRecord(result)) {
      throw mutation ? unknownOutcome() : dependencyUnavailable();
    }
    if (mutation) {
      if (id === "deleteAgentAutomation" && asRecord(result)?.removed !== true) {
        throw unknownOutcome();
      }
      try {
        await input.auditMutation();
      } catch {
        throw unknownOutcome();
      }
    }
  } catch (error) {
    if (mutation && asRecord(error)?.code === "UNKNOWN_OUTCOME") {
      await input.auditMutation("UNKNOWN_OUTCOME").catch(() => undefined);
    }
    throw error;
  }
  if (id === "deleteAgentAutomation") {
    reply.status(204).send();
    return;
  }
  reply
    .status(id === "createAgentAutomation" ? 201 : 200)
    .send({ data: result, meta: { requestId: request.id } });
}
