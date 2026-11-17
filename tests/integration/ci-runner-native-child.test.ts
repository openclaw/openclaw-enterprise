import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
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
const setTimeoutOriginal = setTimeout;
globalThis.setTimeout = (fn, ms) => setTimeoutOriginal(fn, ms === 250 ? 0 : ms);
let now = 0;
Date.now = () => (now += 5_000);
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
      response.result.thread = params.threadId === "synthetic-parent" ? fixture.parent : fixture.child;
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

function nativeHistory(prompt: string, task: string, answer: string) {
  const user = (text: string) => ({ type: "userMessage", content: [{ type: "text", text }] });
  const start = { type: "subAgentActivity", kind: "started", agentThreadId: "synthetic-child" };
  const spawn = {
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    receiverThreadIds: ["synthetic-child"],
  };
  const command = {
    type: "commandExecution",
    source: "unifiedExecStartup",
    status: "completed",
    exitCode: 0,
    command: `/bin/bash -lc 'node -p "crypto.randomUUID()"'`,
    aggregatedOutput: answer + "\n",
  };
  const final: { type: string; phase?: string; text: string } = {
    type: "agentMessage",
    phase: "final_answer",
    text: answer,
  };
  return {
    parent: {
      id: "synthetic-parent",
      turns: [{ status: "completed", items: [user(prompt), start, spawn] }],
    },
    child: {
      id: "synthetic-child",
      parentThreadId: "synthetic-parent",
      turns: [{ status: "completed", items: [user(task), command, final] }],
    },
    command,
    final,
    spawn,
  };
}

