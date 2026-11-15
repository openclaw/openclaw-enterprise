import assert from "node:assert/strict";
import test from "node:test";
import { forwardWork } from "./ownership.ts";
import type { ClientCommand } from "../repository-credentials/clients.ts";
import { run as runCommand } from "../repository-credentials/process.mjs";

export type TimeoutMarkerPaths = [late: string, cleaned: string];

const run = runCommand as ClientCommand;
const [, , late, cleaned] = process.argv;
assert.ok(late && cleaned);
const lateCommand = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late command'), 600)`;
const lateStart = `require('node:fs').writeFileSync(process.argv[1], 'late start')`;
const writeCleaned = `require('node:fs').writeFileSync(process.argv[1], 'done')`;

test("expected timeout", { timeout: 200 }, async (t) => {
  const work = forwardWork(t.signal);
  t.after(async () => {
    await work.stop();
    await Promise.allSettled([body]);
    await run(process.execPath, ["-e", writeCleaned, cleaned], {
      signal: AbortSignal.timeout(2000),
    });
  });
  const body = (async () => {
    try {
      await work.command(process.execPath, ["-e", lateCommand, late]);
    } catch {
      // A caller swallowing the cancelled command still cannot start forward work.
    }
    await work.command(process.execPath, ["-e", lateStart, late]);
  })();
  await body;
});
