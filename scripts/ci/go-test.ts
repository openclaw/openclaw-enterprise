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
const skipped: string[] = [];
// Each test's and package's output, printed only when it fails or skips.
const output = new Map<string, string>();

for await (const line of createInterface({ input: child.stdout })) {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    continue;
  }
  if (event === null) {
    throw new TypeError("Cannot read properties of null");
  }
  const action = typeof event === "object" && "Action" in event ? event.Action : undefined;
  const pkg = typeof event === "object" && "Package" in event ? event.Package : undefined;
  const test = typeof event === "object" && "Test" in event ? event.Test : undefined;
  const text = typeof event === "object" && "Output" in event ? event.Output : undefined;
  if (action === "build-output") {
    // Compiler errors arrive keyed by ImportPath, before the package's FAIL line.
    if (typeof text !== "string") {
      throw new TypeError("Invalid output for stdout");
    }
    process.stdout.write(text);
    continue;
  }
  const key = `${String(pkg)} ${String(test ?? "")}`;
  if (action === "output") {
    if (test === undefined && /^(ok|FAIL|\?)\s/.test(String(text))) {
      if (typeof text !== "string") {
        throw new TypeError("Invalid output for stdout");
      }
      process.stdout.write(text);
    } else {
      output.set(key, `${output.get(key) ?? ""}${String(text)}`);
    }
    continue;
  }
  if (test === undefined) {
    if (action === "fail") {
      // A crash, timeout or TestMain failure ends the package without ending its
      // running tests: print their output and the package's, and count them as failed.
      for (const [entry, text] of output) {
        if (entry.startsWith(`${String(pkg)} `)) {
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
  const actionKey = String(action);
  if (actionKey !== "pass" && actionKey !== "fail" && actionKey !== "skip") {
    continue;
  }
  counts[actionKey] += 1;
  if (action !== "pass") {
    let text = output.get(key);
    if (text === undefined) {
      if (typeof action !== "string") {
        throw new TypeError("Action has no toUpperCase method");
      }
      text = `--- ${action.toUpperCase()}: ${String(test)}\n`;
    }
    process.stdout.write(text);
  }
  if (action === "skip") {
    skipped.push(`${String(pkg)}.${String(test)}`);
  }
  output.delete(key);
}

const [status]: unknown[] = await closed;
if (status !== null && typeof status !== "number") {
  throw new TypeError("Unexpected child exit status");
}
console.log(`go-test: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
for (const name of skipped) {
  console.error(`go-test: skipped test did not run: ${name}`);
}
process.exit(status !== 0 ? (status ?? 1) : skipped.length > 0 ? 1 : 0);
