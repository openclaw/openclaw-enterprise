import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

type LaunchFiles = { ready: string; release: string; finished: string };
type RelayOptions = { engine: string; launchFiles?: LaunchFiles } & (
  | { mode: "interrupted-logs"; partialOutput: string }
  | {
      mode:
        | "wait-for-exit"
        | "fail-removal"
        | "lost-removal-ack"
        | "cancelled-launch"
        | "interrupted-launch";
      partialOutput?: string;
    }
);

// Delegate to the real engine. Only the selected CLI boundary is delayed or
// interrupted; container creation, state, logs and deletion still use Docker.
export function relayEngine({ engine, mode, partialOutput, launchFiles }: RelayOptions) {
  const args = process.argv.slice(2);
  const execute = (command: string[], timeout = 60_000) =>
    execFileSync(engine, command, {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
    if (args[0] === "run" && launchFiles) {
      // A real delegated subprocess remains in flight while the test cancels
      // setup (or kills this wrapper), then calls the actual engine.
      const source = `import { delegatedRelayLaunch } from ${JSON.stringify(import.meta.url)}; await delegatedRelayLaunch(${JSON.stringify({ engine, mode, launchFiles, args, wrapperPid: process.pid })});`;
      process.stdout.write(
        execFileSync(process.execPath, ["--input-type=module", "-e", source], {
          encoding: "utf8",
          timeout: 60_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        }),
      );
      return;
    }
    if (args[0] === "logs" && mode === "interrupted-logs") {
      process.stdout.write(partialOutput);
      setInterval(() => {}, 1_000);
      return;
    }
    if (args[0] === "rm" && mode === "fail-removal") {
      // A genuine CLI rejection leaves the owned container for the parent to
      // inspect and dispose after checking the child's teardown failure.
      execute(["rm", "--invalid-relay-cleanup-option"]);
    }
    const output = execute(args);
    if (args[0] === "run") {
      // Make the failure scenarios independent of startup speed or emulation.
      // Docker wait returns only after this exact container has exited.
      execute(["wait", output.trim()], 30_000);
    }
    if (args[0] === "rm" && mode === "lost-removal-ack") {
      process.stderr.write("relay removal acknowledgement lost\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(output);
  } catch (error) {
    const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    process.stdout.write(typeof stdout === "string" || stdout instanceof Uint8Array ? stdout : "");
    process.stderr.write(typeof stderr === "string" || stderr instanceof Uint8Array ? stderr : "");
    process.exitCode = typeof status === "number" ? status : 1;
  }
}

export async function waitForRelayFile(path: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await delay(20);
  }
  throw new Error("Delegated relay launch did not reach its synchronization point.");
}

export async function delegatedRelayLaunch({
  engine,
  mode,
  launchFiles,
  args,
  wrapperPid,
}: {
  engine: string;
  mode: RelayOptions["mode"];
  launchFiles: LaunchFiles;
  args: string[];
  wrapperPid: number;
}) {
  await writeFile(launchFiles.ready, "ready");
  try {
    if (mode === "interrupted-launch") {
      // Reparenting must never turn this fault into a signal to an adopting runner.
      if (process.ppid !== wrapperPid) {
        throw new Error("The intended relay wrapper is no longer the parent.");
      }
      process.kill(wrapperPid, "SIGKILL");
    }
    await waitForRelayFile(launchFiles.release);
    const output = execFileSync(engine, args, {
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    if (mode !== "interrupted-launch") {
      process.stdout.write(output);
    }
  } catch {
    process.stderr.write("Delegated relay launch failed.\n");
    process.exitCode = 1;
  } finally {
    writeFileSync(launchFiles.finished, "finished");
  }
}
