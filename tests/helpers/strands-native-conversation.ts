import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import {
  cleanEnvironment,
  listen,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

import { harnessTlsFixture } from "./harness-tls.mjs";

interface Turn {
  id: string;
  status: string;
  items: { type: string; text?: string }[];
}
interface Message {
  id?: number;
  method?: string;
  error?: unknown;
  result?: { thread: { id: string; turns: Turn[] }; turn: Turn };
  params?: { threadId: string; turn: Turn };
}

// Native Codex and its session are real. Only the HTTPS inference origin is controlled.
// This is a sender rehearsal, not the Box launcher or an installed OCC deployment.
export async function strandsNativeConversation(t: TestContext, executable: string) {
  let dispose = async () => {};
  // Stop the process before earlier-acquired server and file cleanup hooks run.
  t.after(() => dispose());
  const directory = await temporaryDirectory(t, "strands-conversation-");
  const tls = await harnessTlsFixture(t);
  const { responseEvents } = JSON.parse(
    await readFile(
      new URL("../fixtures/static-egress/codex-responses.json", import.meta.url),
      "utf8",
    ),
  );
  const nonce = randomUUID();
  const credential = "fixture-" + nonce;
  let phase: "before" | "after" = "before";
  let requests = 0;
  let providerError: unknown;
  const answer = () => phase + "-answer-" + nonce;
  const provider = createServer(tls, (req, res) => {
    void (async () => {
      if (req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await text(req));
      assert.equal(req.headers.authorization, "Bearer " + credential);
      assert.equal(body.model, "fixture-model");
      assert.ok(JSON.stringify(body.input.at(-1)).includes(phase + "-question"));
      if (phase === "after") {
        assert.ok(
          JSON.stringify(body.input).includes("before-answer-" + nonce),
          "second model request retains the first reply",
        );
      }
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of responseEvents) {
        res.write(
          "data: " +
            JSON.stringify(event)
              .replaceAll("READY", answer())
              .replaceAll("runtime_probe", "strands_" + requests) +
            "\n\n",
        );
      }
      res.end();
    })().catch((error: unknown) => {
      providerError = error;
      res.destroy();
    });
  });
  let connections = 0;
  provider.on("connection", () => {
    connections++;
  });
  provider.on("tlsClientError", (error) => {
    providerError = error;
  });
  const origin = (await listen(t, provider)).replace("127.0.0.1", "localhost");
  const home = join(directory, "home");
  await mkdir(home);
  await writeFile(
    join(home, "config.toml"),
    `model = "fixture-model"
model_provider = "rehearsal"
[model_providers.rehearsal]
name = "Controlled rehearsal"
base_url = "${origin}/v1"
wire_api = "responses"
env_key = "REHEARSAL_MODEL_KEY"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
log_user_prompt = false
`,
  );
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd: directory,
    env: cleanEnvironment({
      HOME: directory,
      CODEX_HOME: home,
      TMPDIR: directory,
      SSL_CERT_FILE: tls.rootCertificatePath,
      CODEX_CA_CERTIFICATE: tls.rootCertificatePath,
      REHEARSAL_MODEL_KEY: credential,
    }),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const events: string[] = [];
  const waiting = new Set<{
    match: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }>();
  const fail = (reason: string) => {
    for (const waiter of [...waiting]) {
      waiter.reject(new Error(reason));
    }
  };
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
    fail("native process failed to start");
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      fail("native process closed before the response");
      resolve();
    }),
  );
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as Message;
      if (message.method === "error") {
        fail(
          "native turn failure: " +
            JSON.stringify({
              native: message.params,
              connections,
              providerError: String(providerError),
            }).replaceAll(credential, "[fixture credential]"),
        );
      }
      events.push(message.method ?? `reply:${message.id}`);
      if (events.length > 12) {
        events.shift();
      }
      for (const waiter of [...waiting]) {
        if (waiter.match(message)) {
          waiter.resolve(message);
        }
      }
    } catch {
      fail("native process emitted invalid JSON");
    }
  });
  child.stdin.on("error", () => fail("native input closed"));
  dispose = async () => {
    fail("conversation disposed");
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
    }, 2000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  };
  function wait(match: (message: Message) => boolean) {
    return new Promise<Message>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        waiting.delete(waiter);
      };
      const waiter = {
        match,
        resolve: (message: Message) => {
          finish();
          resolve(message);
        },
        reject: (error: Error) => {
          finish();
          reject(error);
        },
      };
      const timer = setTimeout(
        () =>
          waiter.reject(
            new Error(
              "native response deadline; no replay: " +
                JSON.stringify({ events, requests, providerError: String(providerError) }) +
                " " +
                stderr.replaceAll(credential, "[fixture credential]"),
            ),
          ),
        30_000,
      );
      waiting.add(waiter);
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        waiter.reject(new Error("native process unavailable"));
      }
    });
  }
  let sequence = 0;
  async function call(method: string, params: object) {
    const id = ++sequence;
    const response = wait((message) => message.id === id);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const message = await response;
    assert.equal(message.error, undefined, "native RPC refused " + method);
    assert.ok(message.result);
    return message.result;
  }
  await call("initialize", {
    clientInfo: { name: "strands-sender-rehearsal", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const { thread } = await call("thread/start", {
    cwd: directory,
    model: "fixture-model",
    modelProvider: "rehearsal",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  assert.ok(child.pid && thread.id);
  const pid = child.pid;
  const identity = async () => {
    assert.equal(child.exitCode, null, "original native process exited");
    assert.equal(child.signalCode, null, "original native process was signalled");
    const [boot, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    assert.ok(startTicks);
    return `${boot.trim()}:${pid}:${startTicks}`;
  };
  return {
    pid,
    async turn(when: "before" | "after") {
      phase = when;
      const complete = wait(
        (message) => message.method === "turn/completed" && message.params?.threadId === thread.id,
      );
      // Attach both awaits immediately: a failed start must not leave an unhandled completion.
      const [started, message] = await Promise.all([
        call("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: when + "-question, reply without tools" }],
        }),
        complete,
      ]);
      assert.equal(providerError, undefined, "controlled model rejected a request");
      assert.equal(message.params?.turn.id, started.turn.id);
      assert.equal(
        message.params?.turn.status,
        "completed",
        stderr.replaceAll(credential, "[fixture credential]"),
      );
      const saved = await call("thread/read", { threadId: thread.id, includeTurns: true });
      const last = saved.thread.turns.at(-1);
      assert.equal(last?.id, started.turn.id);
      assert.ok(
        last?.items.some((item) => item.type === "agentMessage" && item.text === answer()),
        "persisted model reply differs",
      );
      assert.equal(requests, when === "before" ? 1 : 2, "exactly one provider request per turn");
      return { runtimeId: await identity(), sessionId: thread.id, turnId: started.turn.id };
    },
  };
}
