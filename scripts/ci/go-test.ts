// Runs the Go CLI tests for CI and fails on any skipped test, as run-tests.mjs does for
// Node files: without -v, `go test` prints "ok" for a package whose tests all skipped.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const child = spawn("go", ["test", "-json", ...process.argv.slice(2), "./..."], {
  stdio: ["ignore", "pipe", "inherit"],
});
const closed = once(child, "close");
const counts = { pass: 0, fail: 0, skip: 0 };
const skipped = [];
// Each test's and package's output, printed only when it fails or skips.
const output = new Map();

for await (const line of createInterface({ input: child.stdout })) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    continue;
  }
  if (event.Action === "build-output") {
    // Compiler errors arrive keyed by ImportPath, before the package's FAIL line.
    process.stdout.write(event.Output);
    continue;
  }
  const key = `${event.Package} ${event.Test ?? ""}`;
  if (event.Action === "output") {
    if (event.Test === undefined && /^(ok|FAIL|\?)\s/.test(event.Output)) {
      process.stdout.write(event.Output);
    } else {
      output.set(key, `${output.get(key) ?? ""}${event.Output}`);
    }
    continue;
  }
  if (event.Test === undefined) {
    if (event.Action === "fail") {
      // A crash, timeout or TestMain failure ends the package without ending its
      // running tests: print their output and the package's, and count them as failed.
      for (const [entry, text] of output) {
        if (entry.startsWith(`${event.Package} `)) {
          process.stdout.write(text);
          output.delete(entry);
          if (entry !== key) {
            counts.fail += 1;
          }
        }
      }
    }
    output.delete(key);
    continue;
  }
  if (!Object.hasOwn(counts, event.Action)) {
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

const [status] = await closed;
console.log(`go-test: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
for (const name of skipped) {
  console.error(`go-test: skipped test did not run: ${name}`);
}
process.exit(status !== 0 ? (status ?? 1) : skipped.length > 0 ? 1 : 0);
