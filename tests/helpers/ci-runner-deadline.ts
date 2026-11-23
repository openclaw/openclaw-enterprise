import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  openShellProgressPrefix,
  upstreamOutageCase,
} from "../../scripts/ci/openshell-progress.mjs";
import { isRecord } from "../../scripts/ci/records.ts";
import reporter from "../../scripts/ci/reporter.ts";
import { runNode as runNative } from "../../scripts/ci/runner-process.ts";

export * from "../../scripts/ci/runner-process.ts";

export const timeoutReceipt = "state/deadline-timeout.json";
export const readinessReceipt = "state/deadline-readiness.json";
export const pendingMessage = "deadline-fixture: activation poll pending";
const barrier = {
  kind: "openshell-installation",
  stage: "workspace-helm",
  invocation: 1,
  outcome: "entered",
  offsetMs: 0,
};
function saveReceipt(cwd: string, path: string, value: object) {
  writeFileSync(join(cwd, path), JSON.stringify(value), { flag: "wx" });
}

const barrierMessage = openShellProgressPrefix + JSON.stringify(barrier) + "\n";

function collectedBeforeBarrier(stdout: string, cwd: string) {
  try {
    const witness: unknown = JSON.parse(readFileSync(join(cwd, readinessReceipt), "utf8"));
    if (!isRecord(witness) || !Array.isArray(witness.progress)) {
      return false;
    }
    // runNode dispatches on the barrier in this same ordered stream.
    const progress: unknown[] = [];
    for (const line of stdout.split("\n").slice(0, -1)) {
      if (!line) {
        continue;
      }
      const row: unknown = JSON.parse(line);
      if (isRecord(row) && row.type === "test:progress") {
        progress.push(row.data);
      }
    }
    return isDeepStrictEqual(progress, [...witness.progress, barrier]);
  } catch {
    return false;
  }
}

const self = new URL(import.meta.url);
const cli = new URL("../../scripts/ci/run-tests.ts", self).href;

export function observeDeadline(controlled: boolean) {
  return ["--import", new URL(controlled ? "?preload=controlled" : "?preload=wall", self).href];
}

if (self.searchParams.has("preload")) {
  const adapter = new URL(`?adapter=${self.searchParams.get("preload")}`, self).href;
  // Replace only the CLI's import. The adapter still calls the original runNode.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(
        context.parentURL === cli && specifier === "./runner-process.ts" ? adapter : specifier,
        context,
      );
    },
  });
}

export const runNode: typeof runNative = async (args, options) => {
  const controlled = self.searchParams.get("adapter") === "controlled";
  if (controlled) {
    const reporterIndex = args.indexOf("--test-reporter") + 1;
    assert.equal(args[reporterIndex], fileURLToPath(new URL("../../scripts/ci/reporter.ts", self)));
    args = args.with(reporterIndex, fileURLToPath(self));
  }
  type Trigger = "wall" | "readiness";
  let expireEarly: (() => void) | undefined;
  let dispatch: { trigger: Trigger; elapsedMs: number; delay: number } | undefined;
  const nativeTimer = setTimeout;
  // runNode synchronously arms one file timer. Controlled cases dispatch its
  // callback only after reporter readiness; startup must not race the wall clock.
  // Graces and every timer outside this call retain the ordinary clock, including
  // the fixture's outer timeout if readiness never arrives.
  const timer = mock.method(globalThis, "setTimeout", arm);
  function arm(callback: () => void, delay: number) {
    const armedAt = performance.now();
    const expire = (trigger: Trigger) => {
      const elapsedMs = performance.now() - armedAt;
      if (dispatch) {
        return;
      }
      dispatch = { trigger, elapsedMs, delay };
      callback();
    };
    expireEarly = () => expire("readiness");
    const handle = nativeTimer(() => expire("wall"), delay);
    if (controlled) {
      clearTimeout(handle);
    }
    return handle;
  }
  let pending: ReturnType<typeof runNative>;
  try {
    pending = runNative(args, {
      ...options,
      onProgress(progress) {
        // The barrier's arrival here proves earlier reporter rows were collected.
        if (controlled && isDeepStrictEqual(progress, barrier)) {
          expireEarly?.();
        } else {
          options.onProgress(progress);
        }
      },
    });
  } finally {
    timer.mock.restore();
  }
  const result = await pending;
  assert.equal(timer.mock.callCount(), 1, "expected only the native file timer during runNode");
  if (dispatch) {
    const { error, status, signal } = result;
    saveReceipt(options.cwd, timeoutReceipt, {
      ...dispatch,
      code: error?.code,
      status,
      signal,
      ...(controlled
        ? { orderedBeforeBarrier: collectedBeforeBarrier(result.stdout, options.cwd) }
        : {}),
    });
  }
  return result;
};

export default async function* deadlineReporter(source: Parameters<typeof reporter>[0]) {
  const entry = process.argv[1];
  const root = process.cwd();
  const selectedCase = [join(root, upstreamOutageCase.declaration), entry, upstreamOutageCase.name];
  const lifecycle: unknown[][] = [];
  const progress: unknown[] = [];
  let poll = 0;
  let selected = false;
  let announced = false;
  async function* observe() {
    for await (const event of source) {
      if (event.type === "test:interrupted" && announced) {
        // Include every lifecycle event up to SIGTERM, including duplicates after the barrier.
        saveReceipt(root, readinessReceipt, { lifecycle, progress, poll });
      }
      yield event;
      // The stock reporter consumed the event and yielded any rows it produced.
      const data = event.data;
      if (event.type === "test:dequeue" || event.type === "test:complete") {
        if (!isRecord(data)) {
          lifecycle.push([event.type]);
          continue;
        }
        const { file, entryFile, name, nesting, line, column } = data;
        const located =
          entryFile === undefined
            ? line === 1 && column === 1
            : typeof entryFile === "string" &&
              [line, column].every(
                (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
              );
        lifecycle.push([event.type, file, entryFile, name, nesting, located]);
        selected ||=
          event.type === "test:dequeue" && isDeepStrictEqual([file, entryFile, name], selectedCase);
      }
      if (
        event.type === "test:log" &&
        isRecord(data) &&
        data.message === pendingMessage &&
        data.nesting === 0 &&
        isDeepStrictEqual([data.file, data.entryFile, data.name], selectedCase)
      ) {
        poll++;
      }
      if (
        !announced &&
        poll !== 0 &&
        progress.length >= 9 &&
        selected &&
        event.type !== "test:interrupted"
      ) {
        announced = true;
        yield { type: "test:stdout", data: { message: barrierMessage } };
      }
    }
  }
  for await (const row of reporter(observe())) {
    if (row.startsWith('{"type":"test:progress",')) {
      const { data }: { data: unknown } = JSON.parse(row);
      if (isDeepStrictEqual(data, barrier)) {
        assert.ok(announced, "unexpected readiness barrier from the worker");
      } else {
        progress.push(data);
      }
    }
    yield row;
  }
}
