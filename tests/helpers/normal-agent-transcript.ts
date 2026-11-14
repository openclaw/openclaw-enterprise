type ToolCall = {
  id?: string | undefined;
  seq: number;
  name: string;
  processAction?: string | undefined;
  processSessionId?: string | undefined;
};

type ToolResult = {
  toolCallId?: string | undefined;
  seq: number;
  isError: boolean;
  status?: string | undefined;
  exitCode?: number | null | undefined;
  processSessionId?: string | undefined;
};

// A trace may record an interim tool error before that same call completes.
// Only its latest result, or an exact process-session poll, can prove success.
export function completedToolResult<Result extends ToolResult>(
  trace: { calls: readonly ToolCall[]; results: readonly Result[] },
  call: Pick<ToolCall, "id" | "seq">,
): Result | undefined {
  const succeeded = (result: ToolResult) =>
    !result.isError && result.status === "completed" && result.exitCode === 0;
  const result = trace.results.findLast(
    (result) => call.id !== undefined && result.toolCallId === call.id && result.seq > call.seq,
  );
  if (!result || result.isError) {
    return undefined;
  }
  if (succeeded(result)) {
    return result;
  }
  if (result.status !== "running" || typeof result.processSessionId !== "string") {
    return undefined;
  }
  for (const poll of trace.calls) {
    if (
      poll.id === undefined ||
      poll.name !== "process" ||
      poll.processAction !== "poll" ||
      poll.processSessionId !== result.processSessionId ||
      poll.seq <= result.seq
    ) {
      continue;
    }
    const completed = trace.results.findLast(
      (done) => done.toolCallId === poll.id && done.seq > poll.seq,
    );
    if (
      completed &&
      completed.processSessionId === result.processSessionId &&
      succeeded(completed)
    ) {
      return completed;
    }
  }
  return undefined;
}

// Nested code-mode calls are runtime records, not commands inferred from model code.
// Keep the actual parent linkage and place their call before their result.
export function expandTranscriptMessage(
  message: unknown,
  seq: number,
  parentCalls: Set<string>,
): { seq: number; message: unknown }[] {
  const fields = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const source = fields(message);
  if (message === null || message === undefined) {
    throw new Error("missing transcript message");
  }
  if (source?.role === "assistant" && Array.isArray(source.content)) {
    for (const entry of source.content as unknown[]) {
      const block = fields(entry);
      if (block?.type === "toolCall" && typeof block.id === "string") {
        parentCalls.add(block.id);
      }
    }
  }
  const details = fields(source?.details);
  const result = fields(details?.result);
  if (source?.role !== "custom" || source?.customType !== "openclaw.nested-tool.v1") {
    return [{ seq: seq * 2, message }];
  }
  if (
    !details ||
    typeof details.parentToolCallId !== "string" ||
    !parentCalls.has(details.parentToolCallId) ||
    typeof details.toolCallId !== "string" ||
    typeof details.toolName !== "string" ||
    !details.input ||
    typeof details.input !== "object" ||
    !result
  ) {
    return [];
  }
  return [
    {
      seq: seq * 2,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: details.toolCallId,
            name: details.toolName,
            arguments: details.input,
          },
        ],
      },
    },
    {
      seq: seq * 2 + 1,
      message: {
        ...result,
        role: "toolResult",
        toolCallId: details.toolCallId,
        toolName: details.toolName,
        isError: details.isError === true || result.isError === true,
      },
    },
  ];
}
