// Follows Docker containers with long-lived CLIs instead of polling them: a
// test that waits for a container to log something or to exit sleeps until the
// next write, rather than starting `docker logs` and `docker inspect` every few
// hundred milliseconds for minutes at a time.
import { spawn } from "node:child_process";

// The end of a CLI's output for an error message.
function tail(output, limit = 2048) {
  return output.length <= limit ? output : `[...]${output.slice(-limit)}`;
}

// Counts changes to followed containers, so a wait can sleep until the next
// write or exit instead of polling.
export function changeSignal() {
  let version = 0;
  const waiters = new Set();
  return {
    get version() {
      return version;
    },
    notify() {
      version += 1;
      for (const resolve of waiters) {
        resolve();
      }
    },
    // Resolves once anything changed after `since`, or after `timeoutMs`.
    wait(since, timeoutMs) {
      if (version !== since) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        waiters.add(done);
      });
    },
  };
}

// Follows a container with two long-lived CLIs, `docker logs --follow` and
// (unless `exit` is false) `docker wait`, instead of a `docker logs` and a
// `docker inspect` per poll. read() returns all the container has written, as
// `docker logs` prints it, and whether it still runs; it throws if either CLI
// failed. `exitedAt` is when `docker wait` returned; `running` turns false once
// the log stream has also ended, so a stopped container's output is complete.
// Every write and the exit notify `changes`. inspect() asks Docker directly, as
// a check on a wait that has not seen the exit; an exit it finds counts from
// Docker's FinishedAt. `t`, when given, stops both CLIs after the test.
export function followContainer(
  t,
  containerName,
  {
    docker = process.env.OCC_DOCKER_BIN ?? "docker",
    exit = true,
    changes = changeSignal(),
    inspectTimeoutMs = 20_000,
  } = {},
) {
  const streams = { stdout: "", stderr: "" };
  const state = { running: true, exitCode: 0, exitedAt: undefined, following: true };
  const children = [];
  const closes = [];
  let failure;
  let stopping = false;
  const fail = (message) => {
    if (!stopping && failure === undefined) {
      failure = new Error(message);
      changes.notify();
    }
  };
  const start = (args) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const closed = new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    closes.push(closed);
    return { child, closed };
  };
  const logs = start(["logs", "--follow", containerName]);
  for (const name of ["stdout", "stderr"]) {
    logs.child[name].on("data", (chunk) => {
      streams[name] += chunk;
      changes.notify();
    });
  }
  const logsEnded = logs.closed.then(({ code, signal, error }) => {
    state.following = false;
    if (error !== undefined || code !== 0) {
      fail(
        `docker logs --follow ${containerName} failed (${error?.message ?? code ?? signal}).\n` +
          tail(streams.stderr),
      );
    }
    changes.notify();
  });
  let settled = false;
  // The exit as `docker wait` (or an inspect) saw it.
  const exited = async (exitCode, at = Date.now()) => {
    if (settled) {
      return;
    }
    settled = true;
    state.exitedAt = at;
    state.exitCode = exitCode;
    changes.notify();
    // `docker logs --follow` ends once it has written the container's last output.
    let drained;
    await Promise.race([
      logsEnded,
      new Promise((resolve) => (drained = setTimeout(resolve, 10_000))),
    ]);
    clearTimeout(drained);
    state.running = false;
    changes.notify();
  };
  // One `docker inspect`, stopped after `timeoutMs`: { running, exitCode,
  // finishedAt }, or undefined if it failed. finishedAt is Docker's exit time
  // (the daemon's clock, the same host here), or undefined when Docker has
  // none after the container's start or reports one later than now.
  const inspect = async ({ timeoutMs = inspectTimeoutMs } = {}) => {
    const child = start([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}",
    ]);
    let text = "";
    child.child.stdout.on("data", (chunk) => (text += chunk));
    const timer = setTimeout(() => child.child.kill(), timeoutMs);
    const { code } = await child.closed;
    clearTimeout(timer);
    const [running, exitCode, startedAt, finishedAt] = text
      .trim()
      .split("|")
      .map((field) => field.trim());
    if (code !== 0 || !["true", "false"].includes(running)) {
      return undefined;
    }
    const started = Date.parse(startedAt);
    const finished = Date.parse(finishedAt);
    const result = {
      running: running === "true",
      exitCode: Number(exitCode),
      finishedAt:
        finished > 0 && !(finished < started) && finished <= Date.now() ? finished : undefined,
    };
    if (exit && !result.running && Number.isInteger(result.exitCode)) {
      void exited(result.exitCode, result.finishedAt ?? Date.now());
    }
    return result;
  };
  if (exit) {
    const wait = start(["wait", containerName]);
    const output = { stdout: "", stderr: "" };
    wait.child.stdout.on("data", (chunk) => (output.stdout += chunk));
    wait.child.stderr.on("data", (chunk) => (output.stderr += chunk));
    void wait.closed.then(async ({ code, signal, error }) => {
      const exitCode = Number(output.stdout.trim());
      if (
        error !== undefined ||
        code !== 0 ||
        output.stdout.trim() === "" ||
        !Number.isInteger(exitCode)
      ) {
        // A wait that failed on a busy daemon is not a failed container: ask once.
        if (!settled && !stopping) {
          await inspect().catch(() => undefined);
        }
        if (!settled) {
          fail(
            `docker wait ${containerName} failed (${error?.message ?? code ?? signal}).\n` +
              tail(`${output.stdout}\n${output.stderr}`),
          );
        }
        return;
      }
      void exited(exitCode);
    });
    // If the log stream ends but `docker wait` has not returned 10 s later, ask once.
    void logsEnded.then(async () => {
      let timer;
      await Promise.race([
        wait.closed,
        new Promise((resolve) => (timer = setTimeout(resolve, 10_000))),
      ]);
      clearTimeout(timer);
      if (!settled && !stopping) {
        await inspect().catch(() => undefined);
      }
    });
  }
  const stop = async () => {
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    await Promise.all([...closes, logsEnded]);
  };
  t?.after(stop);
  return {
    changes,
    stop,
    inspect,
    read() {
      if (failure !== undefined) {
        throw failure;
      }
      return { ...streams, ...state };
    },
  };
}
