import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const websocket = () => createRequire("/app/package.json")("ws");

async function waitForReady() {
  // Do not mistake the temporary enrollment listener's 401 for native authentication.
  for (let attempt = 0; ; attempt++) {
    try {
      assert.equal(await fs.readFile("/tmp/ready", "utf8"), "ready\n");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 100) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function refuseWrongBearer() {
  const WebSocket = websocket();
  // Enrollment has completed; retry only the native listener's connection-refused window.
  for (let attempt = 0; ; attempt++) {
    const status = await new Promise<number>((resolve, reject) => {
      const wrong = new WebSocket("ws://127.0.0.1:4500", {
        headers: { authorization: "Bearer incorrect-fixture" },
        handshakeTimeout: 1000,
      });
      wrong.once("open", () => {
        reject(new Error("wrong bearer upgraded"));
        wrong.terminate();
      });
      wrong.once(
        "unexpected-response",
        (_request: unknown, response: { statusCode: number; resume(): void }) => {
          response.resume();
          resolve(response.statusCode);
          wrong.terminate();
        },
      );
      wrong.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") {
          resolve(0);
        } else {
          reject(new Error("native handshake failed"));
        }
      });
    });
    if (status !== 0) {
      assert.equal(status, 401);
      break;
    }
    assert.ok(attempt < 100, "native listener did not start");
    await delay(100);
  }
}

async function authenticatedSession(messages: PassThrough, bearer: string) {
  const WebSocket = websocket();
  await waitForReady();
  await refuseWrongBearer();
  const socket = new WebSocket("ws://127.0.0.1:4500", {
    headers: { authorization: `Bearer ${bearer}` },
    handshakeTimeout: 1000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", () => reject(new Error("correct bearer rejected")));
  });
  socket.on("message", (data: Buffer) => messages.write(data.toString() + "\n"));
  socket.on("close", () => messages.end());
  const send = (text: string) => socket.send(text);
  const close = async () => {
    socket.terminate();
  };

  return { send, close };
}

function preparationSession(messages: PassThrough) {
  const child = spawn("codex", ["-c", 'otel.exporter="none"', "app-server", "--stdio"], {
    cwd: "/tmp/workspace",
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdout.pipe(messages);
  const send = (text: string) => {
    child.stdin.write(text + "\n");
  };
  const close = async () => {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { send, close };
}

export async function nativeSession(bearer?: string) {
  const messages = new PassThrough();
  const { send, close } =
    bearer === undefined
      ? preparationSession(messages)
      : await authenticatedSession(messages, bearer);
  const lines = createInterface({ input: messages });
  let id = 0;
  const rpc = <T>(method: string, params: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const current = ++id;
      const finish = (error?: Error, value?: T) => {
        clearTimeout(timer);
        lines.off("line", receive);
        lines.off("close", disconnected);
        if (error) {
          reject(error);
        } else {
          resolve(value!);
        }
      };
      const receive = (line: string) => {
        const result = JSON.parse(line) as { id: number; error?: unknown; result: T };
        if (result.id === current) {
          finish(
            result.error
              ? new Error(
                  `native ${method} rejected: ${JSON.stringify(result.error).slice(0, 500)}`,
                )
              : undefined,
            result.result,
          );
        }
      };
      const disconnected = () => finish(new Error(`native session ended during ${method}`));
      const timer = setTimeout(() => finish(new Error(`native ${method} timed out`)), 10_000);
      lines.on("line", receive);
      lines.once("close", disconnected);
      send(JSON.stringify({ id: current, method, params }));
    });

  return {
    rpc,
    send,
    close: async () => {
      lines.close();
      await close();
    },
  };
}
