import assert from "node:assert/strict";
import childProcess, {
  type ChildProcessEventMap,
  type SpawnOptions,
  type SpawnSyncOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";

const launcher = process.env.OCE_TEST_WORKSPACE_LAUNCHER;
assert.ok(launcher === "harness" || launcher === "worker", "Expected a workspace launcher");
delete process.env.OCE_TEST_WORKSPACE_LAUNCHER;
const realSpawn = childProcess.spawn;
const realSpawnSync = childProcess.spawnSync;

// Doctor and native setup run for real. Only long-lived children and the
// dedicated worker's model-probe response are controlled.
Object.assign(childProcess, {
  spawn(command: string, args: readonly string[], options: SpawnOptions = {}) {
    if (args[1] === "doctor" || (launcher === "harness" && args[1] === "setup")) {
      return realSpawn(command, args, options);
    }
    if (launcher === "harness") {
      console.log("HARNESS_CHILD_STARTED " + (args[0] === "/app/openclaw.mjs" ? "node" : "codex"));
    } else {
      console.log("WORKER_CHILD_STARTED " + args[1]);
    }
    return new EventEmitter<Pick<ChildProcessEventMap, "error" | "exit">>();
  },
  spawnSync(command: string, args?: readonly string[], options?: SpawnSyncOptions) {
    if (launcher === "worker" && args?.includes("--probe")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          auth: {
            probes: {
              results: [
                {
                  provider: "openai",
                  model: "openai/state-migration",
                  source: "env",
                  status: "ok",
                },
              ],
            },
          },
        }),
      };
    }
    return realSpawnSync(command, args, options);
  },
});
