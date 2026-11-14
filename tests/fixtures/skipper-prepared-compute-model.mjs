// The fixture owner chooses the exact command in a read-only mount. Model requests
// can identify a prepared turn but cannot supply a command, a token, or another target.
import { existsSync, readFileSync } from "node:fs";

// Codex 0.164.0's ExecCommandToolOutput::response_text wraps both exec_command and
// write_stdin output this way. Parse only its header: command output is not metadata.
function nativeResult(text) {
  if (typeof text !== "string") {
    return undefined;
  }
  const match =
    /^(?:Chunk ID: [^\n]+\n)?Wall time: [\d.]+ seconds\n(?:Process exited with code (-?\d+)\n)?(?:Process running with session ID (\d+)\n)?(?:Original token count: \d+\n)?Output:\n([\s\S]*)$/.exec(
      text,
    );
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    return undefined;
  }
  return {
    exitCode: match[1] === undefined ? undefined : Number(match[1]),
    sessionId: match[2] === undefined ? undefined : Number(match[2]),
    output: match[3],
  };
}

export function createSkipperPreparedComputeEvents(commandPath) {
  let active;
  return ({ model, request, answerEvents, emit }) => {
    if (!existsSync(commandPath)) {
      return undefined;
    }
    const { cmd, id, expiresAt } = JSON.parse(readFileSync(commandPath, "utf8"));
    if (!request.includes(id)) {
      return undefined;
    }
    const { input } = JSON.parse(request);
    if (active?.id !== id) {
      active = { id, results: new Map(), invalid: false };
    }
    const marker = "SKIPPER_COMPUTE_DONE_" + id;
    const prefix = id + "-wait-";
    // WebSocket continuations may contain only the new output; full-history
    // requests may repeat older outputs. Keep each owned tool result once.
    for (const item of input) {
      if (
        item.type === "function_call_output" &&
        (item.call_id === id || item.call_id?.startsWith(prefix)) &&
        !active.results.has(item.call_id)
      ) {
        const count = active.results.size;
        const previous = nativeResult([...active.results.values()].at(-1)?.output);
        if (
          item.call_id !== (count === 0 ? id : prefix + count) ||
          (count > 0 && previous?.sessionId === undefined)
        ) {
          active.invalid = true;
        } else {
          active.results.set(item.call_id, item);
        }
      }
    }
    const results = [...active.results.values()];
    const parsed = results.map((item) => nativeResult(item.output));
    const current = parsed.at(-1);
    let item;
    const remaining = expiresAt - Date.now();
    if (results.length > 0 || active.invalid) {
      const sessionId = parsed[0]?.sessionId;
      const sameSession =
        !active.invalid &&
        active.results.has(id) &&
        Number.isSafeInteger(sessionId) &&
        sessionId > 0 &&
        parsed.every(
          (result) => result && (result.sessionId === undefined || result.sessionId === sessionId),
        );
      // Codex clamps empty write_stdin polls to at least five seconds.
      const pollFits = remaining >= 5_000;
      if (current?.sessionId !== undefined && sameSession && pollFits) {
        // Continue the original process, with empty stdin. Never replay its Git writes.
        item = {
          type: "function_call",
          call_id: prefix + results.length,
          name: "write_stdin",
          arguments: JSON.stringify({
            session_id: sessionId,
            chars: "",
            yield_time_ms: Math.min(30_000, remaining),
          }),
        };
        emit({
          event: "skipper-native-poll",
          id,
          status: "running",
          exitCode: current.exitCode ?? null,
          sessionPresent: true,
        });
      } else {
        const output = parsed.map((result) => result?.output ?? "").join("");
        const markerSeen = output.includes(marker);
        const completed =
          parsed.every(Boolean) &&
          current?.exitCode !== undefined &&
          current.sessionId === undefined &&
          (results.length === 1 || sameSession);
        const ok =
          !active.invalid &&
          active.results.has(id) &&
          remaining > 0 &&
          completed &&
          current.exitCode === 0 &&
          markerSeen;
        const sha = output.match(/(?:^|\n)([0-9a-f]{40})(?:\n|$)/)?.[1];
        let status = "unrecognized";
        if (remaining <= 0 || (current?.sessionId !== undefined && !pollFits)) {
          status = "deadline";
        } else if (!active.invalid && completed) {
          status = "completed";
        }
        emit({
          event: "skipper-native-result",
          id,
          markerSeen,
          ...(ok ? { modelFixtureSelectedTerminalSuccess: true } : {}),
          sha,
          status,
          exitCode: current?.exitCode ?? null,
          sessionPresent: current?.sessionId !== undefined,
        });
        return answerEvents(model, ok ? marker : "SKIPPER_INCOMPLETE_" + id);
      }
    } else {
      if (!(remaining > 0)) {
        emit({
          event: "skipper-native-result",
          id,
          markerSeen: false,
          status: "deadline",
          exitCode: null,
          sessionPresent: false,
        });
        return answerEvents(model, "SKIPPER_INCOMPLETE_" + id);
      }
      item = {
        type: "function_call",
        call_id: id,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: cmd + "\nprintf '%s\\n' '" + marker + "'",
          login: false,
          yield_time_ms: Math.min(30_000, remaining),
        }),
      };
      emit({ event: "skipper-native-request", id });
    }
    const response = { id: "resp_" + item.call_id, object: "response", model };
    return [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: { ...response, status: "completed", output: [item] },
      },
    ];
  };
}
