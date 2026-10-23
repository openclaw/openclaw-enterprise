// The fixture owner chooses the exact command in a read-only mount. Model requests
// can identify a prepared turn but cannot supply a command, a token, or another target.
import { existsSync, readFileSync } from "node:fs";

export function skipperPreparedComputeEvents({ model, request, answerEvents, emit }) {
  const path = "/fixture/skipper-command.json";
  if (!existsSync(path)) {
    return undefined;
  }
  const { cmd, id } = JSON.parse(readFileSync(path, "utf8"));
  if (!request.includes(id)) {
    return undefined;
  }
  const { input } = JSON.parse(request);
  const marker = "SKIPPER_COMPUTE_DONE_" + id;
  const result = input.find((x) => x.type === "function_call_output" && x.call_id === id);
  if (result) {
    const output =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    const ok = output.includes(marker);
    const sha = output.match(/(?:^|\n)([0-9a-f]{40})(?:\n|$)/)?.[1];
    emit({ event: "skipper-native-result", id, markerSeen: ok, sha });
    return answerEvents(model, ok ? marker : "SKIPPER_INCOMPLETE_" + id);
  }
  const item = {
    type: "function_call",
    call_id: id,
    name: "exec_command",
    arguments: JSON.stringify({
      cmd: cmd + "\nprintf '%s\\n' '" + marker + "'",
      login: false,
      yield_time_ms: 30_000,
    }),
  };
  const response = { id: "resp_" + id, object: "response", model };
  emit({ event: "skipper-native-request", id });
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", output: [item] } },
  ];
}
