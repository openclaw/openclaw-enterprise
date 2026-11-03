// Containers, volumes and networks an image test creates are not children of the test
// process. When a signal stops the test runner (a cancelled CI job, `timeout`, a stopped
// local run), Node exits without running `t.after` hooks, and those containers keep running
// for hours, with their CPU, memory and volumes. runDockerCommand labels each resource it
// creates with this process's owner value, so:
// - on SIGINT or SIGTERM this process removes the resources it owns before it exits;
// - after SIGKILL, which no process can handle, a later cleanup can still tell an orphan:
//   the label's host is the local host and no live process has that pid and start time.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export const testOwnerLabel = "org.openclaw.test.owner";

// "<host>/<pid>/<start>": the start (clock ticks after boot, /proc/<pid>/stat field 22)
// separates this process from a later one that reuses its pid. "-" where /proc is missing.
function processStartTicks() {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "-";
  } catch {
    return "-";
  }
}
export const testOwner = `${hostname()}/${process.pid}/${processStartTicks()}`;

// Where the label goes for each Docker command that creates a resource.
function labelPosition([command, subcommand]) {
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

let cleanupDocker;

// Returns `args` with the owner label when the command creates a resource, and from then on
// removes this process's resources on SIGINT and SIGTERM.
export function withTestOwnerLabel(dockerBin, args) {
  const at = labelPosition(args);
  if (at < 0) {
    return args;
  }
  if (cleanupDocker === undefined) {
    cleanupDocker = dockerBin;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        removeOwnedResources();
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
function removeOwnedResources() {
  const filter = `label=${testOwnerLabel}=${testOwner}`;
  const docker = (args) => {
    try {
      return execFileSync(cleanupDocker, args, {
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
  const containers = docker(["ps", "-aq", "--filter", filter]);
  if (containers.length > 0) {
    docker(["rm", "-f", "-v", ...containers]);
  }
  const volumes = docker(["volume", "ls", "-q", "--filter", filter]);
  if (volumes.length > 0) {
    docker(["volume", "rm", "-f", ...volumes]);
  }
  const networks = docker(["network", "ls", "-q", "--filter", filter]);
  if (networks.length > 0) {
    docker(["network", "rm", ...networks]);
  }
}
