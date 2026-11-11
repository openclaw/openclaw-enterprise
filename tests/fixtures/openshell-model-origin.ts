import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import { isIP } from "node:net";
import { encodeSyntheticEvents, syntheticResponsesEvents } from "./synthetic-egress-provider.mjs";
import { createPreparedComputeEvents } from "./skipper-prepared-compute-model.mjs";

export type ModelHarness = "codex" | "openclaw";

export interface ModelOriginTurn {
  harness: ModelHarness;
  priorTurnId?: string;
  id: string;
  marker: string;
  answer: string;
}

export interface ModelOriginToolTurn {
  harness: "codex";
  id: string;
  marker: string;
  answer: string;
  command: string;
  expectedOutput: string;
  timeoutMs: number;
}

export type ModelOriginObservation =
  | {
      event: "request";
      kind: "probe" | "unmarked" | "rejected";
      harness?: ModelHarness;
      status: number;
      count: number;
    }
  | {
      event: "request";
      kind: "turn";
      harness: ModelHarness;
      status: 200;
      turnId: string;
      count: number;
      priorTurnObserved: boolean;
    }
  | {
      event: "request";
      kind: "tool";
      harness: "codex";
      status: 200;
      turnId: string;
      count: number;
      commandCount: number;
      pollCount: number;
      exitCode: number | null;
      completed: boolean;
      outputMatched: boolean;
    };

interface ModelOriginOptions {
  model: string;
  bearerDigests: Record<ModelHarness, string>;
  turns: readonly ModelOriginTurn[];
  tls?: ServerOptions;
  onObservation?: (observation: ModelOriginObservation) => void;
}

const maxRequestBytes = 1024 * 1024;
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const turnValue = /^OCE-MODEL-[A-Z0-9a-z-]{16,100}$/u;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isModelOriginTurn(value: unknown): value is ModelOriginTurn {
  const turn = object(value);
  return (
    (turn?.harness === "codex" || turn?.harness === "openclaw") &&
    (turn.priorTurnId === undefined || typeof turn.priorTurnId === "string") &&
    typeof turn.id === "string" &&
    typeof turn.marker === "string" &&
    typeof turn.answer === "string"
  );
}

function userInput(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  // A later turn in the same Gateway session includes earlier messages.
  const message = input
    .map(object)
    .reverse()
    .find((entry) => entry?.role === "user");
  if (typeof message?.content === "string") {
    return [message.content];
  }
  if (!Array.isArray(message?.content)) {
    return [];
  }
  return message.content.flatMap((entry: unknown) => {
    const part = object(entry);
    return part?.type === "input_text" && typeof part.text === "string" ? [part.text] : [];
  });
}

function includesAssistantReply(input: unknown, answer: string): boolean {
  return (
    Array.isArray(input) &&
    input.map(object).some((item) => {
      if (item?.role !== "assistant") {
        return false;
      }
      return (
        item.content === answer ||
        (Array.isArray(item.content) &&
          item.content.map(object).some((part) => part?.text === answer))
      );
    })
  );
}

/** Stand-in for the upstream OpenAI wire. Credentials, request bodies and answers
 * never appear in the origin's observations. Each installed turn has a unique ID. */
