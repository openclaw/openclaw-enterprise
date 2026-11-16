import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createRunnerFixture,
  laneArgs,
  runRunnerSync,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { hasStringField, isArray, isRecord } from "../helpers/egress-observation-values.ts";

type ReadEvidence =
  typeof import("../helpers/harness-topology-k3d-real.mjs").readDedicatedNativeChildEvidence;
type Fault = "connect" | "child-read";
type StageDiagnostic = { kind: "topology-native-child"; stage: Fault };
type FixtureCase = [
  name: string,
  options: { fault: Fault; missingReceipt?: boolean } | { diagnostic: Record<string, string> },
  expected: StageDiagnostic | undefined,
];

const exec = promisify(execFile);
const socketStub = `
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const originalRequire = Module.prototype.require;
class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = Socket.OPEN;
  constructor() {
    super();
    queueMicrotask(() => {
      if (fault === "connect") this.emit("error", new Error("synthetic socket error"));
      else this.emit("open");
    });
  }
  send(text) {
    const { id, method, params } = JSON.parse(text);
    if (id === undefined) return;
    const response = { id, result: {} };
    if (method === "thread/read") {
      response.result.thread = params.threadId === "synthetic-parent"
        ? { id: "synthetic-parent", turns: [{ items: [
            { type: "subAgentActivity", kind: "started", agentThreadId: "synthetic-child" },
          ] }] }
        : { id: "synthetic-child", parentThreadId: "synthetic-parent", turns: [{
            status: "completed", items: [{ type: "agentMessage", text: answer }],
          }] };
      if (fault === "child-read" && params.threadId === "synthetic-child") {
        response.error = { code: -1 };
      }
    }
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(response))));
  }
  terminate() { this.emit("close"); }
}
Module.prototype.require = function (id) {
  return id === "ws" ? Socket : originalRequire.call(this, id);
};
`;

function readSyntheticNativeChild(
  readEvidence: ReadEvidence,
  fault?: Fault,
  onFailure?: (error: unknown) => void | Promise<void>,
): Promise<unknown> {
  const marker = `synthetic-answer-${randomUUID()}`;
  return readEvidence(
    "unused-namespace",
    "unused-pod",
    "synthetic-parent",
    marker,
    `reply with ${marker}`,
    async (_namespace: string, _pod: string, script: string) => {
      try {
        const { stdout } = await exec(process.execPath, [
          "-e",
          `const fault = ${JSON.stringify(fault)};\nconst answer = ${JSON.stringify(marker)};\n${socketStub}\n${script}`,
        ]);
        return stdout;
      } catch (error) {
        await onFailure?.(error);
        throw error;
      }
    },
  );
}

async function recordSyntheticReceipt(
  error: unknown,
  receiptPath: string,
  missingReceipt: boolean | undefined,
) {
  assert.ok(error instanceof Error && hasStringField(error, "stdout"));
  const output: unknown = JSON.parse(error.stdout);
  assert.ok(hasStringField(output, "receipt"));
  await appendFile(receiptPath, output.receipt + "\n", { mode: 0o600 });
  if (missingReceipt) {
    error.stdout = "";
  }
}

function requireRows(value: unknown) {
  assert.ok(isArray(value) && value.every(isRecord), "expected an array of result objects");
  return value;
}

