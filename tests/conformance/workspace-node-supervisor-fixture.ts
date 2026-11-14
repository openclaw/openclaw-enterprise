import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_WITH_NODE_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import type { WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { isPositiveSafeInteger } from "../../packages/utils/src/validation.ts";
import { type reservePort, reservedPortArgs } from "../helpers/available-port.ts";

const childKinds = [
  "node",
  "codex",
  "grandchild",
  "descendant",
  "setup",
  "setup-signal",
  "setup-done",
] as const;
type ChildKind = (typeof childKinds)[number];

const stringFields = ["target", "caPath", "shellCaPath"] as const;
const booleanFields = [
  "hasSetup",
  "hasSetupPath",
  "hasDisplayName",
  "hasModelKey",
  "hasTransportToken",
  "autoUpdateDisabled",
  "hasCaPath",
] as const;

type ChildObservation = {
  pid: number;
  parent?: number;
  args?: string[];
  event?: "started" | "terminating";
} & Partial<Record<(typeof stringFields)[number], string>> &
  Partial<Record<(typeof booleanFields)[number], boolean>>;

export type ChildEvent = {
  [Kind in ChildKind]: { kind: Kind } & ChildObservation;
}[ChildKind];

export type ProcessEventRow =
  ChildEvent | { kind: "probe"; attempt?: number; pid?: never; event?: never };

type SetupReadRow = { content: string | null };
type SupervisorExit = [code: number | null, signal: NodeJS.Signals | null];

function isChildKind(value: unknown): value is ChildKind {
  return childKinds.some((kind) => kind === value);
}

function isProcessEvent(value: unknown): value is ProcessEventRow {
  const row = asRecord(value);
  if (row?.kind === "probe") {
    return (
      row.pid === undefined &&
      row.event === undefined &&
      (row.attempt === undefined || isPositiveSafeInteger(row.attempt))
    );
  }
  return (
    row !== undefined &&
    isChildKind(row.kind) &&
    isPositiveSafeInteger(row.pid) &&
    (row.parent === undefined || isPositiveSafeInteger(row.parent)) &&
    (row.args === undefined ||
      (Array.isArray(row.args) && row.args.every((arg: unknown) => typeof arg === "string"))) &&
    (row.event === undefined || row.event === "started" || row.event === "terminating") &&
    stringFields.every((field) => row[field] === undefined || typeof row[field] === "string") &&
    booleanFields.every((field) => row[field] === undefined || typeof row[field] === "boolean")
  );
}

function isSetupRead(value: unknown): value is SetupReadRow {
  const row = asRecord(value);
  return row !== undefined && (row.content === null || typeof row.content === "string");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Children may append a row larger than a single write. Only a newline completes it.
async function readJsonLines<Row>(
  path: string,
  isRow: (value: unknown) => value is Row,
): Promise<Row[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return contents
    .slice(0, contents.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const row: unknown = JSON.parse(line);
      assert.ok(isRow(row), `Invalid record ${index + 1} in ${path}`);
      return row;
    });
}

export function readSetupReads(path: string) {
  return readJsonLines(path, isSetupRead);
}

export function nativeSetup(bootstrapToken: string): WorkspaceNodeSetupEnvelope {
  return { url: "wss://gateway.example.test/node", bootstrapToken, expiresAtMs: 4_000_000_000_000 };
}

// Both delivery paths must fit the native connect target-file limit (64 KiB).
export function maximumSetupEnvelope(): WorkspaceNodeSetupEnvelope {
  const payload = nativeSetup("");
  const maximumDecodedBytes = (65_536 / 4) * 3;
  return {
    ...payload,
    bootstrapToken: "x".repeat(maximumDecodedBytes - Buffer.byteLength(JSON.stringify(payload))),
  };
}

function signalPid(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

// A dying or zombie process still answers kill(pid, 0).
export function pidGone(pid: number): boolean {
  return !signalPid(pid, 0);
}

type PollOptions = { timeoutMs: number; intervalMs: number };
const defaultPollOptions: PollOptions = { timeoutMs: 5_000, intervalMs: 25 };

async function poll<Result>(
  read: () => Result | Promise<Result>,
  accept: (result: Result) => boolean,
  failure: () => string,
  { timeoutMs, intervalMs } = defaultPollOptions,
): Promise<Result> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) {
      return result;
    }
    await delay(intervalMs);
  }
  assert.fail(failure());
}

export async function processGone(description: string, pid: number): Promise<void> {
  await poll(
    () => pidGone(pid),
    Boolean,
    () => description,
  );
}

