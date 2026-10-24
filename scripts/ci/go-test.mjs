// Runs the Go CLI tests for CI and fails on any skipped test, as run-tests.mjs does for
// Node files: without -v, `go test` prints "ok" for a package whose tests all skipped.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("go", ["test", "-json", ...process.argv.slice(2), "./..."], {
  stdio: ["ignore", "pipe", "inherit"],
});
const counts = { pass: 0, fail: 0, skip: 0 };
const skipped = [];
const output = new Map();

for await (const line of createInterface({ input: child.stdout })) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    continue;
  }
  const key = `${event.Package} ${event.Test ?? ""}`;
  if (event.Action === "output") {
    // Keep each test's output to print it only when that test fails or skips.
    output.set(key, `${output.get(key) ?? ""}${event.Output}`);
    if (event.Test === undefined && /^(ok|FAIL|\?)\s/.test(event.Output)) {
      process.stdout.write(event.Output);
    }
    continue;
  }
  if (event.Test === undefined || !Object.hasOwn(counts, event.Action)) {
    continue;
  }
  counts[event.Action] += 1;
  if (event.Action !== "pass") {
    process.stdout.write(output.get(key) ?? `--- ${event.Action.toUpperCase()}: ${event.Test}\n`);
  }
  if (event.Action === "skip") {
    skipped.push(`${event.Package}.${event.Test}`);
  }
  output.delete(key);
}

const code = await new Promise((resolve) => child.on("close", (status) => resolve(status ?? 1)));
console.log(`go-test: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
for (const name of skipped) {
  console.error(`go-test: skipped test did not run: ${name}`);
}
process.exit(code !== 0 ? code : skipped.length > 0 ? 1 : 0);
