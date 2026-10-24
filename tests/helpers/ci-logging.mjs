import { execFile } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  ciOtelBackendResourceKind,
  cleanupLogging,
  prepareLogging,
} from "../../scripts/ci/logging.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

const digest = "a".repeat(64);
const collectorImage = `registry.example/otelcol@sha256:${digest}`;
const execFileAsync = promisify(execFile);
// The CI scripts bound commands with `timeoutMs` and read a timeout as `timedOut`, as
// scripts/ci/prepare.mjs's executor does; Node's execFile names the option `timeout`.
async function execute(command, args, { timeoutMs, ...options } = {}) {
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
  try {
    return await execFileAsync(command, args, {
      ...options,
      ...(bounded ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    });
  } catch (error) {
    if (bounded && error.killed && error.signal === "SIGKILL" && error.code == null) {
      error.timedOut = true;
    }
    throw error;
  }
}
const selectedCollectorSmoke = process.env.OCC_TEST_LOGGING_COLLECTOR === "1";

// The Collector's file exporter appends one JSON line per export through a
// buffered writer, so a test that polls the file can read a line cut at any byte
// (or a whole object whose newline is not flushed yet). Only newline-terminated
// lines are records; the rest waits for the next poll instead of failing the
// parse ("Unterminated string in JSON" under load).
function completeJsonLines(text) {
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

async function readJsonlPayloads(path) {
  try {
    return completeJsonLines(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function payloadContains(value, payloads) {
  return JSON.stringify(payloads).includes(value);
}

async function fixture(t) {
  const root = await temporaryDirectory(t, "ci-logging-test-");
  await chmod(root, 0o700);
  return root;
}

export {
  ciOtelBackendResourceKind,
  cleanupLogging,
  collectorImage,
  completeJsonLines,
  execute,
  fixture,
  payloadContains,
  prepareLogging,
  readJsonlPayloads,
  selectedCollectorSmoke,
};
