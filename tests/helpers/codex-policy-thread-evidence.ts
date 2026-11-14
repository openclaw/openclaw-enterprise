import assert from "node:assert/strict";

type PolicyRecord = Record<string, unknown>;
type PolicyTool = { namespace?: string | null | undefined; name: string };
type PolicyMetadata = {
  threadId: string;
  parentThreadId: string | null;
  forkedFromId: string | null;
  tools: PolicyTool[];
};

type IdentifiedRecord = PolicyRecord & { id: string };
type PolicyChildEvidence = {
  parent: IdentifiedRecord;
  child: IdentifiedRecord;
  parentMetadata: PolicyMetadata;
  childMetadata: PolicyMetadata;
  childMarker: string;
  childResult: string;
};

type MetadataCommand = [node: "node", flag: "-e", program: string, path: string, threadId: string];
type MetadataExecutor = (
  agent: { id: string },
  argv: MetadataCommand,
) => Promise<{ stdout: string }>;

function isRecord(value: unknown): value is PolicyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNullableId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// SessionMeta records the native tools exposed to the thread.
// Keep the reader and its guards self-contained when serialized for node -e in the Codex Pod.
export function parseCodexPolicyMetadata(line: string, expectedThreadId: string): PolicyMetadata {
  const entry: unknown = JSON.parse(line);
  assert.ok(
    isRecord(entry) && entry.type === "session_meta",
    "the rollout head must be native SessionMeta",
  );
  const metadata = entry.payload;
  assert.ok(
    isRecord(metadata) && metadata.id === expectedThreadId,
    "SessionMeta must identify the requested thread",
  );
  const specs = metadata.dynamic_tools ?? [];
  assert.ok(isList(specs), "SessionMeta dynamic_tools must be an array");
  const tools = specs.flatMap((spec) => {
    assert.ok(
      isRecord(spec) && (spec.type === "namespace" || spec.type === "function"),
      "unknown native tool spec",
    );
    const entries = spec.type === "namespace" ? spec.tools : [spec];
    assert.ok(isList(entries), "native namespace must contain tools");
    return entries.map((tool) => {
      assert.ok(isRecord(tool) && tool.type === "function");
      assert.ok(typeof tool.name === "string" && tool.name.length > 0);
      const namespace = spec.type === "namespace" ? spec.name : null;
      assert.ok(namespace === undefined || isNullableId(namespace));
      return { namespace, name: tool.name };
    });
  });
  const parentThreadId = metadata.parent_thread_id ?? null;
  const forkedFromId = metadata.forked_from_id ?? null;
  assert.ok(isNullableId(parentThreadId) && isNullableId(forkedFromId));
  return { threadId: metadata.id, parentThreadId, forkedFromId, tools };
}

export async function readCodexPolicyRolloutHead(path: string): Promise<string> {
  const { access } = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const { createZstdDecompress } = await import("node:zlib");
  assert.ok(typeof path === "string" && /\.jsonl(?:\.zst)?$/.test(path));
  // Codex's reader prefers the plain counterpart if compression left both present.
  const plain = path.replace(/\.zst$/, "");
  let selected = plain;
  try {
    await access(plain);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
    selected = `${plain}.zst`;
  }
  const input = createReadStream(selected);
  const stream = selected.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
  if (stream !== input) {
    input.on("error", (error) => stream.destroy(error));
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    const chunks: AsyncIterable<unknown, unknown, unknown> = stream;
    for await (const chunk of chunks) {
      assert.ok(Buffer.isBuffer(chunk));
      bytes += chunk.length;
      assert.ok(bytes <= 4 * 1024 * 1024, "native rollout metadata exceeds the fixture read limit");
      text += decoder.decode(chunk, { stream: true });
      const end = text.indexOf("\n");
      if (end !== -1) {
        return text.slice(0, end);
      }
    }
    throw new Error("native rollout has no complete SessionMeta record");
  } finally {
    stream.destroy();
    input.destroy();
  }
}

