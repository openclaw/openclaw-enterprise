// Runs the Go CLI tests for CI and fails on any skipped test, as run-tests.mjs does for
// Node files: without -v, `go test` prints "ok" for a package whose tests all skipped.
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const args = process.argv.slice(2);
const split = args.includes("--split-stalled-archive");
const occdev = "github.com/openclaw/openclaw-enterprise/internal/occdev";
const target = "TestOpenShellArchiveBoundsAStalledAttempt";
const counts = { pass: 0, fail: 0, skip: 0 };
const skipped: string[] = [];
let failed = false;

type GoChild = ChildProcessByStdio<null, Readable, null>;

type Selection = { packages: string[]; filter: "-run" | "-skip" | undefined };

async function report(child: GoChild, selection?: Selection) {
  const pending = new Map<string, "empty" | "tested" | "no-files">(
    selection?.packages.map((pkg) => [pkg, "empty"]),
  );
  let namedTerminals = 0;
  // Each test's and package's output, printed only when it fails or skips.
  const output = new Map<string, string>();

  for await (const line of createInterface({ input: child.stdout })) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      if (selection) {
        throw new Error(`Malformed Go JSON: ${line}`);
      }
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
    if (selection && action === "build-fail") {
      failed = true;
      continue;
    }
    if (action === "build-output") {
      // Compiler errors arrive keyed by ImportPath, before the package's FAIL line.
      if (typeof text !== "string") {
        throw new TypeError("Invalid output for stdout");
      }
      process.stdout.write(text);
      continue;
    }
    const terminal = action === "pass" || action === "fail" || action === "skip";
    if (selection) {
      if (typeof action !== "string" || typeof pkg !== "string" || !pending.has(pkg)) {
        throw new Error(`Unexpected or already finished Go package: ${String(pkg)}`);
      }
      if (action === "fail") {
        failed = true;
      }
      if (test !== undefined) {
        if (typeof test !== "string" || !test || pending.get(pkg) === "no-files") {
          throw new Error(`Invalid test event for ${pkg}`);
        }
        pending.set(pkg, "tested");
        const isTarget = test === target || test.startsWith(`${target}/`);
        if (selection.filter && isTarget !== (selection.filter === "-run")) {
          throw new Error(`Unexpected test in ${selection.filter} stream: ${test}`);
        }
        if (selection.filter === "-run" && test === target && terminal) {
          namedTerminals += 1;
        }
      } else if (terminal) {
        if (
          (action === "skip") !== (pending.get(pkg) === "no-files") ||
          (action === "skip" && selection.filter)
        ) {
          throw new Error(`Unexpected package skip: ${pkg}`);
        }
        pending.delete(pkg);
      } else if (action === "output") {
        if (selection.filter === "-run" && String(text).includes("no tests to run")) {
          throw new Error("Isolated target reported no tests to run");
        }
        if (
          typeof text === "string" &&
          text.trimEnd().split(/\s+/).join(" ") === `? ${pkg} [no test files]`
        ) {
          if (pending.get(pkg) !== "empty") {
            throw new Error(`Conflicting no-test-files output: ${pkg}`);
          }
          pending.set(pkg, "no-files");
        }
      }
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

  if (selection?.filter === "-run" && namedTerminals !== 1) {
    throw new Error("Isolated target requires one named terminal");
  }
  if (pending.size) {
    throw new Error(`Missing package terminal: ${[...pending.keys()].join(", ")}`);
  }
}

const children = new Set<GoChild>();
async function run(packages: string[], filter?: Selection["filter"]) {
  const flags = split ? args.filter((arg) => arg !== "--split-stalled-archive") : args;
  const pattern = filter ? [filter, `^${target}$`] : [];
  const child = spawn("go", ["test", "-json", ...flags, ...pattern, ...packages], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: split && process.platform !== "win32",
  });
  children.add(child);
  child.on("error", (error) => {
    console.error(error);
    failed = true;
  });
  // Spawn errors are followed by close. Observe it even if parsing fails.
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    await report(child, split ? { packages, filter } : undefined);
  } catch (error) {
    if (!split) {
      throw error;
    }
    console.error(error);
    failed = true;
    child.stdout.resume();
  }
  const status = await closed;
  children.delete(child);
  return status ?? 1;
}

async function runSplit() {
  // Detached process groups let cancellation reach the test binaries Go started.
  const abort = new AbortController();
  const cancel = () => {
    abort.abort();
    for (const child of children) {
      if (!child.pid) {
        continue;
      }
      try {
        if (process.platform === "win32") {
          child.kill();
        } else {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
    }
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const { stdout, stderr } = await promisify(execFile)("go", ["list", "./..."], {
      signal: abort.signal,
    });
    process.stderr.write(stderr);
    const packages = stdout.trim().split(/\s+/);
    if (!packages.includes(occdev)) {
      throw new Error(`go list did not discover ${occdev}`);
    }
    if (abort.signal.aborted) {
      return 1;
    }
    const other = packages.filter((pkg) => pkg !== occdev);
    const statuses = await Promise.all([
      run([occdev], "-run"),
      run([occdev], "-skip"),
      ...(other.length ? [run(other)] : []),
    ]);
    return abort.signal.aborted || statuses.some((code) => code !== 0) ? 1 : 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

let status = 1;
try {
  status = split ? await runSplit() : await run(["./..."]);
} catch (error) {
  if (!split) {
    throw error;
  }
  console.error(error);
}
console.log(`go-test: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
for (const name of skipped) {
  console.error(`go-test: skipped test did not run: ${name}`);
}
process.exit(status !== 0 ? status : failed || skipped.length > 0 ? 1 : 0);
