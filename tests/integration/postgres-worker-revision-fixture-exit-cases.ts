import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

// Runs `body` as a test file of its own under the revision fixture (created with `fixtureOptions`),
// needing no PostgreSQL, and returns its output once its process exits with `status`, or fails
// after 30 s naming the file as still running.
async function runFixtureFile(
  t: TestContext,
  body: string,
  {
    fixtureOptions,
    status: expectedStatus = 0,
  }: {
    fixtureOptions: NonNullable<Parameters<typeof createWorkerRevisionFixtures>[1]>;
    status?: number;
  },
) {
  const directory = await temporaryDirectory(t, "revision-fixture-exit-");
  const file = join(directory, "abandoned.test.mjs");
  const helper = new URL("../helpers/postgres-worker-revision-fixture.mjs", import.meta.url);
  await writeFile(
    file,
    `import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createWorkerRevisionFixtures, disposeStep } from ${JSON.stringify(helper.href)};
const { cleanup } = createWorkerRevisionFixtures(import.meta.url, ${JSON.stringify(fixtureOptions)});
// A pool.end() that never settles while its socket keeps the event loop alive.
const abandonStep = () =>
  assert.rejects(
    disposeStep("pool end", 100, () => {
      setInterval(() => {}, 1_000);
      return new Promise(() => {});
    }),
    { message: "revision fixture teardown: pool end did not finish within 100 ms" },
  );
after(cleanup);
${body}`,
  );
  // A test runner of its own (this file's context would make it skip the file), in its own
  // process group, so a file that never exits can be killed with its test process.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", file], {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  let closed = false;
  let timedOut = false;
  const killGroup = () => {
    if (pid === undefined || closed) {
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  };
  t.after(killGroup);

  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
  }
  const result = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        closed = true;
        resolve({ status, signal });
      });
    },
  );
  const limit = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, 30_000);
  const { status, signal } = await result.finally(() => clearTimeout(limit));
  assert.ok(typeof pid === "number" && pid > 0, "the fixture test process started");
  assert.equal(timedOut, false, `the file was still running after 30 s:\n${output}`);
  assert.equal(signal, null, `the fixture test process exited on a signal:\n${output}`);
  assert.equal(status, expectedStatus, output);
  assert.match(output, /revision fixture teardown: pool end did not finish within 100 ms/);
  return output;
}

// The fixture's 2 s exit grace and 60 s backstop leave a real file's runner time to report. The
// one-test files below take a shorter grace (and backstop) so their own waits stay short; each
// wait they race stays longer than the grace, as the defaults are.
const exitGraceMs = 500;

// Finding 1223: a teardown step left running past its limit can hold its process open (a pool's
// socket, a child), so the file sat idle after its last test until the runner's file timeout
// killed it. A file that abandoned a step now exits once its own teardown is done. Runs the
// fixture's real teardown step in its own test process.
export async function exitAfterAbandonedStep(t: TestContext) {
  const output = await runFixtureFile(
    t,
    `// A root after hook registered after cleanup, slower than the exit grace, still finishes.
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, ${exitGraceMs * 2}));
  console.log("later after hook finished");
});
test("a stuck step is abandoned at its limit", async () => {
  assert.equal(await disposeStep("worker stop", 5_000, () => "stopped"), "stopped");
  await abandonStep();
});
`,
    { fixtureOptions: { exitGraceMs } },
  );
  // Finding 1246: the exit grace starts once every root after hook has run, not at cleanup.
  assert.match(output, /later after hook finished/);
}

// Finding 1246: a step a root after hook after cleanup abandons also ends the file.
export async function exitAfterLateAbandonedStep(t: TestContext) {
  await runFixtureFile(
    t,
    `after(abandonStep);
test("nothing is abandoned during the tests", () => {});
`,
    { fixtureOptions: { exitGraceMs } },
  );
}

// Finding 1258: node:test skips the remaining after hooks after a failing one, so a root after
// hook after cleanup that throws also skips the hook that starts the exit grace. The backstop
// cleanup arms once a step was abandoned still ends the file, and its failure is still reported.
export async function exitAfterLaterHookFails(t: TestContext) {
  const output = await runFixtureFile(
    t,
    `after(() => {
  throw new Error("later after hook failed");
});
test("a stuck step is abandoned at its limit", abandonStep);
`,
    { fixtureOptions: { exitGraceMs, exitBackstopMs: exitGraceMs * 2 }, status: 1 },
  );
  assert.match(output, /later after hook failed/);
}

// Finding 1258: the same when the failing later hook is the one that abandoned the step.
export async function exitAfterAbandoningHookFails(t: TestContext) {
  const output = await runFixtureFile(
    t,
    `after(async () => {
  await abandonStep();
  throw new Error("later after hook failed");
});
test("nothing is abandoned during the tests", () => {});
`,
    { fixtureOptions: { exitGraceMs, exitBackstopMs: exitGraceMs * 2 }, status: 1 },
  );
  assert.match(output, /later after hook failed/);
}
