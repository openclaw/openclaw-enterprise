import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Interface } from "node:readline";

export function parseJson(source: string): unknown {
  return JSON.parse(source);
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected a string.");
  }
  return value;
}

export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an array.");
  }
  return value;
}

export function commandResult(value: unknown, read: typeof record, asText: typeof text) {
  const { exitCode, stdout, stderr } = read(value);
  if (typeof exitCode !== "number") {
    throw new Error("Expected a numeric Codex command exit code.");
  }
  return { exitCode, stdout: asText(stdout), stderr: asText(stderr) };
}

type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void };

// The image probes talk to the real stdio server. Decode its envelope at the
// transport boundary, and inspect each operation's result at its call site.
export function codexRpc(
  native: ChildProcessWithoutNullStreams,
  lines: Interface,
  decode: typeof parseJson,
  read: typeof record,
) {
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  lines.on("line", (line) => {
    const message = read(decode(line));
    if (typeof message.id !== "number") {
      return;
    }
    const request = pending.get(message.id);
    if (request === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });
  return {
    fail(error: Error) {
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
    },
    request(method: string, params: Record<string, unknown>) {
      return new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        native.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
  };
}
