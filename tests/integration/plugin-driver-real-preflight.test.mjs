import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Run in a child so selection is set before the real fixture module is loaded,
// without changing the caller's environment or touching a cluster or database.
test("the full real plugin proof rejects shared or missing scenario databases before provisioning", () => {
  const fixtureModule = new URL("../helpers/plugin-driver-real.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const { createPluginDriverRealFixture } = await import(${JSON.stringify(fixtureModule)});
    const scenarios = ["openclaw", "codex_linear", "codex_failure"];
    const key = (scenario) => \`OCC_TEST_PLUGIN_DRIVER_\${scenario.toUpperCase()}_DATABASE_URL\`;
    const reset = () => {
      for (const scenario of scenarios) {
        process.env[key(scenario)] = \`postgresql://user:secret@127.0.0.1:5432/\${scenario}\`;
      }
    };
    const create = (scenario) => createPluginDriverRealFixture({}, {
      scenario,
      pluginDriverId: scenario === "openclaw" ? "occ-plugin" : "codex-plugin",
      databaseUrl: process.env[key(scenario)],
    });
    for (let first = 0; first < scenarios.length; first += 1) {
      for (let second = first + 1; second < scenarios.length; second += 1) {
        reset();
        // Different credentials must not disguise the same underlying database.
        process.env[key(scenarios[second])] =
          \`postgresql://other:secret@127.0.0.1:5432/\${scenarios[first]}\`;
        for (const scenario of [scenarios[first], scenarios[second]]) {
          await assert.rejects(create(scenario), (error) => {
            assert.match(error.message, /must use separate dedicated databases/);
            assert.doesNotMatch(error.message, /secret/);
            return true;
          });
        }
      }
    }
    for (const scenario of scenarios) {
      reset();
      delete process.env[key(scenario)];
      await assert.rejects(create("openclaw"), new RegExp(key(scenario)));
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OCC_TEST_PLUGIN_DRIVER_REAL: "1",
      OCC_TEST_KUBERNETES_KUBECONFIG: "/nonexistent",
      OCC_TEST_KUBERNETES_CONTEXT: "preflight",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "preflight",
      OCC_TEST_KUBERNETES_CODEX_IMAGE: "preflight",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

// Finding 2019: a Codex turn whose prompt mirror falls before the evidence window failed with
// only the turn object. Its failure now lists every marker-bearing user message. The stub runs
// the evidence script against a local transcript instead of the gateway Pod's.
test("a Codex turn without its prompt mirror names the marker-bearing user messages", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { createNativePluginAssertions } = await import("../helpers/plugin-driver-real.mjs");
  const directory = await mkdtemp(join(tmpdir(), "codex-prompt-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = "calendar-marker-2019";
  const user = (seq, mirrorIdentity) => ({
    role: "user",
    content: `List my calendars ${marker}`,
    ...(mirrorIdentity ? { __openclaw: { mirrorIdentity, mirrorOrigin: "codex-app-server" } } : {}),
    timestamp: 1_000 + seq,
  });
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "list_calendars", arguments: {} }],
    __openclaw: { mirrorIdentity: "turn-1:tool:c1:call" },
  };
  const result = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "list_calendars",
    content: [{ type: "text", text: '{"calendars":["Work"]}' }],
    isError: false,
    __openclaw: { mirrorIdentity: "turn-1:tool:c1:result" },
  };
  const answer = {
    role: "assistant",
    content: [{ type: "text", text: `Work ${marker}` }],
    stopReason: "stop",
    __openclaw: { mirrorIdentity: "turn-1:assistant" },
  };
  function transcript(name, messages) {
    const path = join(directory, `${name}.sqlite`);
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
      );
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run("proof", "session", "{}");
      for (const [seq, message] of messages.entries()) {
        db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(
          "session",
          seq,
          JSON.stringify({ type: "message", message }),
        );
      }
    } finally {
      db.close();
    }
    return createNativePluginAssertions({
      proofMode: "codex",
      async execGateway(_agent, [, , script, ...args]) {
        const run = spawnSync(
          process.execPath,
          [
            "-e",
            script.replace(
              '"/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite"',
              JSON.stringify(path),
            ),
            ...args,
          ],
          { encoding: "utf8" },
        );
        assert.equal(run.status, 0, run.stderr);
        return { label: "stub-runtime", stdout: run.stdout };
      },
    });
  }
  const options = { sessionKey: "proof", turnMarker: marker, toolName: "list_calendars" };

  // One mirrored prompt: the turn is proven, and the listing marks the prompt in the window.
  const proven = await transcript("proven", [
    user(0, "turn-1:prompt"),
    call,
    result,
    answer,
  ]).assertSessionToolCallEvidence({}, options);
  assert.equal(proven.codexMirrorTurnVerified, true);

  // An unmirrored copy after the mirrored prompt starts the window past the prompt mirror.
  const late = transcript("late", [user(0, "turn-1:prompt"), user(1), call, result, answer]);
  const expected = [
    {
      seq: 0,
      inWindow: false,
      mirrorIdentity: "turn-1:prompt",
      mirrorOrigin: "codex-app-server",
      idempotencyKey: null,
      timestamp: 1000,
    },
    {
      seq: 1,
      inWindow: true,
      mirrorIdentity: null,
      mirrorOrigin: null,
      idempotencyKey: null,
      timestamp: 1001,
    },
  ];
  await assert.rejects(late.assertSessionToolCallEvidence({}, options), (error) => {
    assert.match(error.message, /^proof Codex native turn must include prompt, tool call/);
    const details = JSON.parse(error.message.slice(error.message.indexOf("{")).split("\n")[0]);
    assert.equal(details.turn.promptSeen, false);
    assert.deepEqual(details.markerUserMessages, expected);
    return true;
  });
  // The disabled-tool phase's check lists them too.
  const quiet = transcript("quiet", [user(0, "turn-1:prompt"), user(1), answer]);
  await assert.rejects(quiet.assertNoSessionToolCallEvidence({}, options), (error) => {
    assert.match(
      error.message,
      /^proof must include a completed marker-bearing native Codex turn: /,
    );
    const details = JSON.parse(error.message.slice(error.message.indexOf("{")).split("\n")[0]);
    assert.deepEqual(details.markerUserMessages, expected);
    return true;
  });
});
