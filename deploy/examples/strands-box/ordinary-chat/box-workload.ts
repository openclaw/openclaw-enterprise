import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

const action = "BOX_WORKSPACE_REPRO_V1";
export const replyPrefix = "BOX_WORKSPACE_REPRO_SHA256 ";
export function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{48}$/.test(value);
}
export function promptFor(nonce: string): string {
  if (!isNonce(nonce)) throw Error("PROBE_NONCE_REFUSED");
  return `${action} ${nonce}: use the operator-approved workspace verifier.`;
}
export function answerFor(nonce: string, digest: string): string {
  return `${replyPrefix}${nonce} ${digest}`;
}
const verifier = "/opt/demo/verifier/oce-workspace-verifier";
const alternate = "--refused-alternate";
const deny = `strands-shell: effect denied: policy denied this operation on '${verifier}' [default-deny]: No permit policy matched this request.`;
const model = "gpt-5";
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {};
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
export function terminal(raw: unknown) {
  if (
    typeof raw !== "string" ||
    raw.length > 16384 ||
    /truncat|output omitted|tokens omitted/i.test(raw)
  )
    return;
  const lines = raw.split(/\r?\n/);
  const split = lines.indexOf("Output:");
  if (split < 2 || lines.lastIndexOf("Output:") !== split) return;
  const header = lines.slice(0, split).join("\n");
  if (
    !/^(?:Chunk ID: [a-f0-9]{1,64}\n)?Wall time: [0-9]+\.[0-9]{4} seconds\nProcess exited with code 0(?:\nOriginal token count: [0-9]{1,12})?$/.test(
      header,
    )
  )
    return;
  const body = lines.slice(split + 1).filter((line) => line !== "");
  const evidence = body.filter((line) => line !== deny);
  if (
    body.length !== 3 ||
    evidence.length !== 2 ||
    body.filter((line) => line === deny).length !== 1
  )
    return;
  const identity = /^OCE_BOX_MARKER_IDENTITY ([0-9]{1,10}) ([0-9]{1,20}) ([1-9][0-9]{0,19})$/.exec(
    evidence[0] ?? "",
  );
  const marker = /^OCE_BOX_MODEL_MARKER ([a-f0-9]{48})$/.exec(evidence[1] ?? "");
  const [, uid, device, inode] = identity ?? [];
  const [, content] = marker ?? [];
  if (uid === undefined || device === undefined || inode === undefined || content === undefined)
    return;
  return {
    markerSha256: sha(content + "\n"),
    uid: Number(uid),
    device,
    inode,
    shellAlternateDenied: true,
  };
}
function reply(res: ServerResponse, content: string | Obj) {
  const base = {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
  };
  const text =
    typeof content === "string"
      ? { type: "output_text", text: content, annotations: [] }
      : undefined;
  const item = text
    ? {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [text],
      }
    : content;
  const events: Obj[] = [
    { type: "response.created", response: { ...base, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: text ? { ...obj(item), status: "in_progress", content: [] } : item,
    },
  ];
  if (text)
    events.push(
      {
        type: "response.content_part.added",
        item_id: obj(item).id,
        output_index: 0,
        content_index: 0,
        part: { ...text, text: "" },
      },
      {
        type: "response.output_text.delta",
        item_id: obj(item).id,
        output_index: 0,
        content_index: 0,
        delta: text.text,
      },
      {
        type: "response.output_text.done",
        item_id: obj(item).id,
        output_index: 0,
        content_index: 0,
        text: text.text,
      },
      {
        type: "response.content_part.done",
        item_id: obj(item).id,
        output_index: 0,
        content_index: 0,
        part: text,
      },
    );
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...base, status: "completed", output: [item] } },
  );
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}
export function controlledModel(nonce: string, receipt: (row: Obj) => void) {
  return createServer(controlledModelRequests(nonce, receipt, { address: "127.0.0.1" }));
}

