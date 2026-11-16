// Docker resources outlive a cancelled test runner. Label containers, volumes and networks
// so the runner can remove its own resources on SIGINT or SIGTERM and orphan cleanup can
// identify them by host, PID and process start time after SIGKILL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export const testOwnerLabel = "org.openclaw.test.owner";

// "<host>/<pid>/<start>": the start (clock ticks after boot, /proc/<pid>/stat field 22)
// separates this process from a later one that reuses its pid. "-" where /proc is missing.
function processStartTicks(): string {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "-";
  } catch {
    return "-";
  }
}
export const testOwner = `${hostname()}/${process.pid}/${processStartTicks()}`;

// Where the label goes for each Docker command that creates a resource.
function labelPosition([command, subcommand]: readonly unknown[]): number {
  if (command === "run" || command === "create") {
    return 1;
  }
  if (command === "container" && (subcommand === "run" || subcommand === "create")) {
    return 2;
  }
  if ((command === "volume" || command === "network") && subcommand === "create") {
    return 2;
  }
  return -1;
}

let cleanupRegistered = false;

// Returns `args` with the owner label when the command creates a resource, and from then on
// removes this process's resources on SIGINT and SIGTERM.
export function withTestOwnerLabel<Argument>(
  dockerBin: string,
  args: readonly Argument[],
): readonly (Argument | string)[] {
  const at = labelPosition(args);
  if (at < 0) {
    return args;
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
      const handler = () => {
        removeOwnedResources(dockerBin);
        process.removeListener(signal, handler);
        // The test runner's own handler, when present, reports and exits; without one,
        // end the process as the signal would have.
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      };
      process.on(signal, handler);
    }
  }
  return [...args.slice(0, at), "--label", `${testOwnerLabel}=${testOwner}`, ...args.slice(at)];
}

// Synchronous: the process exits right after the signal handlers return.
function removeOwnedResources(dockerBin: string) {
  const filter = `label=${testOwnerLabel}=${testOwner}`;
  const docker = (args: readonly string[]): string[] => {
    try {
      return execFileSync(dockerBin, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  // Remove containers first so their mounts and network attachments are released.
  for (const [listArgs, removeArgs] of [
    [
      ["ps", "-aq"],
      ["rm", "-f", "-v"],
    ],
    [
      ["volume", "ls", "-q"],
      ["volume", "rm", "-f"],
    ],
    [
      ["network", "ls", "-q"],
      ["network", "rm"],
    ],
  ] satisfies [string[], string[]][]) {
    const owned = docker([...listArgs, "--filter", filter]);
    if (owned.length > 0) {
      docker([...removeArgs, ...owned]);
    }
  }
}
