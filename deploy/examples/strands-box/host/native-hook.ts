import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The native hook command inside Box.
 *
 * Compute relays native hooks for every dedicated Codex revision behind Gateway routing. The
 * Gateway renders each hook as one shell command line (pinned OpenClaw
 * `native-hook-relay-command.ts`), and Codex runs it inside Box through Box's shell alias:
 *
 *   exec <node> <entry> hooks relay --provider codex --relay-id codex-<40 hex>
 *     --remote-credential <HOME>/.oce-native-hooks/<relayId>.<generation>.json
 *     --generation <uuid> --event <event> --timeout <ms>
 *
 * Box's Strands Shell decides that spawn as `shell:spawn` (default deny: exit 126), and stock Codex
 * treats a hook that exits with anything but 0 or 2 as non-blocking, so an unrunnable hook turns
 * Gateway tool admission off. The host therefore renders one exact permit and one `[tool]` table
 * for this command, and the in-Box agent proves at start that the command runs (`nativeHookProbe`).
 *
 * `NATIVE_HOOK_NODE` and `NATIVE_HOOK_ENTRY` are the Gateway's own `process.execPath` and relay
 * entry in the runtime image; the host's `/app` is that image's tree, so the same files exist here.
 * Keep these literals pinned against the runtime image.
 */
export const NATIVE_HOOK_NODE = "/usr/local/bin/node";
export const NATIVE_HOOK_PACKAGE = "/app/node_modules/openclaw";
export const NATIVE_HOOK_ENTRY = `${NATIVE_HOOK_PACKAGE}/dist/native-hook-relay/entry.js`;
/** The relay's own event names (pinned `NATIVE_HOOK_RELAY_EVENTS`). */
export const NATIVE_HOOK_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;
/** Words after the program: entry, hooks, relay and six flag/value pairs. */
const NATIVE_HOOK_ARGUMENTS = 15;
const TOOL = "oce_native_hook";
const REFUSAL = "native_hook_command_refused";

const quoted = (value: string) => JSON.stringify(value);

function plainPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.includes('"') &&
    !path.includes("*") &&
    !path.includes("\\") &&
    !/\s/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

/**
 * The hook program must be a root-owned file nobody else can change, under root-owned directories
 * nobody else can change: the permit trusts whatever these paths run.
 */
export function verifyNativeHookCommand(): void {
  for (const file of [NATIVE_HOOK_NODE, NATIVE_HOOK_ENTRY]) {
    if (realpathSync(file) !== file) throw new Error(REFUSAL);
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o7022) !== 0 || info.nlink !== 1)
      throw new Error(REFUSAL);
    for (let path = dirname(file); ; path = dirname(path)) {
      const parent = lstatSync(path);
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
        throw new Error(REFUSAL);
      if (path === "/") break;
    }
  }
}

/**
 * One `shell:spawn` permit for exactly the rendered hook command: the program by the name Codex
 * types and by its resolved file, the relay entry and the `hooks` word (Box's `arg1`/`arg2`), the
 * exact word count, the Codex working directory, no credential store, and the whole command line
 * (Box rebuilds it from the expanded words, without the leading `exec`) in one of four shapes,
 * one per relay event. Box cannot confine a `like` wildcard to one word, so the variable words
 * (relay id, generation, timeout) are `*`; the word count, the fixed words around them and the
 * `[tool]` table's filesystem list bound what a matching command can reach.
 */
export function nativeHookPolicy(workspace: string, directory: string): string {
  if (!plainPath(workspace) || !plainPath(directory)) throw new Error(REFUSAL);
  const shapes = NATIVE_HOOK_EVENTS.map(
    (event) =>
      `context.input.command like ${quoted(
        `${NATIVE_HOOK_NODE} ${NATIVE_HOOK_ENTRY} hooks relay --provider codex --relay-id codex-* --remote-credential ${directory}/codex-*.json --generation * --event ${event} --timeout *`,
      )}`,
  );
  return [
    `@id(${quoted(TOOL)})`,
    'permit (principal, action == Box::Action::"shell:spawn", resource)',
    `when { context.input.program == ${quoted(NATIVE_HOOK_NODE)} && context.input.program_path == ${quoted(NATIVE_HOOK_NODE)} && context.input.arg_count == ${NATIVE_HOOK_ARGUMENTS} && context.input has arg1 && context.input.arg1 == ${quoted(NATIVE_HOOK_ENTRY)} && context.input has arg2 && context.input.arg2 == "hooks" && context.input.cwd == ${quoted(workspace)} && !(context.input has credential_reads) && (${shapes.join(" || ")}) };`,
    "",
  ].join("\n");
}

/**
 * The hook runs as its own leaf: only the relay package and the credential directory are
 * readable, egress goes through Box's gateway (whose policy admits only the Gateway's hook
 * route), and V8 runs without a JIT because Box refuses writable-executable memory (without
 * `--jitless` Node aborts with exit 133, which Codex would also treat as non-blocking). Box gives
 * a table only the variables it names, so the Harness's `NODE_OPTIONS` never reaches the hook.
 */
export function nativeHookTool(workspace: string, directory: string): string {
  if (!plainPath(workspace) || !plainPath(directory)) throw new Error(REFUSAL);
  return [
    `[tool.${TOOL}]`,
    `command = [${[NATIVE_HOOK_NODE, NATIVE_HOOK_ENTRY, "hooks", "relay"].map(quoted).join(", ")}]`,
    `workspace = ${quoted(workspace)}`,
    `env = { NODE_OPTIONS = "--jitless", HOME = ${quoted(dirname(directory))} }`,
    `[tool.${TOOL}.filesystem]`,
    `read = [${[NATIVE_HOOK_PACKAGE, directory].map(quoted).join(", ")}]`,
    `[tool.${TOOL}.network]`,
    "contain_egress = true",
    "",
  ].join("\n");
}

const PROBE_RELAY = `codex-${"0".repeat(40)}`;
const PROBE_GENERATION = "00000000-0000-4000-8000-000000000000";

/**
 * The start-time self-check the in-Box agent runs before Codex starts: the same command line,
 * through the same shell alias, under the same policy, for a relay credential that cannot exist
 * (the directory is fresh and empty). Only the relay's own fail-closed answer passes: it proves
 * Box admitted the spawn, the table matched, Node started and loaded the relay, and the relay
 * itself refuses a tool call it cannot confirm. No credential is involved and nothing is logged.
 */
export function nativeHookProbe(directory: string): { command: string; expected: string } {
  if (!plainPath(directory)) throw new Error(REFUSAL);
  return {
    command: [
      "exec",
      NATIVE_HOOK_NODE,
      NATIVE_HOOK_ENTRY,
      "hooks",
      "relay",
      "--provider",
      "codex",
      "--relay-id",
      PROBE_RELAY,
      "--remote-credential",
      `${directory}/${PROBE_RELAY}.${PROBE_GENERATION}.json`,
      "--generation",
      PROBE_GENERATION,
      "--event",
      "pre_tool_use",
      "--timeout",
      "5000",
    ].join(" "),
    expected: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    })}\n`,
  };
}
