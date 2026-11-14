import { readFileSync, watch } from "node:fs";
import test from "node:test";

const repositoryUrl = readFileSync(new URL("repository-url", import.meta.url), "utf8");
const {
  emitOpenShellProgress,
  openShellProgressPrefix,
}: typeof import("../../scripts/ci/openshell-progress.mjs") = await import(
  new URL("scripts/ci/openshell-progress.mjs", repositoryUrl).href
);

function write(text: string) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

const record = (value: unknown) => openShellProgressPrefix + JSON.stringify(value) + "\n";

// The legitimate start/pass record also crosses many reporter pipe chunks.
test("live progress " + "x".repeat(1024 * 1024), async (context) => {
  const stage = { kind: "openshell-stage", stage: "installation", outcome: "started" };
  for (const invalid of [
    { ...stage, kind: "private-kind-canary" },
    { ...stage, stage: "private-stage-canary" },
    { ...stage, outcome: "private-outcome-canary" },
    { ...stage, detail: "private-detail-canary" },
    { ...stage, elapsedMs: 1 },
    { ...stage, file: "private-file-canary" },
    null,
    [stage],
  ]) {
    await write(record(invalid));
  }
  // An oversized line must be dropped through newline, including its valid-looking suffix.
  const split = record({ ...stage, detail: "private-fragment-canary" });
  await write(split.slice(0, 8));
  await write(split.slice(8));
  await write(openShellProgressPrefix + "private-oversized-canary".repeat(50000));
  await write(record(stage));
  await write(openShellProgressPrefix + "private-malformed-canary\n");

  // Subscribe before the actual producer runs: only live progress releases the test.
  const { promise: released, resolve } = Promise.withResolvers<void>();
  const watcher = watch(process.cwd(), (_event, name) => {
    if (name === "release") {
      watcher.close();
      resolve();
    }
  });
  context.after(() => watcher.close());
  // Fill the tail through its batch boundary, retaining a real blank and an unfinished line.
  await write(
    Array.from({ length: 798 }, (_, index) => "useful line " + index).join("\n") +
      "\n\nunfinished ordinary output",
  );
  emitOpenShellProgress("installation", "started");
  await released;
  emitOpenShellProgress("installation", "passed");
  context.diagnostic(
    "openclaw-ci-measurement " + JSON.stringify({ ...stage, outcome: "passed", elapsedMs: 123 }),
  );
});

test("failed stage", async () => {
  emitOpenShellProgress("initial-model", "started");
  try {
    throw new Error("expected stage failure");
  } finally {
    emitOpenShellProgress("initial-model", "failed");
    // An unterminated record is neither live progress nor raw failure output.
    await write(
      record({ kind: "openshell-stage", stage: "replacement", outcome: "started" }).slice(0, -1),
    );
  }
});