test("native child query retains only an observed stage from its own failed exec", async () => {
  const { readDedicatedNativeChildEvidence } =
    await import("../helpers/harness-topology-k3d-real.mjs");

  for (const [fault, stage, replacement, frozen] of [
    ["connect", "connect"],
    ["child-read", "child-read"],
    ["child-read", undefined, ""],
    ["child-read", undefined, { stage: "synthetic-unsupported-stage" }],
    ["child-read", undefined, { receipt: "synthetic-other-receipt" }],
    ["child-read", undefined, undefined, true],
  ] as const) {
    let original: unknown;
    await assert.rejects(
      readSyntheticNativeChild(readDedicatedNativeChildEvidence, fault, (error) => {
        original = error;
        assert.ok(error instanceof Error && hasStringField(error, "stdout"));
        if (typeof replacement === "string") {
          error.stdout = replacement;
        } else if (replacement) {
          const output: unknown = JSON.parse(error.stdout);
          assert.ok(isRecord(output));
          error.stdout = JSON.stringify({ ...output, ...replacement });
        }
        if (frozen) {
          Object.freeze(error);
        }
      }),
      (error: unknown) => {
        assert.ok(error === original, "the original exec error must be rethrown");
        assert.ok(error instanceof Error && hasStringField(error, "stderr"));
        assert.equal(error.code, 1);
        assert.equal(error.signal, null);
        assert.ok(error.stderr.includes("Native child evidence"));
        assert.deepEqual(
          error.openclawCiDiagnostic,
          stage === undefined ? undefined : { kind: "topology-native-child", stage },
        );
        return true;
      },
    );
  }

  const evidence = await readSyntheticNativeChild(readDedicatedNativeChildEvidence);
  assert.ok(isRecord(evidence) && isRecord(evidence.observation));
  assert.equal(evidence.parentThreadId, "synthetic-parent");
  assert.equal(evidence.childThreadId, "synthetic-child");
  assert.equal(evidence.observation.stage, "complete");
  assert.equal(evidence.observation.completedNonceTurn, true);
});

