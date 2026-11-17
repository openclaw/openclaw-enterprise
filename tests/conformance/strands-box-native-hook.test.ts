import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NATIVE_HOOK_DIRECTORY } from "../../deploy/examples/strands-box/host/launch.ts";
import {
  NATIVE_HOOK_ENTRY,
  NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_NODE,
  NATIVE_HOOK_PACKAGE,
  nativeHookPolicy,
  nativeHookProbe,
  nativeHookTool,
} from "../../deploy/examples/strands-box/host/native-hook.ts";

const unsupported = process.platform !== "linux" || process.getuid?.() === 0;
const WORKSPACE = "/home/node/workspace";
const RELAY = `codex-${"a1".repeat(20)}`;
const GENERATION = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/** Cedar `like`: `*` matches any run of characters (spaces and slashes included). */
function like(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(value);
}

/** What Box decides on: the words after `exec`, rebuilt with single spaces. */
function decided(policyText: string, words: readonly string[]): boolean {
  const shapes = [...policyText.matchAll(/context\.input\.command like ("[^"]*")/g)].map(
    (match) => JSON.parse(match[1]!) as string,
  );
  const [program, ...args] = words;
  return (
    program === NATIVE_HOOK_NODE &&
    args.length === 15 &&
    args[0] === NATIVE_HOOK_ENTRY &&
    args[1] === "hooks" &&
    shapes.some((shape) => like(shape, words.join(" ")))
  );
}

/** The Gateway's rendered command (pinned OpenClaw native-hook-relay-command.ts), split. */
function rendered(overrides: Partial<Record<string, string>> = {}): string[] {
  const value = (flag: string, fallback: string) => overrides[flag] ?? fallback;
  return [
    overrides.node ?? NATIVE_HOOK_NODE,
    overrides.entry ?? NATIVE_HOOK_ENTRY,
    "hooks",
    "relay",
    "--provider",
    value("provider", "codex"),
    "--relay-id",
    value("relay", RELAY),
    "--remote-credential",
    value("credential", `${NATIVE_HOOK_DIRECTORY}/${RELAY}.${GENERATION}.json`),
    "--generation",
    value("generation", GENERATION),
    "--event",
    value("event", "pre_tool_use"),
    "--timeout",
    value("timeout", "9000"),
  ];
}

test("the native hook permit admits exactly the Gateway's rendered hook command", () => {
  const text = nativeHookPolicy(WORKSPACE, NATIVE_HOOK_DIRECTORY);
  assert.equal(text.match(/^permit /gm)?.length, 1);
  assert.equal(text.match(/shell:spawn/g)?.length, 1);
  for (const clause of [
    `context.input.program == "${NATIVE_HOOK_NODE}"`,
    `context.input.program_path == "${NATIVE_HOOK_NODE}"`,
    "context.input.arg_count == 15",
    `context.input.arg1 == "${NATIVE_HOOK_ENTRY}"`,
    'context.input.arg2 == "hooks"',
    `context.input.cwd == "${WORKSPACE}"`,
    "!(context.input has credential_reads)",
  ]) {
    assert.ok(text.includes(clause), clause);
  }
  assert.equal(text.match(/context\.input\.command like/g)?.length, NATIVE_HOOK_EVENTS.length);
  for (const event of NATIVE_HOOK_EVENTS) {
    assert.ok(decided(text, rendered({ event })), event);
  }
  // The start-time self-check runs this very shape.
  const probe = nativeHookProbe(NATIVE_HOOK_DIRECTORY);
  const [exec, ...words] = probe.command.split(" ");
  assert.equal(exec, "exec");
  assert.ok(decided(text, words));
  // Anything else stays default-deny.
  for (const changed of [
    rendered({ event: "exec_command" }),
    rendered({ provider: "claude" }),
    rendered({ entry: "/app/node_modules/openclaw/openclaw.mjs" }),
    rendered({ node: "/home/node/workspace/node" }),
    rendered({ relay: "other-relay" }),
    rendered({ credential: `${WORKSPACE}/${RELAY}.${GENERATION}.json` }),
    rendered({ credential: `${NATIVE_HOOK_DIRECTORY}/${RELAY}.${GENERATION}.txt` }),
    rendered().slice(0, -2),
    [...rendered(), "--extra"],
    rendered().map((word) => (word === "--remote-credential" ? "--state-db" : word)),
  ]) {
    assert.equal(decided(text, changed), false, changed.join(" "));
  }
  for (const path of ['/home/node/"x', "/home/node/*", "/home/node/../x", "relative", "/a b"]) {
    assert.throws(() => nativeHookPolicy(path, NATIVE_HOOK_DIRECTORY), {
      message: "native_hook_command_refused",
    });
    assert.throws(() => nativeHookPolicy(WORKSPACE, path), {
      message: "native_hook_command_refused",
    });
  }
});

test("the native hook runs as a leaf: relay package and credential directory, jitless, contained", () => {
  assert.equal(
    nativeHookTool(WORKSPACE, NATIVE_HOOK_DIRECTORY),
    [
      "[tool.oce_native_hook]",
      `command = ["${NATIVE_HOOK_NODE}", "${NATIVE_HOOK_ENTRY}", "hooks", "relay"]`,
      `workspace = "${WORKSPACE}"`,
      'env = { NODE_OPTIONS = "--jitless", HOME = "/home/node" }',
      "[tool.oce_native_hook.filesystem]",
      `read = ["${NATIVE_HOOK_PACKAGE}", "${NATIVE_HOOK_DIRECTORY}"]`,
      "[tool.oce_native_hook.network]",
      "contain_egress = true",
      "",
    ].join("\n"),
  );
  assert.ok(NATIVE_HOOK_ENTRY.startsWith(`${NATIVE_HOOK_PACKAGE}/`));
  const probe = nativeHookProbe(NATIVE_HOOK_DIRECTORY);
  // A credential that cannot exist in the fresh directory, and the relay's own fail-closed answer.
  assert.match(
    probe.command,
    /--remote-credential \/home\/node\/\.oce-native-hooks\/codex-0{40}\.0{8}-0{4}-4000-8000-0{12}\.json /,
  );
  assert.deepEqual(JSON.parse(probe.expected), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Native hook relay unavailable",
    },
  });
  assert.ok(probe.expected.endsWith("}\n"));
});