function readSyntheticNativeChild(
  readEvidence: ReadEvidence,
  fault?: Fault,
  onFailure?: (error: unknown) => void | Promise<void>,
): Promise<unknown> {
  const marker = `synthetic-correlation-${randomUUID()}`;
  const task = `Run the native shell task for ${marker}`;
  const prompt = `Spawn a native child with task ${JSON.stringify(task)}`;
  const fixture = nativeHistory(prompt, task, randomUUID());
  return readEvidence(
    "unused-namespace",
    "unused-pod",
    "synthetic-parent",
    marker,
    task,
    prompt,
    async (_namespace: string, _pod: string, script: string) => {
      try {
        const { stdout } = await exec(process.execPath, [
          "-e",
          `const fault = ${JSON.stringify(fault)};\nconst fixture = ${JSON.stringify(fixture)};\n${socketStub}\n${script}`,
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
  assert.equal(evidence.observation.commandMatched, true);
});

test("dedicated native child relay binds the current HTTP answer to its generating turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-child-relay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixturePath = join(directory, "history.json");
  const execPath = join(directory, "kubectl");
  await writeFile(
    execPath,
    `#!${process.execPath}
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const path = ${JSON.stringify(fixturePath)};
const snapshot = JSON.parse(readFileSync(path, "utf8"));
const { history, fixture, sessionKey } = snapshot;
const args = process.argv.slice(2);
assert.deepEqual(args.slice(-8, -1), ["exec", "relay-pod", "--namespace", "relay-ns", "--", "node", "-e"]);
const script = args.at(-1);
if (script.includes('"chat.history"')) {
  assert.ok(script.includes(sessionKey));
  if (snapshot.pendingHistoryReads > 0) {
    snapshot.pendingHistoryReads--;
    writeFileSync(path, JSON.stringify(snapshot));
    history.messages.pop();
  }
  process.stdout.write(JSON.stringify(history));
} else {
  const fault = undefined;
  eval(${JSON.stringify(socketStub)} + script);
}
`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  });
  const { assertDedicatedNativeChildRelay } =
    await import("../helpers/harness-topology-k3d-real.mjs");
  const topology = {
    gatewayUrl: "http://127.0.0.1:9",
    gatewayPassword: "synthetic-offline-only",
    gatewayPlacement: "relay-ns",
    gatewayPod: { metadata: { name: "relay-pod" } },
  };

  for (const [scenario, matchingStage] of [
    ["explicit final followed by commentary and phase-less text", undefined],
    ["last textual answer in a phase-less turn", undefined],
    ["activity-only spawn", undefined],
    ["tool-call-only spawn", undefined],
    ["delayed persisted answer", undefined],
    ["correct HTTP answer with stale-only history", "history"],
    ["wrong current HTTP answer with matching old history", "http"],
    ["missing current HTTP answer with matching old history", "http"],
    ["the right answer on a different child turn", "child-completion"],
    ["wrong selected child identity", "child-read"],
    ["command only mentions the generator", "child-completion"],
    ["command appears after the final", "child-completion"],
    ["matching commentary with a different explicit final", "child-completion"],
    ["two explicit finals", "child-completion"],
    ["commentary without a final", "child-completion"],
    ["duplicate spawn to the same child", "parent-read"],
    ["failed spawn with started activity", "parent-read"],
    ["completed spawn without a receiver", "parent-read"],
    ["activity and receiver identify different children", "parent-read"],
    ["interrupted parent", "parent-read"],
    ["failed parent", "parent-read"],
  ] as const) {
    await t.test(scenario, async (context) => {
      const answer = randomUUID();
      const fetchResponse: typeof globalThis.fetch = async (url, options) => {
        assert.equal(url, `${topology.gatewayUrl}/v1/chat/completions`);
        assert.equal(options?.method, "POST");
        const sessionKey = new Headers(options?.headers).get("x-openclaw-session-key");
        assert.match(sessionKey ?? "", /^agent:main:native-child-/);
        assert.ok(typeof options?.body === "string");
        const body = JSON.parse(options.body);
        assert.equal(body.stream, false);
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0].role, "user");
        const prompt: string = body.messages[0].content;
        const encodedTask = prompt.match(/message=("(?:[^"\\]|\\.)*")/)?.[1];
        assert.ok(encodedTask);
        const task: string = JSON.parse(encodedTask);
        assert.ok(!prompt.includes(answer));
        const fixture = nativeHistory(prompt, task, answer);
        const [childTurn] = fixture.child.turns;
        const [parentTurn] = fixture.parent.turns;
        assert.ok(childTurn && parentTurn);
        const commentary = { ...fixture.final, phase: "commentary", text: "still working" };
        const legacy = { type: "agentMessage", text: "older draft" };

        switch (scenario) {
          case "explicit final followed by commentary and phase-less text":
            childTurn.items.push(commentary, legacy);
            break;
          case "last textual answer in a phase-less turn":
            childTurn.items.splice(
              2,
              1,
              legacy,
              { ...legacy, text: answer },
              { ...legacy, text: "" },
            );
            break;
          case "the right answer on a different child turn":
            fixture.child.turns.unshift({
              status: "completed",
              items: [
                { type: "userMessage", content: [{ type: "text", text: "earlier task" }] },
                fixture.command,
                fixture.final,
              ],
            });
            childTurn.items.splice(1);
            break;
          case "wrong selected child identity":
            fixture.child.id = "different-child";
            break;
          case "command only mentions the generator":
            fixture.command.command = `/bin/bash -lc 'echo ${answer}; # crypto.randomUUID()'`;
            break;
          case "command appears after the final":
            childTurn.items.splice(1, 2, fixture.final, fixture.command);
            break;
          case "matching commentary with a different explicit final":
            childTurn.items.splice(
              2,
              1,
              { ...commentary, text: answer },
              {
                ...fixture.final,
                text: randomUUID(),
              },
            );
            break;
          case "two explicit finals":
            childTurn.items.push({ ...fixture.final });
            break;
          case "commentary without a final":
            childTurn.items.splice(2, 1, { ...commentary, text: answer });
            break;
          case "duplicate spawn to the same child":
            parentTurn.items.push({ ...fixture.spawn });
            break;
          case "activity-only spawn":
            parentTurn.items = parentTurn.items.filter((item) => item !== fixture.spawn);
            break;
          case "tool-call-only spawn":
            parentTurn.items = parentTurn.items.filter((item) => item.type !== "subAgentActivity");
            break;
          case "failed spawn with started activity":
            fixture.spawn.status = "failed";
            break;
          case "completed spawn without a receiver":
            fixture.spawn.receiverThreadIds = [];
            break;
          case "activity and receiver identify different children":
            fixture.spawn.receiverThreadIds = ["different-child"];
            break;
          case "interrupted parent":
          case "failed parent":
            parentTurn.status = scenario === "interrupted parent" ? "interrupted" : "failed";
            break;
        }

        // The earlier answer matches even in the stale-only case. Only a later
        // answer from the selected parent proves that the Gateway persisted the relay.
        const storedReply = {
          role: "assistant",
          idempotencyKey: "codex-app-server:synthetic-parent:current",
          content: ` ${answer}\n`,
        };
        const history = {
          messages: [
            { ...storedReply, idempotencyKey: "codex-app-server:synthetic-parent:old" },
            { role: "user", content: prompt },
            {
              ...storedReply,
              idempotencyKey: "codex-app-server:synthetic-parent:draft",
              content: "still working",
            },
          ],
        };
        if (scenario !== "correct HTTP answer with stale-only history") {
          history.messages.push(storedReply);
        }
        // Hide the final during parent selection and the first persistence poll.
        const pendingHistoryReads = scenario === "delayed persisted answer" ? 2 : 0;
        await writeFile(
          fixturePath,
          JSON.stringify({ history, fixture, sessionKey, pendingHistoryReads }),
        );
        const content =
          scenario === "wrong current HTTP answer with matching old history"
            ? randomUUID()
            : scenario === "missing current HTTP answer with matching old history"
              ? undefined
              : ` ${answer}\n`;
        return Response.json({ choices: [{ message: { content } }] });
      };
      const fetch = context.mock.method(globalThis, "fetch", fetchResponse);

      if (matchingStage === "history") {
        // Advance the history poll past its deadline without waiting on real time.
        let now = Date.now();
        context.mock.method(Date, "now", () => (now += 300_000));
      }
      const relay = assertDedicatedNativeChildRelay(topology);
      if (matchingStage === undefined) {
        await relay;
      } else if (matchingStage === "http") {
        await assert.rejects(
          relay,
          /current Gateway reply must equal the linked child's final answer/,
        );
      } else if (matchingStage === "history") {
        await assert.rejects(relay, {
          message:
            "Timed out waiting for the persisted child answer on the selected Gateway parent.",
        });
      } else {
        await assert.rejects(relay, (error: unknown) => {
          assert.ok(isRecord(error));
          assert.deepEqual(error.openclawCiDiagnostic, {
            kind: "topology-native-child",
            stage: matchingStage,
          });
          return true;
        });
      }
      assert.equal(fetch.mock.callCount(), 1);
    });
  }
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
const nativeHistory = ${nativeHistory.toString()};
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
