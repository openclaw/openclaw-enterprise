import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { wholeNumber } from "./observations.mts";

const statePath = "/home/node/.openclaw/state";
const agentPath = "/home/node/.openclaw/agents/main/agent";
const attemptsPath = statePath + "/attempts";

function schemaVersion(argument: string | undefined) {
  assert.ok(argument?.length, "Expected a schema version");
  return wholeNumber(Number(argument));
}

function setSchema(path: string, version: number) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA user_version = " + version);
  } finally {
    database.close();
  }
}

function doctor(stateVersion: number, agentVersion: number) {
  const attempts = existsSync(attemptsPath)
    ? wholeNumber(Number(readFileSync(attemptsPath, "utf8")))
    : 0;
  writeFileSync(attemptsPath, String(attempts + 1));
  setSchema(statePath + "/openclaw.sqlite", stateVersion);
  setSchema(agentPath + "/openclaw-agent.sqlite", agentVersion);
  const accepted = process.env.OCE_TEST_DOCTOR_ACCEPT === "1";
  const result = accepted
    ? { status: "ok" }
    : { status: "error", maintenanceRefusal: { kind: "data-at-risk", reason: "active-mutation" } };
  console.log("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH=" + JSON.stringify(result));
  process.exitCode = accepted ? 0 : 1;
}

function snapshot() {
  const marker = [
    statePath + "/.oce-maintenance-pending",
    "/home/node/.openclaw/.oce-maintenance-pending",
  ].find((path) => existsSync(path));
  console.log(
    JSON.stringify({
      attempts: wholeNumber(Number(readFileSync(attemptsPath, "utf8"))),
      pending: marker !== undefined,
      mode: marker === undefined ? null : statSync(marker).mode & 0o777,
    }),
  );
}

if (import.meta.main) {
  const [, , command, first, second] = process.argv;
  switch (command) {
    case "seed":
      setSchema(agentPath + "/openclaw-agent.sqlite", schemaVersion(first));
      break;
    case "doctor":
      doctor(schemaVersion(first), schemaVersion(second));
      break;
    case "snapshot":
      snapshot();
      break;
    case "gateway":
      console.log("GATEWAY_CHILD_STARTED");
      setInterval(() => {}, 1000);
      break;
    default:
      throw new Error("Unknown maintenance fixture command");
  }
} else {
  const spawn = childProcess.spawn;
  const stateVersion = schemaVersion(process.env.OCE_TEST_STATE_SCHEMA);
  const agentVersion = schemaVersion(process.env.OCE_TEST_AGENT_SCHEMA);
  delete process.env.NODE_OPTIONS;
  delete process.env.OCE_TEST_STATE_SCHEMA;
  delete process.env.OCE_TEST_AGENT_SCHEMA;
  // Exclusive creation proves that this replacement received a fresh HOME tmpfs.
  writeFileSync("/home/node/previous-container", "transient", { flag: "wx", mode: 0o600 });
  // Replace only Doctor and the long-lived Gateway. This preload is synchronous
  // so the real Kubernetes entrypoint sees the override before its first spawn.
  Object.assign(childProcess, {
    spawn(command: string, args: readonly string[], options: SpawnOptions = {}) {
      if (args[0] === "/app/openclaw.mjs" && args[1] === "doctor") {
        return spawn(
          process.execPath,
          [
            "/runtime-state-fixture/maintenance.mts",
            "doctor",
            String(stateVersion),
            String(agentVersion),
          ],
          options,
        );
      }
      if (args[0] === "/app/openclaw.mjs" && args[1] === "gateway") {
        return spawn(
          process.execPath,
          ["/runtime-state-fixture/maintenance.mts", "gateway"],
          options,
        );
      }
      return spawn(command, args, options);
    },
  });
}