const readMetadataProgram = `
  const assert = require("node:assert/strict");
  ${isRecord.toString()}
  ${isList.toString()}
  ${isNullableId.toString()}
  ${parseCodexPolicyMetadata.toString()}
  ${readCodexPolicyRolloutHead.toString()}
  (async () => {
    const line = await readCodexPolicyRolloutHead(process.argv[1]);
    process.stdout.write(JSON.stringify(parseCodexPolicyMetadata(line, process.argv[2])));
  })().catch(() => { process.stderr.write("Native SessionMeta evidence read failed."); process.exitCode = 1; });
`;

export function createCodexPolicyMetadataReader(proofMode: string, execCodex: MetadataExecutor) {
  return async function readCodexThreadMetadata(
    agent: { id: string },
    thread: IdentifiedRecord,
  ): Promise<PolicyMetadata> {
    assert.equal(proofMode, "codex");
    assert.ok(typeof thread.id === "string" && thread.id.length > 0);
    assert.ok(typeof thread.path === "string", "native thread/read must return its rollout path");
    const execution = await execCodex(agent, [
      "node",
      "-e",
      readMetadataProgram,
      thread.path,
      thread.id,
    ]);
    const result: unknown = JSON.parse(execution.stdout);
    assert.ok(
      isRecord(result) && result.threadId === thread.id,
      "Pod evidence must identify the requested thread",
    );
    assert.ok(isPolicyMetadata(result), "Pod evidence must contain SessionMeta lineage and tools");
    return result;
  };
}

function isPolicyMetadata(value: PolicyRecord): value is PolicyMetadata {
  return (
    typeof value.threadId === "string" &&
    isNullableId(value.parentThreadId) &&
    isNullableId(value.forkedFromId) &&
    isList(value.tools) &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        tool.name.length > 0 &&
        (tool.namespace === undefined || isNullableId(tool.namespace)),
    )
  );
}

function hasId(value: unknown): value is IdentifiedRecord {
  return isRecord(value) && typeof value.id === "string";
}

export function readCodexPolicyAgent(value: unknown): IdentifiedRecord {
  assert.ok(hasId(value), "native metadata reads require the admitted Agent identity");
  return value;
}

export function readCodexPolicyThread(value: unknown): IdentifiedRecord {
  assert.ok(hasId(value), "native thread/read must identify the thread");
  return value;
}

function records(value: unknown): PolicyRecord[] {
  assert.ok(isList(value) && value.every(isRecord), "native thread evidence must contain records");
  return value;
}

function completedWithoutError(turn: PolicyRecord): boolean {
  return turn.status === "completed" && turn.error === null;
}

function hasReply(turn: PolicyRecord, childMarker: string): boolean {
  return records(turn.items).some(
    (item) =>
      item.type === "agentMessage" &&
      typeof item.text === "string" &&
      item.text.includes(childMarker),
  );
}

export function findCodexPolicyReplyThread(
  value: unknown,
  childMarker: string,
): IdentifiedRecord | undefined {
  assert.ok(isRecord(value), "native thread/read must return a thread");
  return value.turns != null &&
    records(value.turns).some((turn) => turn.status === "completed" && hasReply(turn, childMarker))
    ? readCodexPolicyThread(value)
    : undefined;
}