// Observe actual projection bytes for both whole-file and bounded descriptor reads.
export function observeSetupReads(setupPath: string, setupReadsPath: string) {
  return [
    'const fs = require("node:fs");',
    "const realRead = fs.readFileSync, realOpen = fs.openSync, realReadSync = fs.readSync, realClose = fs.closeSync;",
    "const observedSetupReads = new Map(); let directSetupRead = false;",
    `const setupRead = (content) => fs.appendFileSync(${JSON.stringify(setupReadsPath)}, JSON.stringify({ content }) + "\\n");`,
    "fs.readFileSync = (path, ...rest) => {",
    `  if (path !== ${JSON.stringify(setupPath)}) return realRead(path, ...rest);`,
    "  let content = null; directSetupRead = true;",
    "  try { content = realRead(path, ...rest); return content; }",
    "  finally { directSetupRead = false; setupRead(content); }",
    "};",
    "fs.openSync = (path, ...rest) => {",
    `  const observe = path === ${JSON.stringify(setupPath)} && !directSetupRead;`,
    "  try { const fd = realOpen(path, ...rest); if (observe) observedSetupReads.set(fd, []); return fd; }",
    "  catch (error) { if (observe) setupRead(null); throw error; }",
    "};",
    "fs.readSync = (fd, buffer, offset, length, position) => {",
    "  const read = realReadSync(fd, buffer, offset, length, position);",
    "  observedSetupReads.get(fd)?.push(Buffer.from(buffer.subarray(offset, offset + read)));",
    "  return read;",
    "};",
    "fs.closeSync = (fd) => {",
    "  try { return realClose(fd); } finally {",
    "    const chunks = observedSetupReads.get(fd); observedSetupReads.delete(fd);",
    '    if (chunks) setupRead(Buffer.concat(chunks).toString("utf8"));',
    "  }",
    "};",
  ];
}

// Stub lines for a saved-identity probe that appends a "probe" row to the events
// file in the supervisor's HOME (the test directory) and never answers, keeping
// the event loop busy as a slow probe does.
export const pendingIdentityProbe = [
  "cp.execFile = () => {",
  '  const events = require("node:path").join(process.env.HOME, "events.jsonl");',
  '  require("node:fs").appendFileSync(events, JSON.stringify({ kind: "probe" }) + "\\n");',
  "  setInterval(() => {}, 60_000);",
  "};",
];

export const recordingChild = [
  'const { appendFileSync } = require("node:fs");',
  "const [events, kind] = process.argv.slice(2);",
  'appendFileSync(events, JSON.stringify({ kind, pid: process.pid }) + "\\n");',
  "setInterval(() => {}, 1_000);",
];

export const recordingChildWithArguments = [
  'const { appendFileSync } = require("node:fs");',
  "const [events, kind, args] = process.argv.slice(2);",
  'appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args) }) + "\\n");',
  "setInterval(() => {}, 1_000);",
];

type SupervisorOptions = {
  child: readonly string[];
  setup?: readonly string[];
  stubs?: readonly string[];
  env: NodeJS.ProcessEnv;
  entrypoint?: string;
  statusReservation?: Awaited<ReturnType<typeof reservePort>> | undefined;
};

// Run the container's supervisor program with real child processes and signals.
// Substitute the native setup and worker command bodies. Children append their
// observations to events.jsonl in the test-owned HOME.
export async function startSupervisor(
  t: TestContext,
  directory: string,
  {
    child,
    setup = [],
    stubs = [],
    env,
    entrypoint = AGENT_WITH_NODE_ENTRYPOINT,
    statusReservation,
  }: SupervisorOptions,
) {
  const eventsPath = join(directory, "events.jsonl");
  const childPath = join(directory, "child.cjs");
  const setupPath = join(directory, "setup.cjs");
  const events = () => readJsonLines(eventsPath, isProcessEvent);
  await writeFile(childPath, child.join("\n"));
  await writeFile(setupPath, setup.join("\n"));
  const launch = [
    'const cp = require("node:child_process"); const realSpawn = cp.spawn;',
    "cp.spawnSync = () => ({ status: 0 });",
    'cp.spawn = (command, args, options) => realSpawn(command, args[1] === "setup" ? [' +
      JSON.stringify(setupPath) +
      ", " +
      JSON.stringify(eventsPath) +
      "] : [" +
      JSON.stringify(childPath) +
      ", " +
      JSON.stringify(eventsPath) +
      ', args[0] === "/app/openclaw.mjs" ? "node" : "codex", JSON.stringify(args)], options);',
    ...stubs,
    entrypoint
      .replace("\ninitializeRuntimeAssets();\n", "\n")
      .replace("\npublishAgentPluginSkillPath();\n", "\n"),
  ].join("\n");
  // Let the real supervisor bind the reserved port before releasing the reservation.
  const preload = statusReservation === undefined ? [] : reservedPortArgs(statusReservation);
  const supervisor = spawn(process.execPath, [...preload, "-e", ...nodeProgramArguments(launch)], {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
      OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  supervisor.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<SupervisorExit>((resolve, reject) => {
    supervisor.once("exit", (code, signal) => resolve([code, signal]));
    supervisor.once("error", reject);
  });
  t.after(async () => {
    try {
      supervisor.kill("SIGTERM");
      await exited;
      for (const { pid } of await events()) {
        if (pid !== undefined) {
          signalPid(pid, "SIGKILL");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const output = () => stderr;
  function waitForValue<Result>(
    description: string,
    accept: (result: Result) => boolean,
    read: () => Result | Promise<Result>,
    options?: PollOptions,
  ) {
    return poll(
      read,
      (result) => {
        if (accept(result)) {
          return true;
        }
        assert.deepEqual([supervisor.exitCode, supervisor.signalCode], [null, null], stderr);
        return false;
      },
      () => description + ": " + stderr,
      options,
    );
  }
  const waitFor = (
    description: string,
    accept: (rows: ProcessEventRow[]) => boolean,
    options?: PollOptions,
  ) => waitForValue(description, accept, events, options);
  return { supervisor, exited, events, waitFor, waitForValue, output };
}
