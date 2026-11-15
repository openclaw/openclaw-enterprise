#!/usr/bin/env node
import { execFile, fork, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../..", import.meta.url));
const lane = "postgres-platform";
const file = "tests/integration/postgres-openshell-online-git-journey.test.ts";
const wireTest = "OpenShell inspected Git fetch redeems the active grant and refuses withdrawal";
const binaryVariable = "OCC_TEST_OPENSHELL_PLACEHOLDER_WIRE_BINARY";
// Linux sockaddr_un.sun_path holds 108 bytes including the terminator.
const unixSocketPathLimit = 107;
const started = performance.now();
const durations = { prepare: 0, test: 0, cleanup: 0 };
let interruption: NodeJS.Signals | undefined;
let interruptPreparation: (() => void) | undefined;

// Only fixed messages from this wrapper may reach the terminal.
class PublicFailure extends Error {}

function interrupt(signal: NodeJS.Signals) {
  if (!interruption) {
    interruption = signal;
    console.error(
      `openshell-grant-wire: ${signal}; stopping preparation or waiting for the current stage.`,
    );
    interruptPreparation?.();
  }
}

function checkInterruption() {
  if (interruption) {
    throw new PublicFailure(`interrupted by ${interruption}.`);
  }
}

// The supervisor anchors the group ID until it exits. Never signal a reaped
// leader's numeric ID; successful signal delivery alone does not prove exit.
async function settlePreparation(child: ChildProcess, closed: Promise<boolean>) {
  let closeObserved = false;
  void closed.then(() => {
    closeObserved = true;
  });
  async function grace() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function signalGroup(signal: NodeJS.Signals) {
    if (child.pid && child.pid > 1 && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The existence check below decides whether settlement can be confirmed.
      }
    }
  }
  await grace();
  signalGroup("SIGTERM");
  await grace();
  signalGroup("SIGKILL");
  const deadline = performance.now() + 1_000;
  do {
    if (child.pid === undefined && closeObserved) {
      return true; // Failed spawn: no subprocess group exists.
    }
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 0);
      }
    } catch (error) {
      if (closeObserved && (error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
    }
    await delay(25);
  } while (performance.now() < deadline);
  return false;
}

function checkedInput<T extends string | undefined>(name: string, value: T) {
  // Node substitutes U+FFFD when it decodes invalid environment/path bytes.
  if (value?.includes("\uFFFD")) {
    throw new PublicFailure(`${name} contains a Unicode replacement character.`);
  }
  return value;
}

function fromDirectory(cwd: string, path: string) {
  // Keep ".." for the OS to resolve after traversing any symlink.
  return isAbsolute(path) ? path : `${cwd}/${path}`;
}