export function findCodexPolicyChild(parent: IdentifiedRecord, childMarker: string): string {
  const turns = records(parent.turns);
  const completedTurns = turns.filter(completedWithoutError);
  const completedItems = completedTurns.flatMap((turn) => records(turn.items));
  const collabSpawns = completedItems.filter(
    (item) => item.type === "collabAgentToolCall" && item.tool === "spawnAgent",
  );
  const completedSpawns = collabSpawns.filter((item) => item.status === "completed");
  const senderBoundSpawns = completedSpawns.filter((item) => item.senderThreadId === parent.id);
  const spawns = senderBoundSpawns.filter(
    (item) => typeof item.prompt === "string" && item.prompt.includes(childMarker),
  );
  // V2 records the started child rather than a collaboration call with its prompt.
  // Bind that native identity to the turn carrying this test's unique child task.
  const activities = completedTurns.flatMap((turn) =>
    records(turn.items)
      .filter((item) => item.type === "subAgentActivity")
      .map((item) => ({ turn, item })),
  );
  const startedActivities = activities.filter(({ item }) => item.kind === "started");
  const taskActivities = startedActivities.filter(({ turn }) =>
    records(turn.items).some(
      (item) =>
        item.type === "userMessage" &&
        records(item.content).some(
          (part) =>
            part.type === "text" &&
            typeof part.text === "string" &&
            part.text.includes(childMarker),
        ),
    ),
  );
  assert.equal(
    spawns.length + taskActivities.length,
    1,
    `one completed native spawn must match the child task: ${JSON.stringify({
      counts: {
        turns: turns.length,
        completedErrorNullTurns: completedTurns.length,
        collabSpawns: collabSpawns.length,
        completedSpawns: completedSpawns.length,
        senderBoundSpawns: senderBoundSpawns.length,
        markerBoundSpawns: spawns.length,
        subAgentActivities: activities.length,
        startedSubAgents: startedActivities.length,
        taskBoundSubAgents: taskActivities.length,
      },
      itemTypes: [...new Set(completedItems.map((item) => item.type))].slice(0, 20),
      activities: activities.slice(-10).map(({ turn, item }) => ({
        parentTurnId: turn.id,
        childThreadId: item.agentThreadId,
        kind:
          typeof item.kind === "string" &&
          ["started", "interacted", "interrupted", "completed"].includes(item.kind)
            ? item.kind
            : "unknown",
      })),
      recentTurns: turns.slice(-10).map((turn) => ({
        status:
          typeof turn.status === "string" &&
          ["completed", "inProgress", "failed", "interrupted"].includes(turn.status)
            ? turn.status
            : "unknown",
        hasError: turn.error !== null && turn.error !== undefined,
        errorIsNull: turn.error === null,
      })),
    })}`,
  );
  const [spawn] = spawns;
  if (spawn !== undefined) {
    const receivers = spawn.receiverThreadIds;
    assert.ok(isList(receivers), "the spawn must identify exactly one child");
    assert.equal(receivers.length, 1, "the spawn must identify exactly one child");
    const [childId] = receivers;
    assert.ok(typeof childId === "string", "the spawn must identify its child");
    return childId;
  }
  const [activity] = taskActivities;
  const childId = activity?.item.agentThreadId;
  assert.ok(
    typeof childId === "string" && childId.length > 0,
    "the activity must identify its child",
  );
  return childId;
}

export function assertCodexPolicyChild({
  parent,
  child,
  parentMetadata,
  childMetadata,
  childMarker,
  childResult,
}: PolicyChildEvidence) {
  assert.equal(child.id, findCodexPolicyChild(parent, childMarker));
  assert.notEqual(child.id, parent.id);
  assert.equal(child.parentThreadId, parent.id);
  assert.equal(child.forkedFromId, null, "this proof requires a fresh child, not forked history");
  assert.equal(parentMetadata.threadId, parent.id);
  assert.equal(childMetadata.threadId, child.id);
  assert.equal(childMetadata.parentThreadId, parent.id);
  assert.equal(childMetadata.forkedFromId, null);
  assert.ok(
    parentMetadata.tools.some((tool) => tool.name === "agents_list"),
    "the parent Gateway catalog is the positive control",
  );
  assert.deepEqual(
    childMetadata.tools,
    [],
    "the fresh child must not inherit Gateway dynamic tools",
  );
  const completed = records(child.turns).find(
    (turn) =>
      completedWithoutError(turn) &&
      hasReply(turn, childMarker) &&
      records(turn.items).some(
        (item) =>
          item.type === "commandExecution" &&
          item.status === "completed" &&
          item.exitCode === 0 &&
          typeof item.aggregatedOutput === "string" &&
          item.aggregatedOutput.includes(`42 ${childResult}`),
      ),
  );
  assert.ok(
    completed && typeof completed.id === "string",
    "the child's own completed turn must contain the successful native command and reply",
  );
  const childGatewayTools: PolicyTool[] = [];
  return {
    parentThreadId: parent.id,
    childThreadId: child.id,
    childTurnId: completed.id,
    nativeCommandSucceeded: true as const,
    parentGatewayTools: parentMetadata.tools,
    childGatewayTools,
  };
}
