import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { runtimeAuditReference } from "@openclaw-enterprise/audit";
import {
  AGENT_AUDIT_MESSAGE_BYTES,
  type AgentRevision,
  type ComputeDriver,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { auditMessageRoute, AUDIT_MESSAGE_SCOPE } from "./audit-message-route.ts";
import { privateGatewayUrl, withPrivateGatewayClient } from "./private-client.ts";

interface MessageIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messageId: string;
}

interface AuditMessageRead extends MessageIdentity {
  readonly computeDriver: ComputeDriver | undefined;
  readonly revision: AgentRevision;
  readonly gatewayApiKey: (() => Promise<string>) | undefined;
  readonly signal?: AbortSignal;
}

const MAX_ACTIVE_READS = 4;
const MESSAGE_READ_TIMEOUT_MS = 5_000;
let activeReads = 0;

function unavailable(): Error {
  return new DependencyUnavailableError("The Agent chat message lookup is unavailable.");
}

function readText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    const block = asRecord(part);
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function projectMessage(result: unknown, { turnId, messageId }: MessageIdentity) {
  const response = asRecord(result);
  if (response?.ok === false) {
    return undefined;
  }
  const message = asRecord(response?.message);
  const metadata = asRecord(message?.__openclaw);
  if (response?.ok !== true || !message || metadata?.id !== messageId) {
    throw unavailable();
  }
  let runId = metadata.runId;
  const key = message.idempotencyKey;
  if (runId === undefined && typeof key === "string" && key.endsWith(":user")) {
    runId = key.slice(0, -":user".length);
  }
  const belongsToTurn = typeof runId === "string" && runtimeAuditReference(runId) === turnId;
  if (message.role !== "user" || !belongsToTurn || metadata.truncated === true) {
    return undefined;
  }
  const text = readText(message.content);
  if (text === undefined || Buffer.byteLength(text) > AGENT_AUDIT_MESSAGE_BYTES) {
    return undefined;
  }
  return { role: "user" as const, text };
}

/** Resolve IDs from an authorized audit row against the serving revision's chat history. */
export async function readAgentAuditMessage(input: AuditMessageRead) {
  const { computeDriver, revision, gatewayApiKey, sessionId, messageId } = input;
  if (
    runtimeAuditReference(sessionId) !== sessionId ||
    runtimeAuditReference(messageId) !== messageId
  ) {
    return undefined;
  }
  if (
    activeReads >= MAX_ACTIVE_READS ||
    !gatewayApiKey ||
    !computeDriver?.getGatewayEndpoint ||
    computeDriver.id !== revision.compute.id ||
    computeDriver.implementation !== revision.compute.implementation
  ) {
    throw unavailable();
  }
  activeReads++;
  try {
    const url = privateGatewayUrl(computeDriver.getGatewayEndpoint(revision) ?? "");
    url.pathname = auditMessageRoute(revision);
    const deadline = AbortSignal.timeout(MESSAGE_READ_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const apiKey = await gatewayApiKey();
    return await withPrivateGatewayClient(url.href, apiKey, signal, async (client, { auth }) => {
      if (
        auth?.role !== "operator" ||
        auth.scopes.length !== 1 ||
        auth.scopes[0] !== AUDIT_MESSAGE_SCOPE
      ) {
        throw unavailable();
      }
      const session = asRecord(await client.request("sessions.resolve", { sessionId }, { signal }));
      if (session?.ok === false) {
        return undefined;
      }
      if (session?.ok !== true || !isNonEmptyString(session.key)) {
        throw unavailable();
      }
      const message = await client.request(
        "chat.message.get",
        // Passing the physical session ID guards against a later reset of the same session key.
        { sessionKey: session.key, sessionId, messageId, maxChars: AGENT_AUDIT_MESSAGE_BYTES + 1 },
        { signal },
      );
      return projectMessage(message, input);
    });
  } catch (error) {
    // sessions.resolve uses INVALID_REQUEST for a deleted or inaccessible session.
    if (
      error instanceof GatewayClientRequestError &&
      ["INVALID_REQUEST", "FORBIDDEN", "NOT_FOUND"].includes(error.gatewayCode || error.code)
    ) {
      return undefined;
    }
    // Never include Gateway errors, session keys or message text in controller diagnostics.
    throw unavailable();
  } finally {
    activeReads--;
  }
}
