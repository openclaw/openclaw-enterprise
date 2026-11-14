import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCodexPolicyChild,
  parseCodexPolicyMetadata,
  readCodexPolicyRolloutHead,
} from "../helpers/codex-policy-thread-evidence.ts";

type FixtureTurn = {
  id?: string;
  status: string;
  error?: unknown;
  items: Record<string, unknown>[];
};

export function registerQaCodexPolicyThreadCase() {
  test("Gateway policy evidence identifies a fresh native Codex child and its own completed work", async (t) => {
    const metadata = (id: string, dynamicTools: readonly unknown[] = [], parentThreadId?: string) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id, dynamic_tools: dynamicTools, parent_thread_id: parentThreadId },
      });
    const parentLine = metadata("parent", [
      {
        type: "namespace",
        name: "openclaw",
        tools: [
          {
            type: "function",
            name: "agents_list",
            description: "private description",
            inputSchema: {},
          },
        ],
      },
    ]);
    const childLine = metadata("child", [], "parent");
    function fixture(version: "v1" | "v2" = "v1") {
      const spawn = {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent",
        receiverThreadIds: ["child"],
        prompt: "run native work and reply child-done",
      };
      const activity = {
        type: "subAgentActivity",
        id: "spawn-call",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/policy_child",
      };
      const command = {
        type: "commandExecution",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "42 command-result\n",
      };
      const parentTurn: FixtureTurn = {
        id: "parent-turn",
        status: "completed",
        error: null,
        items:
          version === "v2"
            ? [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "run native work and reply child-done" }],
                },
                activity,
              ]
            : [spawn],
      };
      const childTurn: FixtureTurn = {
        id: "child-turn",
        status: "completed",
        error: null,
        items: [command, { type: "agentMessage", text: "child-done" }],
      };
      const child: {
        id: string;
        parentThreadId: string;
        forkedFromId: string | null;
        turns: FixtureTurn[];
      } = {
        id: "child",
        parentThreadId: "parent",
        forkedFromId: null,
        turns: [childTurn],
      };
      return {
        childMarker: "child-done",
        childResult: "command-result",
        parent: { id: "parent", turns: [parentTurn] },
        child,
        parentMetadata: parseCodexPolicyMetadata(parentLine, "parent"),
        childMetadata: parseCodexPolicyMetadata(childLine, "child"),
        spawn,
        activity,
        command,
        parentTurn,
        childTurn,
      };
    }
    type Mutation = [label: string, mutate: (value: ReturnType<typeof fixture>) => void];

    for (const version of ["v1", "v2"] as const) {
      const result = assertCodexPolicyChild(fixture(version));
      assert.equal(result.childTurnId, "child-turn");
      assert.equal(result.nativeCommandSucceeded, true);
      assert.deepEqual(result.childGatewayTools, []);
      assert.deepEqual(result.parentGatewayTools, [{ namespace: "openclaw", name: "agents_list" }]);
      assert.equal(JSON.stringify(result).includes("private description"), false);
    }

    for (const [label, mutate] of [
      [
        "activity in another turn",
        (value) => {
          const activity = value.parentTurn.items.pop();
          assert.strictEqual(activity, value.activity);
          value.parent.turns.push({
            id: "other-turn",
            status: "completed",
            error: null,
            items: [activity],
          });
        },
      ],
      [
        "activity that did not start a child",
        (value) => {
          value.activity.kind = "completed";
        },
      ],
      [
        "incomplete parent turn",
        (value) => {
          value.parentTurn.status = "inProgress";
        },
      ],
      [
        "activity identifying another child",
        (value) => {
          value.activity.agentThreadId = "other-child";
        },
      ],
    ] satisfies Mutation[]) {
      await t.test(`rejects V2 ${label}`, () => {
        const value = fixture("v2");
        mutate(value);
        assert.throws(() => assertCodexPolicyChild(value), assert.AssertionError);
      });
    }

    await t.test("reports bounded spawn predicates without private native content", () => {
      const value = fixture();
      const { spawn } = value;
      // Separate each rejected predicate so a real zero-match result identifies its cause.
      value.parent.turns = [
        ...Array.from({ length: 10 }, () => ({ status: "inProgress", error: null, items: [] })),
        {
          status: "completed",
          error: null,
          items: [
            { ...spawn, status: "inProgress" },
            { ...spawn, senderThreadId: "private-thread" },
            { ...spawn, prompt: "private-prompt private-secret" },
            {
              type: "commandExecution",
              command: "private-command",
              aggregatedOutput: "private-result",
            },
          ],
        },
        { status: "completed", items: [spawn] },
        { status: "inProgress", error: null, items: [spawn] },
        { status: "failed", error: { message: "private-error" }, items: [spawn] },
        { status: "private-status", error: "private-error", items: [] },
      ];
      assert.throws(
        () => assertCodexPolicyChild(value),
        (error) => {
          assert.ok(error instanceof assert.AssertionError);
          const prefix = "one completed native spawn must match the child task: ";
          assert.ok(error.message.startsWith(prefix));
          const [message] = error.message.split("\n");
          assert.ok(message);
          const diagnostic: unknown = JSON.parse(message.slice(prefix.length));
          assert.ok(typeof diagnostic === "object" && diagnostic !== null);
          assert.ok("counts" in diagnostic && "recentTurns" in diagnostic);
          const recentTurns: unknown = diagnostic.recentTurns;
          assert.ok(Array.isArray(recentTurns));
          const observations: readonly unknown[] = recentTurns;
          assert.deepEqual(diagnostic.counts, {
            turns: 15,
            completedErrorNullTurns: 1,
            collabSpawns: 3,
            completedSpawns: 2,
            senderBoundSpawns: 1,
            markerBoundSpawns: 0,
            subAgentActivities: 0,
            startedSubAgents: 0,
            taskBoundSubAgents: 0,
          });
          assert.equal(observations.length, 10);
          assert.deepEqual(observations.slice(-5), [
            { status: "completed", hasError: false, errorIsNull: true },
            { status: "completed", hasError: false, errorIsNull: false },
            { status: "inProgress", hasError: false, errorIsNull: true },
            { status: "failed", hasError: true, errorIsNull: false },
            { status: "unknown", hasError: true, errorIsNull: false },
          ]);
          for (const privateText of [
            "private-thread",
            "private-prompt",
            "private-secret",
            "private-command",
            "private-result",
            "private-error",
            "private-status",
          ]) {
            assert.equal(error.message.includes(privateText), false);
          }
          return true;
        },
      );
    });

    for (const [label, mutate] of [
      [
        "unrelated child",
        (value) => {
          value.child.id = "other";
        },
      ],
      [
        "wrong lineage",
        (value) => {
          value.child.parentThreadId = "other";
        },
      ],
      [
        "forked history",
        (value) => {
          value.child.forkedFromId = "parent";
        },
      ],
      [
        "wrong metadata identity",
        (value) => {
          value.childMetadata.threadId = "other";
        },
      ],
      [
        "missing parent catalog control",
        (value) => {
          value.parentMetadata.tools = [];
        },
      ],
      [
        "inherited Gateway tools",
        (value) => {
          value.childMetadata.tools = value.parentMetadata.tools;
        },
      ],
      [
        "unfinished child",
        (value) => {
          value.childTurn.status = "inProgress";
        },
      ],
      [
        "failed command",
        (value) => {
          value.command.exitCode = 1;
        },
      ],
      [
        "reply without native work",
        (value) => {
          value.childTurn.items.shift();
        },
      ],
    ] satisfies Mutation[]) {
      await t.test(`rejects ${label}`, () => {
        const value = fixture();
        mutate(value);
        assert.throws(() => assertCodexPolicyChild(value), assert.AssertionError);
      });
    }
    await t.test("reads only the exact plain or compressed SessionMeta head", async () => {
      const { zstdCompressSync } = await import("node:zlib");
      const directory = await mkdtemp(join(tmpdir(), "codex-policy-metadata-"));
      try {
        const path = join(directory, "rollout.jsonl");
        await writeFile(path, `${parentLine}\nnot-a-json-record\n`);
        await writeFile(`${path}.zst`, zstdCompressSync(`${childLine}\n`));
        assert.equal(await readCodexPolicyRolloutHead(`${path}.zst`), parentLine);
        await rm(path);
        assert.equal(await readCodexPolicyRolloutHead(path), childLine);
        assert.throws(
          () => parseCodexPolicyMetadata(childLine, "unrelated-thread"),
          /SessionMeta must identify the requested thread/,
        );
        assert.throws(
          () => parseCodexPolicyMetadata('{"type":"response_item"}', "child"),
          /rollout head must be native SessionMeta/,
        );
        await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1));
        await assert.rejects(readCodexPolicyRolloutHead(path), /fixture read limit/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}
