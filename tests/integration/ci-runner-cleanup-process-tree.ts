import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { procStat } from "../helpers/ci-runner-fixture.ts";

interface CleanupProcessTree {
  commandPath: string;
  pidsPath: string;
  execArgv: string[];
  assertExited(): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validPid(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) {
    return undefined;
  }
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
  // A zombie still answers kill(pid, 0), but it has exited.
  return procStat(pid)?.state !== "Z";
}

async function ownedCommand(pid: number, marker: string): Promise<boolean> {
  try {
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    return args.includes(marker);
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH") || hasCode(error, "EACCES")) {
      return false;
    }
    throw error;
  }
}

async function stopOwnedCommands(marker: string): Promise<void> {
  // A failure can occur before an atomic PID record is written. Match the unique fixture
  // argument before signaling anything, including descendants that have been reparented.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const entry of await readdir("/proc")) {
      const pid = validPid(entry);
      if (pid === undefined || !(await ownedCommand(pid, marker))) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!hasCode(error, "ESRCH")) {
          throw error;
        }
      }
    }
  }
}

// Hold the runner after it lists /proc until the command records the late fork.
function killWindow(window: string, forked: string): string[] {
  const preload = new URL("../helpers/ci-runner-kill-window.ts", import.meta.url);
  preload.searchParams.set("window", window);
  preload.searchParams.set("forked", forked);
  return ["--import", preload.href];
}

export async function createCleanupProcessTree(
  t: TestContext,
  root: string,
): Promise<CleanupProcessTree> {
  const pidsPath = join(root, "state/command-pids");
  const windowPath = join(root, "state/kill-window");
  const latePath = join(root, "state/late-pid");
  const commandPath = join(root, "command.cjs");
  let provedExited = false;
  t.after(async () => {
    if (!provedExited) {
      await stopOwnedCommands(commandPath);
    }
  });

  const writeOnce = (path: string, value: string) =>
    `writeFileSync(${JSON.stringify(`${path}.partial`)}, ${value}); ` +
    `renameSync(${JSON.stringify(`${path}.partial`)}, ${JSON.stringify(path)});`;
  await writeFile(
    commandPath,
    [
      'const { spawn } = require("node:child_process");',
      'const { existsSync, renameSync, writeFileSync } = require("node:fs");',
      `const forever = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)", ${JSON.stringify(commandPath)}], {`,
      '  stdio: "ignore",',
      "});",
      "const descendant = forever();",
      writeOnce(pidsPath, 'process.pid + "\\n" + descendant.pid + "\\n"'),
      "const poll = setInterval(() => {",
      `  if (existsSync(${JSON.stringify(windowPath)})) {`,
      "    clearInterval(poll);",
      `    ${writeOnce(latePath, 'forever().pid + "\\n"')}`,
      "  }",
      "}, 10);",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
  );

  return {
    commandPath,
    pidsPath,
    execArgv: killWindow(windowPath, latePath),
    async assertExited() {
      const commandRecord = (await readFile(pidsPath, "utf8")).trim().split("\n");
      const lateRecord = (await readFile(latePath, "utf8")).trim().split("\n");
      assert.equal(commandRecord.length, 2, "the command recorded itself and its first descendant");
      assert.equal(lateRecord.length, 1, "the command recorded its late descendant");
      const pids = [...commandRecord, ...lateRecord].map((value) => {
        const pid = validPid(value);
        assert.ok(pid !== undefined, "all recorded PIDs are safe integers above 1");
        return pid;
      });
      assert.equal(new Set(pids).size, 3, "the command recorded three distinct PIDs");
      for (let attempt = 0; pids.some(running) && attempt < 50; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      assert.deepEqual(
        pids.filter(running),
        [],
        "the abandoned cleanup's commands outlived the runner",
      );
      provedExited = true;
    },
  };
}