async function executable(path: string) {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const exec = promisify(execFile);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hasControlCharacters(value: string) {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function unixSocketPath(host: string) {
  if (host.startsWith("unix://") && utf8.decode(Buffer.from(host)) === host) {
    const path = host.slice("unix://".length);
    if (
      isAbsolute(path) &&
      !/\p{White_Space}$/u.test(path) &&
      !path.includes("://") &&
      !hasControlCharacters(path)
    ) {
      return path;
    }
  }
}

async function dockerHost(docker: string, cwd: string, env: NodeJS.ProcessEnv, explicit?: string) {
  try {
    let host: unknown = explicit;
    if (!host) {
      const { stdout } = await exec(
        docker,
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        { cwd, env, encoding: "buffer", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384 },
      );
      host = JSON.parse(utf8.decode(stdout));
      if (typeof host === "string") {
        checkedInput("Docker context endpoint", host);
      }
    }
    const path = typeof host === "string" ? unixSocketPath(host) : undefined;
    if (path) {
      const socket = utf8.decode(await realpath(path, { encoding: "buffer" }));
      if (unixSocketPath(`unix://${socket}`)) {
        // A short alias can reach an inode whose canonical pathname exceeds sun_path.
        const address = Buffer.byteLength(socket) <= unixSocketPathLimit ? socket : path;
        const original = await stat(socket, { bigint: true });
        if (Buffer.byteLength(address) <= unixSocketPathLimit && original.isSocket()) {
          const identity = `${original.dev}:${original.ino}`;
          if (await sameDockerSocket(address, identity)) {
            return { address, identity };
          }
        }
      }
    }
  } catch {
    // Context diagnostics can include configuration details.
  }
  throw new PublicFailure("Docker must select an existing local Unix socket.");
}

async function sameDockerSocket(address: string, identity: string) {
  try {
    const socket = await stat(address, { bigint: true });
    return socket.isSocket() && `${socket.dev}:${socket.ino}` === identity;
  } catch {
    return false;
  }
}

async function launchInputs() {
  // Consume only the allowlist before looking up a tool or touching run state.
  const cwd = checkedInput("working directory", process.cwd());
  checkedInput("checkout path", root);
  const node = checkedInput("Node executable", process.execPath);
  const temporaryInput = fromDirectory(cwd, checkedInput("temporary directory", tmpdir()));
  const supplied = checkedInput(binaryVariable, process.env[binaryVariable]);
  const explicit = checkedInput("DOCKER_HOST", process.env.DOCKER_HOST);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]) {
    const value = checkedInput(name, process.env[name]);
    if (value !== undefined) {
      env[name] = value;
    }
  }
  for (const name of [
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    if (process.env[name]) {
      throw new PublicFailure(`Unset ${name} before running the wire test.`);
    }
  }
  if (!supplied?.trim()) {
    throw new PublicFailure(`Set ${binaryVariable} to an already-built executable.`);
  }
  const binary = fromDirectory(cwd, supplied);
  if (!(await executable(binary))) {
    throw new PublicFailure(`${binaryVariable} must name an existing executable file.`);
  }

  // Match Node's Unix lookup default and anchor relative/empty entries before
  // the helpers change to the checkout directory.
  const search = (env.PATH ?? "/usr/bin:/bin").split(":").map((path) => fromDirectory(cwd, path));
  if (search.some((entry) => entry.includes(":"))) {
    throw new PublicFailure("Relative PATH entries require a working directory without colons.");
  }
  env.PATH = search.join(":");
  if (env.HOME) {
    env.HOME = fromDirectory(cwd, env.HOME);
  }
  const temporary = utf8.decode(await realpath(temporaryInput, { encoding: "buffer" }));
  // The retry command prints the run-directory pathname to the terminal.
  if (hasControlCharacters(temporary)) {
    throw new PublicFailure("Use a temporary directory without ASCII control characters.");
  }
  for (const entry of search) {
    const docker = `${entry}/docker`;
    if (await executable(docker)) {
      checkInterruption();
      const socket = await dockerHost(docker, root, env, explicit);
      return {
        env: {
          ...env,
          DOCKER_HOST: `unix://${socket.address}`,
          OCC_DOCKER_BIN: docker,
          [binaryVariable]: binary,
        },
        socket,
        temporary,
        node,
      };
    }
  }
  throw new PublicFailure("Docker must be an executable on PATH.");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  if (process.argv.length !== 2) {
    throw new PublicFailure("Usage: node scripts/ci/openshell-grant-wire.ts (no arguments)");
  }
  const { env, socket, temporary, node } = await launchInputs();
  checkInterruption();

  process.umask(0o077);
  const directory = await mkdtemp(join(temporary, "oce-grant-wire-"));
  const state = join(directory, "state.json");
  const results = join(directory, "results.json");
  const saved = join(directory, "cleanup-command");
  Object.assign(env, { TMPDIR: directory, RUNNER_TEMP: directory });
  const assignments = Object.entries(env).map(([name, value]) => shellQuote(`${name}=${value}`));
  const cleanup = [node, join(root, "scripts/ci/cleanup.mjs"), "--state", state].map(shellQuote);
  const recovery = `/usr/bin/env -i /bin/sh ${shellQuote(saved)}`;
  const socketChanged = "Original Docker socket is missing or has changed.";
  await writeFile(
    saved,
    `cd ${shellQuote(root)} || exit 1\ntest -f ${shellQuote(env.OCC_DOCKER_BIN)} && test -x ${shellQuote(env.OCC_DOCKER_BIN)} || { echo 'Original Docker executable unavailable.' >&2; exit 1; }\n[ "$(LC_ALL=C /usr/bin/stat -Lc '%d:%i:%F' -- ${shellQuote(socket.address)} 2>/dev/null)" = ${shellQuote(`${socket.identity}:socket`)} ] || { echo ${shellQuote(socketChanged)} >&2; exit 1; }\nexec /usr/bin/env -i ${[...assignments, ...cleanup].join(" ")}\n`,
    { mode: 0o600 },
  );
  console.log(`Run directory: ${JSON.stringify(directory)}`);

  let unresolvedPreparation: { pgid: number | undefined } | undefined;
  let unknownPreparationOutcome = false;

  async function run(stage: keyof typeof durations, script: string, args: string[]) {
    let stageStarted: number | undefined;
    try {
      const log = await open(join(directory, `${stage}.log`), "wx", 0o600);
      try {
        if (!(await sameDockerSocket(socket.address, socket.identity))) {
          throw new PublicFailure(socketChanged);
        }
        if (stage !== "cleanup") {
          checkInterruption();
        }
        stageStarted = performance.now();
        console.log(`openshell-grant-wire: ${stage}`);
        const command = [join(root, "scripts/ci", script), ...args];
        const child =
          stage === "prepare"
            ? fork(new URL("./cleanup-command.mjs", import.meta.url), [], {
                execPath: node,
                cwd: root,
                env,
                detached: true,
                execArgv: [],
                stdio: ["ignore", log.fd, log.fd, "ipc"],
              })
            : spawn(node, command, {
                cwd: root,
                env,
                detached: true,
                stdio: ["ignore", log.fd, log.fd],
              });
        let commandPassed = false;
        let commandTerminatedNaturally = false;
        let commandError = false;
        const closed = new Promise<boolean>((resolve) => {
          child.on("error", () => {
            commandError = true;
          });
          child.on("message", (result: { code?: number; error?: unknown }) => {
            commandTerminatedNaturally = typeof result.code === "number" && !result.error;
            commandPassed = result.code === 0 && !result.error;
          });
          child.once("close", (code) => {
            resolve(!commandError && (stage === "prepare" ? commandPassed : code === 0));
          });
        });
        if (stage === "prepare") {
          const interrupted = new Promise<void>((resolve) => {
            interruptPreparation = () => {
              // A daemon can finish accepted work after its client group dies.
              unknownPreparationOutcome = true;
              resolve();
            };
          });
          child.send?.({ command: node, args: command }, (error) => {
            if (error) {
              commandError = true;
            }
          });
          if (interruption) {
            interruptPreparation?.();
          }
          await Promise.race([closed, interrupted]);
          unknownPreparationOutcome ||= !commandTerminatedNaturally;
          if (!(await settlePreparation(child, closed))) {
            unresolvedPreparation = { pgid: child.pid };
            // Neither an unresponsive process nor its IPC channel may hold the CLI.
            // Disconnection on exit still lets the supervisor stop its owned group.
            child.unref();
            child.channel?.unref();
            throw new Error();
          }
          if (unknownPreparationOutcome) {
            throw new Error();
          }
        }
        if (!(await closed)) {
          throw new Error();
        }
      } finally {
        await log.close();
      }
    } catch (error) {
      if (error instanceof PublicFailure) {
        throw error;
      }
      throw new PublicFailure(
        `${stage} failed; inspect ${stage}.log in the private run directory.`,
      );
    } finally {
      if (stage === "prepare") {
        interruptPreparation = undefined;
      }
      if (stageStarted !== undefined) {
        durations[stage] = Math.round(performance.now() - stageStarted);
      }
    }
  }

  let failed = false;
  let cleanupFailed = false;
  try {
    checkInterruption();
    await run("prepare", "prepare.mjs", [
      "--lane",
      lane,
      "--selected-file",
      file,
      "--state",
      state,
    ]);
    checkInterruption();
    await run("test", "run-tests.mjs", [
      "run",
      lane,
      "--file",
      file,
      "--state",
      state,
      "--results",
      results,
    ]);
    try {
      const summary = JSON.parse(await readFile(results, "utf8"));
      const selected = summary.files?.filter((entry: { path: string }) => entry.path === file);
      const wire = selected?.[0]?.tests?.filter(
        (entry: { name: string }) => entry.name === wireTest,
      );
      if (
        summary.lane !== lane ||
        summary.scope !== "focused" ||
        summary.status !== "passed" ||
        selected?.length !== 1 ||
        selected[0].status !== "passed" ||
        wire?.length !== 1 ||
        wire[0].status !== "passed" ||
        wire[0].skip ||
        wire[0].todo
      ) {
        throw new Error();
      }
    } catch {
      throw new PublicFailure(`wire proof missing or not passed: "${wireTest}".`);
    }
  } catch (error) {
    failed = true;
    console.error(
      `openshell-grant-wire: ${error instanceof PublicFailure ? error.message : "run failed."}`,
    );
  } finally {
    if (unresolvedPreparation) {
      console.error(
        `openshell-grant-wire: unresolved preparation operation; group ${unresolvedPreparation.pgid ?? "unknown"} settlement unconfirmed.`,
      );
    }
    if (unknownPreparationOutcome || unresolvedPreparation) {
      console.error(
        "openshell-grant-wire: unknown external preparation outcome. Cleanup not started; preserve state. A daemon may still complete accepted work; resolve local and daemon operations before manual cleanup.",
      );
      if (existsSync(state)) {
        console.error(`After reconciliation, run from the original checkout: ${recovery}`);
      }
    } else if (existsSync(state)) {
      try {
        await run("cleanup", "cleanup.mjs", ["--state", state]);
      } catch (error) {
        cleanupFailed = true;
        const message = error instanceof PublicFailure ? error.message : "cleanup failed.";
        console.error(`openshell-grant-wire: ${message}`);
      }
    } else {
      failed = true;
      console.error("openshell-grant-wire: cleanup skipped (no state).");
    }
  }
  if (failed || cleanupFailed || interruption) {
    console.error(`Private failure artifacts: ${JSON.stringify(directory)}`);
    if (cleanupFailed && existsSync(state)) {
      console.error(`Retry cleanup: ${recovery}`);
    }
    process.exitCode = 1;
  } else {
    await rm(directory, { recursive: true });
    console.log("openshell-grant-wire: required wire test passed; cleanup passed.");
  }
}

process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
main()
  .catch((error) => {
    console.error(
      `openshell-grant-wire: ${error instanceof PublicFailure ? error.message : "local file operation failed."}`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (interruption) {
      process.exitCode = interruption === "SIGINT" ? 130 : 143;
    }
    console.log(
      `openshell-grant-wire: prepare_ms=${durations.prepare} test_ms=${durations.test} cleanup_ms=${durations.cleanup} elapsed_ms=${Math.round(performance.now() - started)}`,
    );
  });