test("runner reports a native child stage only on the canonical failed topology case", async (t) => {
  const root = await createRunnerFixture(t);
  const topologyFile = "tests/integration/harness-topology-k3d-real.test.mjs";
  const otherFile = `other/${topologyFile}`;
  const nativeChild = "native child returns its own exact answer";
  const kind = "topology-native-child";
  const fakeText = "synthetic-untrusted-stage-text";
  const knownDiagnostic: StageDiagnostic = { kind, stage: "connect" };
  const cases: FixtureCase[] = [
    [nativeChild, { fault: "connect" }, knownDiagnostic],
    [nativeChild, { fault: "child-read" }, { kind, stage: "child-read" }],
    [nativeChild, { fault: "child-read", missingReceipt: true }, undefined],
    [nativeChild, { diagnostic: { kind, stage: fakeText } }, undefined],
    [nativeChild, { diagnostic: { ...knownDiagnostic, payload: fakeText } }, undefined],
    ["unrelated topology child", { fault: "connect" }, undefined],
  ];
  const otherCases: FixtureCase[] = [[nativeChild, { fault: "connect" }, undefined]];
  const receiptPath = join(root, "state/native-child-receipts");
  const helper = new URL("../helpers/harness-topology-k3d-real.mjs", import.meta.url);
  const guards = new URL("../helpers/egress-observation-values.ts", import.meta.url);

  // Both generated fixtures retain their .mjs paths, including the runner's canonical path.
  const fixtureSource = (fileCases: FixtureCase[]) =>
    stripTypeScriptTypes(`
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { hasStringField } from ${JSON.stringify(guards.href)};
import { readDedicatedNativeChildEvidence } from ${JSON.stringify(helper.href)};
const exec = promisify(execFile);
const socketStub = ${JSON.stringify(socketStub)};
const readSyntheticNativeChild = ${readSyntheticNativeChild.toString()};
const recordSyntheticReceipt = ${recordSyntheticReceipt.toString()};
for (const [index, { name, fault, missingReceipt, diagnostic }] of ${JSON.stringify(
      fileCases.map(([name, options]) => ({ name, ...options })),
    )}.entries()) {
  test("synthetic topology parent " + index, async (context) => {
    await context.test(name, async () => {
      process.stderr.write(${JSON.stringify(`${kind}: ${fakeText}\n`)});
      if (fault) {
        return readSyntheticNativeChild(readDedicatedNativeChildEvidence, fault, (error) =>
          recordSyntheticReceipt(error, ${JSON.stringify(receiptPath)}, missingReceipt),
        );
      }
      throw Object.assign(new Error("synthetic native query failure"), {
        openclawCiDiagnostic: diagnostic,
      });
    });
  });
}
`);
  const cleanupPath = join(root, "state/native-child-cleanups");
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    `import { appendFile } from "node:fs/promises";
export async function prepareFile() {
  return { cleanup: () => appendFile(${JSON.stringify(cleanupPath)}, "cleaned\\n") };
}
`,
  );
  await mkdir(join(root, "other/tests/integration"), { recursive: true });
  await writeFile(join(root, topologyFile), fixtureSource(cases));
  await writeFile(join(root, otherFile), fixtureSource(otherCases));
  await writeRunnerManifest(root, {
    lanes: { synthetic: { files: [{ path: topologyFile }, { path: otherFile }] } },
  });
  const statePath = join(root, "state/native-child.json");
  const resultsPath = join(root, "results/native-child.json");

  const result = runRunnerSync(laneArgs(root, "synthetic", statePath, resultsPath));
  assert.equal(result.status, 1);
  const summaryText = await readFile(resultsPath, "utf8");
  const detailsText = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const summary: unknown = JSON.parse(summaryText);
  const details: unknown = JSON.parse(detailsText);
  assert.ok(isRecord(summary) && isRecord(details));
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.counts, { passed: 0, failed: 14, skipped: 0, todo: 0, total: 14 });
  const files = requireRows(summary.files);
  const failures = requireRows(details.failures);
  for (const [path, expectedCases] of [
    [topologyFile, cases],
    [otherFile, otherCases],
  ] as const) {
    const file = files.find((entry) => entry.path === path);
    assert.ok(file && isRecord(file.cleanup));
    assert.equal(file.nodeExitCode, 1);
    assert.equal(file.signal, null);
    assert.equal(file.cleanup.status, "passed");
    const tests = requireRows(file.tests);
    const parents = tests.filter((entry) => {
      assert.ok(hasStringField(entry, "name"));
      return entry.name.startsWith("synthetic topology parent");
    });
    assert.equal(parents.length, expectedCases.length);
    assert.ok(
      parents.every((entry) => isRecord(entry.error) && entry.error.diagnostic === undefined),
    );
    const children = tests.filter((entry) => !parents.includes(entry));
    assert.deepEqual(
      children.map((entry) => {
        assert.ok(isRecord(entry.error));
        return [entry.name, entry.status, entry.error.diagnostic];
      }),
      expectedCases.map(([name, , diagnostic]) => [name, "failed", diagnostic]),
    );
    const failure = failures.find((entry) => entry.file === path);
    assert.ok(failure);
    assert.equal(failure.reason, "failed");
    const nativeFailures = requireRows(failure.tests).filter((entry) => {
      assert.ok(entry.message === undefined || typeof entry.message === "string");
      return entry.message?.includes("Native child evidence");
    });
    assert.equal(
      nativeFailures.length,
      expectedCases.filter(([, options]) => "fault" in options).length,
    );
  }
  assert.equal(await readFile(cleanupPath, "utf8"), "cleaned\ncleaned\n");
  assert.ok(!summaryText.includes(fakeText));
  const receipts = (await readFile(receiptPath, "utf8")).trim().split("\n");
  assert.equal(receipts.length, 5);
  assert.equal(new Set(receipts).size, receipts.length);
  assert.ok(receipts.every((receipt) => /^[a-f0-9-]{36,64}$/.test(receipt)));
  assert.deepEqual(
    {
      caseResults: receipts.filter((receipt) => summaryText.includes(receipt)).length,
      failureDetails: receipts.filter((receipt) => detailsText.includes(receipt)).length,
    },
    { caseResults: 0, failureDetails: 0 },
  );
});