test(
  "box-agent refuses to start Codex unless the native hook command answers fail-closed",
  { skip: unsupported, timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "oce-box-hook-"));
    const node = realpathSync(process.execPath);
    const bin = join(directory, "bin");
    const workspace = join(directory, "workspace");
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const probe = nativeHookProbe(NATIVE_HOOK_DIRECTORY);
    writeFileSync(join(directory, "expected"), probe.expected, { mode: 0o600 });
    writeFileSync(join(directory, "wrong"), '{"hookSpecificOutput":{}}\n', { mode: 0o600 });
    const agentPath = fileURLToPath(
      new URL("../../deploy/examples/strands-box/host/box-agent.ts", import.meta.url),
    );
    // The first `sh` on PATH stands in for Box's shell alias.
    let runs = 0;
    const run = async (behaviour: string) => {
      runs += 1;
      const marker = join(directory, `started-${runs}`);
      const argsFile = join(directory, `args-${runs}`);
      writeFileSync(
        join(bin, "sh"),
        `#!/bin/sh\npwd > '${argsFile}'\nprintf '%s\\n' "$@" >> '${argsFile}'\n${behaviour}\n`,
        { mode: 0o700 },
      );
      const inputFile = join(directory, `agent-${runs}.json`);
      writeFileSync(
        inputFile,
        JSON.stringify({
          command: [node, "-e", "require('node:fs').writeFileSync(process.argv[1], 'x')", marker],
          workspace,
          codexBin: join(directory, "absent-codex"),
          socketPath: join(directory, "inner.sock"),
          nativeHookProbe: probe,
        }),
        { mode: 0o600 },
      );
      const agent = spawn(node, [agentPath, inputFile], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      });
      let stderr = "";
      agent.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const started = () => {
        try {
          lstatSync(marker);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 20_000;
      while (agent.exitCode === null && !started() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const wasStarted = started();
      if (agent.exitCode === null) {
        agent.kill("SIGKILL");
        await once(agent, "exit");
      }
      return {
        started: wasStarted,
        code: agent.exitCode,
        stderr,
        args: readFileSync(argsFile, "utf8").split("\n"),
      };
    };
    try {
      const passing = await run(`cat '${join(directory, "expected")}'`);
      assert.equal(passing.started, true);
      assert.deepEqual(passing.args.slice(0, 3), [workspace, "-c", probe.command]);
      assert.match(passing.stderr, /source=inner stage=native-hook reason=observed/);
      for (const [behaviour, reason] of [
        ["exit 126", "hook-denied"],
        ["exit 127", "hook-denied"],
        ["exit 133", "hook-failed"],
        ["kill -9 $$", "hook-failed"],
        [`cat '${join(directory, "wrong")}'`, "hook-response"],
        [`cat '${join(directory, "expected")}'; exit 2`, "hook-failed"],
      ] as const) {
        const refused = await run(behaviour);
        assert.equal(refused.started, false, behaviour);
        assert.equal(refused.code, 1, behaviour);
        assert.match(
          refused.stderr,
          new RegExp(`strands-box-diagnostic source=inner stage=native-hook reason=${reason}\\n`),
          behaviour,
        );
        assert.doesNotMatch(refused.stderr, /reason=observed/, behaviour);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
