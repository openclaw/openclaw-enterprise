import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { reservePort, reservedPortArgs } from "./available-port.mjs";
import { harnessTlsFixture } from "./harness-tls.mjs";
import { listen } from "./listen.mjs";
import { waitFor } from "./wait-for.mjs";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { HARNESS_EGRESS_ENROLLMENT_PATH } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import type { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const WebSocket = createRequire(require.resolve("@kubernetes/client-node"))("ws") as new (
  url: string,
  options: object,
) => import("node:events").EventEmitter & { send(data: string): void; terminate(): void };

/** Run the shipped Codex binary through our real startup, release, login and model probe.
 * Loopback represents the supervisor and inference service; it accepts only this invented
 * model placeholder. The caller establishes the actual Git withdrawal before the second turn. */
export async function standingGitConversation(t: TestContext, executable: string) {
  const tls = await harnessTlsFixture(t);
  const { responseEvents } = JSON.parse(
    await readFile(
      new URL("../fixtures/static-egress/codex-responses.json", import.meta.url),
      "utf8",
    ),
  );
  const nonce = randomUUID();
  const placeholder = "fixture-model-" + nonce;
  const responses: string[] = [];
  let phase: "probe" | "before" | "after" = "probe";
  let observed = async () => {};
  const server = createServer(tls, async (req, res) => {
    if (req.url !== "/v1/responses") {
      res.writeHead(404).end(); // Codex may also ask for model lists or turn-cost reporting.
      return;
    }
    const input = JSON.parse(await text(req));
    assert.equal(req.headers.authorization, "Bearer " + placeholder);
    assert.equal(input.model, "fixture-model");
    const prompt = JSON.stringify(input.input);
    const answer = phase === "probe" ? "READY" : phase + "-answer-" + nonce;
    const last = input.input.at(-1);
    assert.match(
      JSON.stringify(last),
      new RegExp(phase === "probe" ? "Reply only READY" : phase + "-question"),
    );
    if (phase === "after") {
      assert.ok(
        prompt.includes("before-answer-" + nonce),
        "the provider received the first assistant reply in the second turn",
      );
    }
    await observed();
    responses.push(answer);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of responseEvents) {
      res.write(
        "data: " +
          JSON.stringify(event)
            .replaceAll("READY", answer)
            .replaceAll("runtime_probe", "conversation_" + responses.length) +
          "\n\n",
      );
    }
    res.end();
  });
  const baseUrl = "https://localhost:" + (await listen(t, server)) + "/v1";
  return {
    baseUrl,
    async launch(
      environment: Record<string, string>,
      check: (phase: string) => Promise<void>,
      release: (startupId: string) => Promise<ReturnType<typeof signComputeExecutionRelease>>,
      routeCount = 1,
    ) {
      observed = () => check(phase);
      assert.equal(environment.CODEX_LOGIN_MODE, "api_key");
      assert.equal(
        environment.OPENAI_API_KEY,
        undefined,
        "Compute may not supply the model credential",
      );
      const dir = tls.directory;
      // The Harness binds this port on every interface, first for native enrollment and then
      // for the Codex app-server. Hold it until the enrollment listener answers.
      const reservation = await reservePort({ host: "0.0.0.0" });
      t.after(() => reservation.release());
      const { port } = reservation;
      const appToken = randomUUID();
      await symlink(executable, join(dir, "codex"));
      const entrypoint = join(dir, "harness.cjs");
      await writeFile(entrypoint, AGENT_RUNTIME_ENTRYPOINT);
      const child = spawn(process.execPath, [...reservedPortArgs(reservation), entrypoint], {
        cwd: dir,
        env: {
          ...environment,
          HOME: dir,
          CODEX_HOME: join(dir, "codex-home"),
          TMPDIR: dir,
          PATH: dir + ":/usr/bin:/bin",
          SSL_CERT_FILE: tls.rootCertificatePath,
          APP_SERVER_PORT: String(port),
          APP_TOKEN_SHA: createHash("sha256").update(appToken).digest("hex"),
          // The fixture supervisor supplies only the selected model's opaque placeholder.
          OPENAI_API_KEY: placeholder,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let log = "";
      child.stderr.on("data", (data) => {
        log = (log + data).slice(-9000);
      });
      const sockets = new Set<InstanceType<typeof WebSocket>>();
      const pendingMessages = new Set<() => void>();
      const exited = once(child, "exit");
      t.after(async () => {
        for (const cancel of pendingMessages) {
          cancel();
        }
        for (const socket of sockets) {
          socket.terminate();
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
        await exited;
      });
      const url = "http://127.0.0.1:" + port + HARNESS_EGRESS_ENROLLMENT_PATH;
      const headers = { authorization: "Bearer " + appToken, "content-type": "application/json" };
      const challenge = await waitFor("native protected enrollment", async () => {
        assert.equal(child.exitCode, null, log);
        const result = await fetch(url, { headers }).catch(() => undefined);
        if (!result) {
          return;
        }
        assert.equal(result.status, 200, "native enrollment challenge must be available");
        return result.json();
      });
      // Release before the Codex app-server, which cannot share the held port, binds it.
      await reservation.release();
      assert.equal(responses.length, 0, "not even a probe before signed Compute release");
      assert.deepEqual(
        [challenge.inference, challenge.routeCount],
        ["credential_source", routeCount],
      );
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(await release(challenge.startupId)),
          })
        ).status,
        200,
      );
      const socket = await waitFor(
        "enrolled Codex app-server",
        async () => {
          assert.ok(!log.includes('"outcome":"failed"'), log);
          assert.equal(child.exitCode, null, log);
          if (!log.includes('"event":"codex.model_probe"')) {
            return;
          }
          const ws = new WebSocket("ws://127.0.0.1:" + port, { headers });
          sockets.add(ws);
          ws.once("close", () => sockets.delete(ws));
          if (
            await once(ws, "open").then(
              () => true,
              () => false,
            )
          ) {
            return ws;
          }
        },
        65000,
      );
      let n = 0;
      // Only one RPC is outstanding; never replay a turn after an ambiguous outcome.
      async function call(method: string, params: object) {
        const id = ++n;
        const result = waitForMessage((m) => m.id === id);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return (await result).result!;
      }
      type Turn = {
        id: string;
        status: string;
        error?: object;
        items: { type: string; text?: string }[];
      };
      type Message = {
        id?: number;
        method?: string;
        error?: object;
        result?: { thread: { id: string; turns: Turn[] }; turn: Turn };
        params?: { threadId: string; turn: Turn };
      };
      function waitForMessage(match: (m: Message) => boolean) {
        return new Promise<Message>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            socket.off("message", message);
            pendingMessages.delete(cleanup);
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(Error("Codex response deadline, no replay: " + log.slice(-2400)));
          }, 40000);
          const message = (data: Buffer) => {
            const m = JSON.parse(data.toString()) as Message;
            if (!match(m)) {
              return;
            }
            cleanup();
            if (m.error) {
              reject(Error(JSON.stringify(m.error)));
            } else {
              resolve(m);
            }
          };
          pendingMessages.add(cleanup);
          socket.on("message", message);
        });
      }
      await call("initialize", {
        clientInfo: { name: "repository-withdrawal-test", version: "1" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
      const started = await call("thread/start", {
        cwd: dir,
        model: "fixture-model",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const threadId = started.thread.id;
      assert.ok(threadId);
      const turns: string[] = [];
      return async (when: "before" | "after") => {
        phase = when;
        const complete = waitForMessage(
          (m) => m.method === "turn/completed" && m.params?.threadId === threadId,
        );
        const { turn } = await call("turn/start", {
          threadId,
          input: [{ type: "text", text: when + "-question, reply without tools" }],
        });
        const finish = (await complete).params!.turn;
        assert.equal(finish.id, turn.id);
        assert.equal(finish.status, "completed", JSON.stringify(finish.error));
        const { thread } = await call("thread/read", { threadId, includeTurns: true });
        const item = thread.turns.at(-1)!.items.at(-1)!;
        assert.equal(item.type, "agentMessage");
        assert.equal(item.text, when + "-answer-" + nonce);
        assert.equal(
          responses.length,
          when === "before" ? 2 : 3,
          "one startup probe and exactly one model request per turn",
        );
        assert.ok(!turns.includes(turn.id));
        turns.push(turn.id);
        t.diagnostic(
          JSON.stringify({
            evidence: "actual Codex turn with controlled model",
            when,
            threadId,
            turn: turn.id,
            requests: responses.length,
          }),
        );
      };
    },
  };
}
