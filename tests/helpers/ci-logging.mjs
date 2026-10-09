import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  ciOtelBackendResourceKind,
  cleanupLogging,
  prepareLogging,
} from "../../scripts/ci/logging.mjs";

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

async function readJsonlPayloads(path) {
  try {
    const text = await readFile(path, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function waitFor(check, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(250);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

function payloadContains(value, payloads) {
  return JSON.stringify(payloads).includes(value);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-logging-test-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export {
  ciOtelBackendResourceKind,
  cleanupLogging,
  collectorImage,
  execute,
  fixture,
  payloadContains,
  prepareLogging,
  readJsonlPayloads,
  selectedCollectorSmoke,
  waitFor,
};
