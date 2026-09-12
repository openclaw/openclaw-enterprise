#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "node:test";
import { tap, spec, dot } from "node:test/reporters";

const usage = `Usage: node scripts/test-files.mjs [options] -- <file.test.mjs> [...]
Options (each at most once, before --):
  --test-concurrency=N          Positive integer; default 1
  --test-name-pattern=REGEXP    JavaScript regular expression
  --test-reporter=tap|spec|dot   Default tap
  --help                       Show this help alone
Files are literal existing in-repository .test.{js,cjs,mjs,ts,cts,mts} paths.
Selection validates files, not intended case coverage. No discovery or preparation.`;

function selection(args) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1)
    throw new Error("Provide at least one explicit test file after --.");
  const options = { concurrency: 1, reporter: "tap" };
  const seen = new Set();
  for (const option of args.slice(0, separator)) {
    const match = /^--(test-concurrency|test-name-pattern|test-reporter)=(.*)$/s.exec(option);
    if (!match || seen.has(match[1])) throw new Error(`Unsupported or repeated option: ${option}`);
    const [, name, value] = match;
    seen.add(name);
    if (name === "test-concurrency") {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error("--test-concurrency must be a positive safe integer.");
      options.concurrency = Number(value);
    } else if (name === "test-name-pattern") {
      if (!value) throw new Error("--test-name-pattern must not be empty.");
      options.testNamePatterns = new RegExp(value);
    } else {
      if (!["tap", "spec", "dot"].includes(value))
        throw new Error(`Unsupported reporter: ${value}`);
      options.reporter = value;
    }
  }
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const files = args.slice(separator + 1).map((file) => {
    if (!/\.test\.(?:[cm]?[jt]s)$/.test(file))
      throw new Error(`Unsupported test filename: ${file}`);
    const absolute = resolve(file);
    const physical = realpathSync(absolute);
    for (const candidate of [absolute, physical]) {
      const path = relative(root, candidate);
      if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
        throw new Error(`Test file is outside this repository: ${file}`);
    }
    if (!statSync(physical).isFile()) throw new Error(`Test path is not a regular file: ${file}`);
    // Use the selected path for normal module resolution, after checking its target.
    return absolute;
  });
  const identities = files.map((file) => realpathSync(file));
  if (new Set(identities).size !== files.length)
    throw new Error("Duplicate test files are not supported.");
  return { ...options, files };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const { reporter, ...options } = selection(args);
  console.error(
    `Selected ${options.files.length} test file(s); case coverage depends on tests and filters.`,
  );
  const controller = new AbortController();
  let interrupted;
  const interrupt = (signal) => {
    interrupted ??= signal;
    controller.abort();
  };
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [signal, () => interrupt(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    // Unlike CLI glob operands, files are literal paths. Node owns scheduling,
    // child-process isolation, hooks and lifecycle; forceExit remains disabled.
    const stream = run({ ...options, isolation: "process", signal: controller.signal });
    stream.on("test:fail", (event) => {
      if (!event.todo) process.exitCode = 1;
    });
    for await (const chunk of stream.compose({ tap, spec, dot }[reporter])) {
      if (!process.stdout.write(chunk)) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
    }
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    // The stream can finish before child exit handles are reaped. Let Node drain
    // those handles before reporting actual signal termination to our caller.
    if (interrupted) process.once("beforeExit", () => process.kill(process.pid, interrupted));
  }
}

main().catch((error) => {
  console.error(`test-files: ${error.message}`);
  process.exitCode = 1;
});
