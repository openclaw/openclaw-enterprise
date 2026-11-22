// Synthetic native events. These exercise the emitted verifier, not a live provider.
export const openShellUpgradeDenial =
  'unexpected status 403 Forbidden: {"error":"unsupported_l7_protocol","detail":"HTTP upgrade is not supported for REST endpoints; use a separate protocol: websocket endpoint with explicit message rules"}, url: wss://chatgpt.com/backend-api/codex/responses';

export function answeredOpenShellFallback() {
  return [
    { type: "thread.started", thread_id: "fixture-thread" },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 2/5 (" + openShellUpgradeDenial + ")" },
    {
      type: "item.completed",
      item: {
        type: "error",
        message: "Falling back from WebSockets to HTTPS transport. " + openShellUpgradeDenial,
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: "READY" } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
}
