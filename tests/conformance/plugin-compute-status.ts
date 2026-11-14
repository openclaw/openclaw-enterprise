import {
  readStatusFromHandler as readPluginStatusFixture,
  readRuntimeStatusFromHandler as readRuntimeStatusFixture,
} from "../fixtures/codex-native-startup.mjs";
import { items, parseJson, record, required } from "./plugin-compute-fixtures.ts";

type Listener = () => void;
type Events = {
  on?(event: string, listener: Listener): void;
  off?(event: string, listener: Listener): void;
};

export type StatusHandler = (
  request: { method: string; url: string } & Events,
  response: { writeHead(status: number): void; end(chunk?: string | Buffer): void } & Events,
) => void | Promise<void>;

const readPluginStatus: (handler: StatusHandler) => unknown = readPluginStatusFixture;
const readRuntimeStatus: (handler: StatusHandler) => unknown = readRuntimeStatusFixture;

export function readStatusFromHandler(handler: StatusHandler | undefined): Record<string, unknown> {
  return record(readPluginStatus(required(handler)));
}

export function readRuntimeStatusFromHandler(
  handler: StatusHandler | undefined,
): Record<string, unknown> {
  return record(readRuntimeStatus(required(handler)));
}

export async function readStatusFromHandlerAsync(
  handler: StatusHandler | undefined,
  path: string,
): Promise<unknown> {
  let body = "";
  await required(handler)(
    { method: "GET", url: path, on() {}, off() {} },
    {
      writeHead() {},
      on() {},
      off() {},
      end(chunk) {
        body += chunk;
      },
    },
  );
  return parseJson(body);
}

export async function readRuntimeChannelChecksFromHandler(
  handler: StatusHandler,
): Promise<{ checks: Record<string, unknown>[] }> {
  const diagnostics = record(
    await readStatusFromHandlerAsync(handler, "/openclaw/runtime/diagnostics"),
  );
  return { checks: items(diagnostics.checks).map(record) };
}

export async function readReadyStatusFromHandler(handler: StatusHandler | undefined) {
  let body = "";
  let status: number | undefined;
  await required(handler)(
    { method: "GET", url: "/readyz" },
    {
      writeHead(value) {
        status = value;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
  );
  return { status, body };
}
