import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";

import { commandPath } from "./compose.ts";
import {
  bashString,
  commandShim,
  type CommandRequest,
  type startCommandServer,
} from "./fixture-command-server.ts";
import { readJsonLines as readJsonLinesFile } from "./json-lines-file.ts";

export const matchingInstallationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const bashExecutable = "/bin/bash";

export async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

// The external commands dev-up runs (the container engine, yq, uname, the project's occ,
// and k3d, kubectl and helm for Kubernetes Compute) are bash scripts answered by the
// fixture's command server (fixture-command-server.ts), so their logic below runs in
// the test process: a command costs a bash start instead of a node start. The real CLI,
// scripts/dev-up and scripts/dev-down still start each one as a process. A command
// sends the environment variables below.
export const forwardedEnv = [
  "CONTAINER_CONNECTION",
  "DEV_UP_ENGINE_LOG",
  "DEV_UP_EXISTING_CONTROLLER_IMAGE",
  "DEV_UP_EXISTING_RUNTIME_IMAGE",
  "DEV_UP_FAKE_SCENARIO",
  "DEV_UP_LIFECYCLE_SCENARIO",
  "DEV_UP_OCC_LOG",
  "DEV_UP_REAL_COMPOSE_COMMAND",
  "DEV_UP_REAL_COMPOSE_FORMAT",
  "DEV_UP_REAL_COMPOSE_PREFIX",
  "DEV_UP_REAL_PATH",
  "DEV_UP_REAL_YQ",
  "DEV_UP_REPOSITORY",
  "DEV_UP_RESOURCE_STATE",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "OCC_CONTAINER_ENGINE_SOCKET",
  "OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE",
  "OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE",
  "OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR",
  "OCC_DEVELOPMENT_BROWSER_ORIGIN",
  "OCC_DEVELOPMENT_AGENT_NATIVE_ADMIN_DOMAIN",
  "OCC_DEVELOPMENT_BROWSER_PORT",
  "OCC_DEVELOPMENT_BROWSER_TLS_CERT",
  "OCC_DEVELOPMENT_BROWSER_TLS_KEY",
  "OCC_AGENT_NATIVE_ADMIN_ENABLED",
  "OCC_DOCKER_AGENT_IMAGE",
  "OCC_DOCKER_GATEWAY_IMAGE",
  "OCC_DOCKER_RUNTIME_IMAGE",
  "OPENCLAW_DEV_PORT",
  "PODMAN_COMPOSE_PROVIDER",
  "SAFETY_LOG",
];

// A fake command's process exit, thrown from its logic.
class FakeExit {
  code: number;

  constructor(code: number) {
    this.code = code;
  }
}

// Returned by a fake that never answers: its process waits until it is killed.
export const hold = Symbol("hold");

type FakeOutput = {
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number, message?: string): never;
  readInput: CommandRequest["io"]["readInput"];
};
type FakeResult = string | typeof hold | void;
type FakeLogic = (command: FakeOutput) => FakeResult | Promise<FakeResult>;

// Runs one fake command's logic. It writes through out/err, ends with exit (or by
// returning, as status 0), or hands the command a final bash line with script.
export async function runFake(io: CommandRequest["io"], logic: FakeLogic): Promise<void> {
  const out: string[] = [];
  const err: string[] = [];
  const command: FakeOutput = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    exit: (code, message = "") => {
      if (message) {
        err.push(message + "\n");
      }
      throw new FakeExit(code);
    },
    readInput: io.readInput,
  };
  let code = 0;
  let script: FakeResult = undefined;
  try {
    script = await logic(command);
  } catch (error) {
    if (!(error instanceof FakeExit)) {
      throw error;
    }
    code = error.code;
  }
  io.stdout(out.join(""));
  io.stderr(err.join(""));
  if (script === hold) {
    return;
  }
  if (typeof script === "string") {
    io.script(script);
  } else {
    io.exit(code);
  }
}

// The project's bin/occ: `occ dev` is the real development CLI; any other command is the
// Installation API read dev-up makes after startup.
export function projectOccCommand(
  fake: { cli: string },
  { args, env }: Pick<CommandRequest, "args" | "env">,
  { stdout, stderr, exit }: Pick<FakeOutput, "stdout" | "stderr" | "exit">,
): string | void {
  if (args[0] === "dev") {
    return `exec ${bashString(fake.cli)} "$@"`;
  }
  const log = env.DEV_UP_OCC_LOG;
  if (log) {
    appendFileSync(log, JSON.stringify({ args }) + "\n");
  }
  const scenario = env.DEV_UP_FAKE_SCENARIO || "success";
  if (scenario === "api-unauthorized") {
    const payload = {
      error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." },
      meta: { requestId: "req_1" },
    };
    stderr(JSON.stringify(payload) + "\nHTTP 401\n");
    exit(1);
  }
  stdout(
    JSON.stringify({
      id: scenario === "api-mismatch" ? undefined : matchingInstallationId,
    }) + "\n",
  );
  exit(0);
}

type CommandServer = Awaited<ReturnType<typeof startCommandServer>>;

// A fake command answered by the fixture's server; it holds the server's tokens, so it
// is private to this user.
export async function writeFakeCommand(
  fake: { server: Pick<CommandServer, "port" | "clientToken" | "serverToken"> },
  path: string,
  command: string,
): Promise<void> {
  const { port, clientToken, serverToken } = fake.server;
  await writeFile(
    path,
    commandShim({
      bash: bashExecutable,
      sleep: commandPath("sleep") || "/bin/sleep",
      setsid: commandPath("setsid") || "/usr/bin/setsid",
      port,
      clientToken,
      serverToken,
      command,
      forwardedEnv,
    }),
    { mode: 0o700 },
  );
}

export function composeOptions(fixture: { emptyEnv: string }, overridePath?: string): string[] {
  const options = [
    "--env-file",
    fixture.emptyEnv,
    "-f",
    "compose.yaml",
    "--project-name",
    "oce-dev-up-test",
  ];
  if (overridePath) {
    options.splice(4, 0, "-f", overridePath);
  }
  return options;
}

export type CommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
};
type CommandOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeout?: number;
};

// Like spawnSync with encoding utf8 (status, signal, stdout, stderr, and error on a
// failed start or timeout), but without blocking this process: its command server must
// answer the fake commands the program runs.
export function runCommand(
  command: string,
  args: string[],
  { cwd, env, timeout }: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            error = Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), {
              code: "ETIMEDOUT",
            });
            child.kill("SIGTERM");
          }, timeout);
    child.once("error", (spawnError) => {
      error ??= spawnError;
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr, error });
    });
  });
}

export function runDevUp(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return runCommand(bashExecutable, ["scripts/dev-up", ...args], {
    cwd: env.DEV_UP_FIXTURE_REPOSITORY,
    env,
  });
}

export function runDevDown(env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return runCommand(bashExecutable, ["scripts/dev-down"], {
    cwd: env.DEV_UP_FIXTURE_REPOSITORY,
    env,
  });
}

// A dev-up log the fixture may not have written yet: a missing file is no records, and blank
// lines are skipped.
export function readJsonLines(path: string): Promise<unknown[]> {
  return readJsonLinesFile(path, { missingOk: true, skipBlank: true });
}

export function composeInvocations<Invocation extends { args: string[] }>(
  logs: Invocation[],
): Invocation[] {
  return logs.filter(
    (entry) =>
      entry.args[0] === "compose" &&
      entry.args[1] !== "version" &&
      !entry.args.some((argument) => argument.endsWith("/compose-capability.yaml")),
  );
}