export function controlledModelRequests(
  nonce: string,
  receipt: (row: Obj) => void,
  peer: { readonly address: string; readonly authorization?: string },
) {
  const prompt = promptFor(nonce);
  let phase: "ready" | "sent" | "done" = "ready";
  const callId = `call_${randomUUID()}`;
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (
        req.socket.remoteAddress !== peer.address ||
        req.method !== "POST" ||
        req.url !== "/v1/responses" ||
        req.headers.authorization !== peer.authorization
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const bytes of req) {
        const chunk = Buffer.from(bytes);
        size += chunk.length;
        if (size > 524288) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = obj(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      if (body.model !== model || !Array.isArray(body.input)) {
        res.writeHead(422).end();
        return;
      }
      const input = body.input.map(obj);
      const userText = input
        .filter((item) => item.role === "user")
        .flatMap(({ content }) =>
          typeof content === "string"
            ? [content]
            : Array.isArray(content)
              ? content
                  .map(obj)
                  .flatMap((part) =>
                    part.type === "input_text" && typeof part.text === "string" ? [part.text] : [],
                  )
              : [],
        );
      const candidates = userText
        .flatMap((text) => text.split(/\r?\n/))
        .filter((line) => line.includes(action));
      // The native caller may prefix the user text with normal context; the
      // complete probe must still occur once, at the end of its line.
      if (
        candidates.length > 0 &&
        (candidates.length !== 1 ||
          (candidates[0] !== prompt && !candidates[0]?.endsWith(" " + prompt)) ||
          candidates[0]?.split(action).length !== 2)
      ) {
        res.writeHead(409).end();
        return;
      }
      const results = input.filter((item) => item.type === "function_call_output");
      if (results.length) {
        if (phase !== "sent" || results.length !== 1 || results[0]?.call_id !== callId) {
          res.writeHead(409).end();
          return;
        }
        phase = "done";
        const evidence = terminal(results[0].output);
        if (!evidence) {
          receipt({ stage: "tool_refused", nonce, callId });
          reply(res, "BOX_WORKSPACE_REPRO_FAILED");
          return;
        }
        const answer = answerFor(nonce, evidence.markerSha256);
        receipt({ stage: "tool_verified", nonce, callId, answer, ...evidence });
        reply(res, answer);
        return;
      }
      if (candidates.length === 0) {
        reply(res, "READY");
        return;
      }
      if (
        phase !== "ready" ||
        !Array.isArray(body.tools) ||
        !body.tools.some((tool) => obj(tool).name === "exec_command")
      ) {
        res.writeHead(409).end();
        return;
      }
      phase = "sent";
      receipt({ stage: "tool_intent", nonce, callId });
      reply(res, {
        id: `fc_${randomUUID()}`,
        type: "function_call",
        call_id: callId,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: `${verifier} ${alternate}; ${verifier}`,
          workdir: "/home/node/workspace",
          login: false,
          yield_time_ms: 10000,
          max_output_tokens: 1000,
        }),
      });
    } catch {
      if (!res.headersSent) res.writeHead(422).end();
      else res.destroy();
    }
  };
}
async function main() {
  const [nonce, codex, ...args] = process.argv.slice(2);
  const home = process.env.CODEX_HOME;
  if (
    !isNonce(nonce) ||
    !codex?.startsWith("/") ||
    !home?.startsWith("/") ||
    args.length !== 7 ||
    args[0] !== "app-server" ||
    args[1] !== "--listen" ||
    args[2] !== "ws://127.0.0.1:18790" ||
    args[3] !== "--ws-auth" ||
    args[4] !== "capability-token" ||
    args[5] !== "--ws-token-sha256" ||
    !/^[a-f0-9]{64}$/.test(args[6] ?? "")
  )
    throw Error("FIXTURE_ARGV_REFUSED");
  const receipt = (row: Obj) =>
    appendFileSync(join(home, "controlled-chat.jsonl"), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
  const server = controlledModel(nonce, receipt);
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(18949, "127.0.0.1", resolve);
  });
  try {
    const child = spawn(codex, args, { stdio: "ignore" });
    const ended = new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 1));
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      if (
        !child.pid ||
        readlinkSync(`/proc/${child.pid}/ns/net`) !== readlinkSync("/proc/self/ns/net")
      )
        throw Error("FIXTURE_NAMESPACE_REFUSED");
      receipt({ stage: "same_network_namespace", synthetic: true, nonce });
      process.exitCode = await ended;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
if (import.meta.main)
  await main().catch(() => {
    process.stderr.write("BOX_REPRO_FIXTURE_REFUSED\n");
    process.exitCode = 1;
  });
