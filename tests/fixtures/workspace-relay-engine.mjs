import { execFileSync } from "node:child_process";

// Delegate to the real engine. Only the selected CLI boundary is delayed or
// interrupted; container creation, state, logs and deletion still use Docker.
export function relayEngine({ engine, mode, partialOutput }) {
  const args = process.argv.slice(2);
  const execute = (command, timeout = 60_000) =>
    execFileSync(engine, command, {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
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
    process.stdout.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    process.exitCode = typeof error.status === "number" ? error.status : 1;
  }
}