function createOpenShellModelOrigin(options: ModelOriginOptions) {
  const { model, bearerDigests, tls, onObservation } = options;
  const codexDigest = bearerDigests.codex;
  const openClawDigest = bearerDigests.openclaw;
  const turns = options.turns.map((turn) => ({ ...turn }));
  const values = turns.flatMap(({ marker, answer }) => [marker, answer]);
  if (
    !/^[A-Za-z0-9_.:/-]{1,128}$/u.test(model) ||
    !isDigest(codexDigest) ||
    !isDigest(openClawDigest) ||
    codexDigest === openClawDigest ||
    !turns.every(isModelOriginTurn) ||
    turns.some(
      ({ id, marker, answer, harness, priorTurnId }, index) =>
        !/^[a-z][a-z0-9-]{0,39}$/u.test(id) ||
        !turnValue.test(marker) ||
        !turnValue.test(answer) ||
        (priorTurnId !== undefined &&
          !turns
            .slice(0, index)
            .some((prior) => prior.id === priorTurnId && prior.harness === harness)),
    ) ||
    new Set(turns.map(({ id }) => id)).size !== turns.length ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Invalid model origin configuration.");
  }

  type ToolState = {
    turn: Readonly<ModelOriginToolTurn>;
    events: ReturnType<typeof createPreparedComputeEvents>;
    commandCount: number;
    pollCount: number;
    count: number;
    result?: Record<string, unknown>;
  };
  const toolTurns = new Map<string, ToolState>();
  const addToolTurn = (input: ModelOriginToolTurn) => {
    if (
      input.harness !== "codex" ||
      !/^[a-z][a-z0-9-]{0,39}$/u.test(input.id) ||
      !turnValue.test(input.marker) ||
      !turnValue.test(input.answer) ||
      input.marker === input.answer ||
      typeof input.command !== "string" ||
      input.command.length === 0 ||
      typeof input.expectedOutput !== "string" ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 170_000 ||
      turns.some((turn) => turn.id === input.id) ||
      toolTurns.has(input.id) ||
      [
        ...values,
        ...[...toolTurns.values()].flatMap(({ turn }) => [turn.marker, turn.answer]),
      ].some((value) => value === input.marker || value === input.answer)
    ) {
      throw new Error("Invalid model tool turn.");
    }
    const turn = Object.freeze({ ...input });
    const command = Object.freeze({
      id: turn.marker,
      cmd: turn.command,
      expectedOutput: turn.expectedOutput,
      expiresAt: Date.now() + turn.timeoutMs,
    });
    toolTurns.set(turn.id, {
      turn,
      events: createPreparedComputeEvents(() => command),
      commandCount: 0,
      pollCount: 0,
      count: 0,
    });
  };
  const counts = { probe: 0, unmarked: 0, rejected: 0 };
  const turnCounts = new Map(turns.map(({ id }) => [id, 0]));
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let harness: ModelHarness | undefined;
    function record(kind: "probe" | "unmarked" | "rejected", status: number) {
      response.once("finish", () => {
        const count = ++counts[kind];
        onObservation?.({ event: "request", kind, status, count, ...(harness && { harness }) });
      });
    }
    function reject(status: number, code: string, message: string, kind: "probe" | "rejected") {
      record(kind, status);
      response.writeHead(status, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end(JSON.stringify({ error: { code, message, type: "invalid_request_error" } }));
    }

    try {
      const bearer = /^Bearer (\S+)$/iu.exec(request.headers.authorization ?? "")?.[1];
      const digest = bearer && createHash("sha256").update(bearer).digest("hex");
      if (digest === codexDigest) {
        harness = "codex";
      } else if (digest === openClawDigest) {
        harness = "openclaw";
      } else {
        reject(401, "invalid_api_key", "Incorrect API key provided.", "rejected");
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        reject(404, "not_found", "Unknown model endpoint.", "rejected");
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) {
          reject(413, "invalid_request", "Model request is too large.", "rejected");
          return;
        }
        chunks.push(chunk);
      }
      let body: Record<string, unknown> | undefined;
      try {
        body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(400, "invalid_json", "Invalid model request JSON.", "rejected");
        return;
      }
      // Authenticate first, as OpenAI does for the wrapper's empty auth probe.
      if (body && Object.keys(body).length === 0) {
        reject(400, "missing_required_parameter", "Missing required parameter: 'model'.", "probe");
        return;
      }
      if (body?.model !== model) {
        reject(400, "model_not_found", "Unknown model.", "rejected");
        return;
      }
      const input = userInput(body.input);
      const matched = turns.filter(({ marker }) => input.some((text) => text.includes(marker)));
      const toolMatches = [...toolTurns.values()].filter(({ turn }) => {
        if (input.length > 0) {
          return input.some((text) => text.includes(turn.marker));
        }
        // Codex may continue with only the new function output. An unrelated
        // later user turn must not re-enter an earlier command from its history.
        return (
          Array.isArray(body.input) &&
          body.input
            .map(object)
            .some(
              (item) =>
                item?.type === "function_call_output" &&
                typeof item.call_id === "string" &&
                (item.call_id === turn.marker || item.call_id.startsWith(`${turn.marker}-wait-`)),
            )
        );
      });
      if (body.stream !== true || (input.length === 0 && toolMatches.length === 0)) {
        reject(400, "invalid_request", "Expected a streamed Responses request.", "rejected");
        return;
      }
      if (matched.length + toolMatches.length > 1) {
        reject(400, "invalid_request", "Ambiguous test turn.", "rejected");
        return;
      }
      const tool = toolMatches[0];
      if (tool) {
        if (harness !== "codex") {
          reject(401, "invalid_api_key", "Incorrect API key for this turn.", "rejected");
          return;
        }
        const hasResult =
          Array.isArray(body.input) &&
          body.input
            .map(object)
            .some(
              (item) =>
                item?.type === "function_call_output" &&
                typeof item.call_id === "string" &&
                (item.call_id === tool.turn.marker ||
                  item.call_id.startsWith(`${tool.turn.marker}-wait-`)),
            );
        if (tool.commandCount > 0 && !hasResult) {
          reject(
            400,
            "invalid_request",
            "A tool result is required before continuing this command.",
            "rejected",
          );
          return;
        }
        const events = tool.events({
          model,
          request: JSON.stringify(body),
          emit: (event: Record<string, unknown>) => {
            if (event.event === "skipper-native-request") {
              tool.commandCount++;
            } else if (event.event === "skipper-native-poll") {
              tool.pollCount++;
            } else if (event.event === "skipper-native-result") {
              tool.result = event;
            }
          },
          answerEvents: (selectedModel: string, answer: string) => {
            const result = tool.result;
            const completed =
              answer === `SKIPPER_COMPUTE_DONE_${tool.turn.marker}` &&
              result?.status === "completed" &&
              result.exitCode === 0 &&
              result.markerSeen === true &&
              result.outputMatched === true &&
              tool.commandCount === 1;
            const exitCode = result?.exitCode;
            response.once("finish", () => {
              onObservation?.({
                event: "request",
                kind: "tool",
                harness: "codex",
                status: 200,
                turnId: tool.turn.id,
                count: ++tool.count,
                commandCount: tool.commandCount,
                pollCount: tool.pollCount,
                exitCode: typeof exitCode === "number" ? exitCode : null,
                completed,
                outputMatched: result?.outputMatched === true,
              });
            });
            return syntheticResponsesEvents(
              selectedModel,
              completed ? tool.turn.answer : "OCE_TOOL_INCOMPLETE",
            );
          },
        });
        if (events === undefined) {
          reject(400, "invalid_request", "Unrecognized model tool turn.", "rejected");
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end(encodeSyntheticEvents(events));
        return;
      }
      const turn = matched[0];
      if (turn && turn.harness !== harness) {
        reject(401, "invalid_api_key", "Incorrect API key for this turn.", "rejected");
        return;
      }
      const prior = turns.find(({ id }) => id === turn?.priorTurnId);
      const priorTurnObserved =
        prior !== undefined && includesAssistantReply(body.input, prior.answer);
      if (prior && !priorTurnObserved) {
        reject(400, "invalid_request", "Missing previous assistant reply.", "rejected");
        return;
      }
      const stream = encodeSyntheticEvents(
        syntheticResponsesEvents(model, turn?.answer ?? "READY"),
      );
      if (turn === undefined) {
        record("unmarked", 200);
      } else {
        response.once("finish", () => {
          const count = (turnCounts.get(turn.id) ?? 0) + 1;
          turnCounts.set(turn.id, count);
          onObservation?.({
            event: "request",
            kind: "turn",
            harness: turn.harness,
            status: 200,
            turnId: turn.id,
            count,
            priorTurnObserved,
          });
        });
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(stream);
    } catch {
      if (response.headersSent) {
        response.destroy();
      } else if (!response.destroyed) {
        reject(500, "fixture_error", "Model fixture could not process the request.", "rejected");
      }
    }
  };

  const server = tls === undefined ? createHttpServer(handle) : createHttpsServer(tls, handle);
  server.requestTimeout = 30_000;
  server.headersTimeout = 5_000;
  return { server, addToolTurn };
}

/** Start the controlled upstream on the installation fixture's owned host address. */
export async function startOpenShellModelOrigin(
  options: ModelOriginOptions & { host: string; port: number },
) {
  const { host, port } = options;
  if (isIP(host) === 0 || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Invalid model origin listener.");
  }
  const { server, addToolTurn } = createOpenShellModelOrigin(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Model origin did not open a TCP listener.");
  }
  const hostname = isIP(address.address) === 6 ? `[${address.address}]` : address.address;
  return {
    origin: `${options.tls === undefined ? "http" : "https"}://${hostname}:${address.port}`,
    addToolTurn,
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      });
    },
  };
}
