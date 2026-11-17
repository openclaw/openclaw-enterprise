import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OperatorRace } from "../fixtures/strands-box/operator-race-preload.ts";
import {
  answerFor,
  promptFor,
  controlledModel,
  terminal,
} from "../../deploy/examples/strands-box/ordinary-chat/box-workload.ts";
import {
  gatewayChatCall,
  inspectFixture,
  inspectHistory,
  inspectPolicyRecords,
  inspectTerminal,
} from "../../deploy/examples/strands-box/ordinary-chat/operator.ts";
import { withOwnerFiles } from "../../deploy/examples/strands-box/ordinary-chat/owner-check.ts";

const path = "/opt/demo/verifier/oce-workspace-verifier";
const marker = "a".repeat(48);
const nonce = "b".repeat(48);
const otherNonce = "c".repeat(48);
const session = "agent:main:box-repro-00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const header = "Wall time: 0.1234 seconds\nProcess exited with code 0\nOutput:\n";
const evidence = `strands-shell: effect denied: policy denied this operation on '${path}' [default-deny]: No permit policy matched this request.\nOCE_BOX_MARKER_IDENTITY 0 27 155\nOCE_BOX_MODEL_MARKER ${marker}\n`;
test("the documented Gateway model selects the credential-free native Box fixture", () => {
  const example = new URL("../../deploy/examples/strands-box/ordinary-chat/", import.meta.url);
  const readme = readFileSync(new URL("README.md", example), "utf8");
  const fragment = /```json\n([\s\S]*?)\n```/.exec(readme)?.[1];
  assert.ok(fragment);
  const config = JSON.parse(fragment) as {
    agents: {
      entries: Record<string, unknown>;
      defaults: {
        model: { primary: string; fallbacks: string[] };
        models: Record<string, { agentRuntime: { id: string } }>;
      };
    };
    models: { providers: Record<string, unknown> };
  };
  const launcher = readFileSync(new URL("launch-fixture.ts", example), "utf8");
  const provider = /^model_provider = "([a-z_]+)"$/m.exec(launcher)?.[1];
  const model = /^const modelConfig = `model = "([^"]+)"$/m.exec(launcher)?.[1];
  const baseUrl = /^base_url = "(http:\/\/127\.0\.0\.1:\d+\/v1)"$/m.exec(launcher)?.[1];
  assert.ok(provider && model && baseUrl);
  const selected = `codex/${provider}/${model}`;
  assert.deepEqual(config.agents.entries, { main: {} });
  assert.deepEqual(config.agents.defaults.model, { primary: selected, fallbacks: [] });
  assert.deepEqual(config.agents.defaults.models, {
    [selected]: { agentRuntime: { id: "codex" } },
  });
  assert.deepEqual(config.models.providers, {
    codex: {
      baseUrl,
      api: "openai-responses",
      models: [{ id: `${provider}/${model}`, name: "Controlled gpt-5" }],
    },
  });
});

test("actual loopback fixture submits one approved tool and refuses replay", async () => {
  const rows: Record<string, unknown>[] = [];
  const server = controlledModel(nonce, (row) => rows.push(row));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const invoke = (input: unknown[]) =>
      fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5", input, tools: [{ name: "exec_command" }] }),
      });
    const original = [{ role: "user", content: [{ type: "input_text", text: promptFor(nonce) }] }];
    assert.equal((await invoke([{ role: "user", content: promptFor(otherNonce) }])).status, 409);
    assert.equal((await invoke([...original, ...original])).status, 409);
    assert.equal(rows.length, 0);
    const first = await invoke(original);
    assert.equal(first.status, 200);
    const sent = (await first.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map(
        (line) =>
          JSON.parse(line.slice(5)) as {
            type: string;
            item?: { call_id: string; name: string; arguments: string };
          },
      );
    const tool = sent.find((line) => line.type === "response.output_item.done")?.item;
    assert.ok(tool);
    assert.equal(tool.name, "exec_command");
    assert.deepEqual(JSON.parse(tool.arguments), {
      cmd: `${path} --refused-alternate; ${path}`,
      workdir: "/home/node/workspace",
      login: false,
      yield_time_ms: 10000,
      max_output_tokens: 1000,
    });
    const id = tool.call_id;
    assert.ok(id);
    const output = { type: "function_call_output", call_id: id, output: header + evidence };
    assert.equal((await invoke([{ ...output, call_id: "different" }])).status, 409);
    assert.equal(
      (await invoke([{ role: "user", content: promptFor(otherNonce) }, output])).status,
      409,
    );
    assert.equal(rows.length, 1);
    assert.equal((await invoke(original)).status, 409);
    const finished = await invoke([output]);
    assert.equal(finished.status, 200);
    const parsed = terminal(header + evidence);
    assert.ok(parsed);
    assert.equal(parsed.inode, "155");
    const expectedAnswer = answerFor(nonce, parsed.markerSha256);
    assert.ok((await finished.text()).includes(expectedAnswer));
    assert.equal(rows.length, 2);
    const received = rows.at(1);
    assert.ok(received);
    const namespace = { stage: "same_network_namespace", synthetic: true, nonce };
    assert.equal(inspectFixture([namespace, ...rows], nonce, parsed), true);
    assert.equal(inspectFixture([namespace, ...rows], otherNonce, parsed), false);
    assert.equal(
      inspectFixture([namespace, rows[0], { ...received, callId: "foreign" }], nonce, parsed),
      false,
    );
    assert.equal(
      inspectFixture(
        [namespace, rows[0], { ...received, answer: answerFor(otherNonce, parsed.markerSha256) }],
        nonce,
        parsed,
      ),
      false,
    );
    assert.equal(inspectFixture([namespace, rows[0]], nonce, parsed), false);
    assert.equal((await invoke([output])).status, 409);
    assert.equal(terminal(header + evidence.replace("[default-deny]", "[missing]")), undefined);
    assert.equal(terminal(header + evidence + evidence), undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
test("stock event correlation needs exact named permit and one denied alternate", () => {
  const log = (verdict: string, args: string[], rule: string) => ({
    attributes: [
      ...Object.entries({
        "strands.box.policy.action": "shell:spawn",
        "strands.box.policy.rule": rule,
        "strands.box.policy.verdict": verdict,
        "process.command": path,
        "process.working_directory": "/home/node/workspace",
      }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
      {
        key: "process.command_args",
        value: { arrayValue: { values: args.map((stringValue) => ({ stringValue })) } },
      },
    ],
  });
  const allow = log("permit", [path], "oce_workspace_verifier");
  const deny = log("deny", [path, "--refused-alternate"], "default-deny");
  const pack = (logRecords: unknown[]) =>
    JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });
  assert.equal(inspectPolicyRecords(pack([deny, allow])), true);
  assert.equal(inspectPolicyRecords(pack([deny, allow, allow])), false);
  assert.equal(inspectPolicyRecords(pack([deny, log("permit", [path], "other")])), false);
});

test("the stock caller emits one normal chat.send with bound history and configured auth", () => {
  const send = gatewayChatCall("chat.send", session, runId, nonce);
  const read = gatewayChatCall("chat.history", session, runId, nonce);
  const wait = gatewayChatCall("agent.wait", session, runId, nonce);
  const [command, verb, method, expect, endpoint, params, payload, format] = send;
  assert.deepEqual(
    [command, verb, method, expect, endpoint, params, format],
    ["gateway", "call", "chat.send", "--expect-url", "ws://127.0.0.1:18789", "--params", "--json"],
  );
  assert.deepEqual(JSON.parse(payload ?? ""), {
    sessionKey: session,
    message: promptFor(nonce),
    deliver: false,
    timeoutMs: 90000,
    idempotencyKey: runId,
  });
  assert.deepEqual(read, [
    "gateway",
    "call",
    "chat.history",
    "--expect-url",
    "ws://127.0.0.1:18789",
    "--params",
    JSON.stringify({ sessionKey: session, limit: 8 }),
    "--json",
  ]);
  assert.deepEqual(wait, [
    "gateway",
    "call",
    "agent.wait",
    "--expect-url",
    "ws://127.0.0.1:18789",
    "--params",
    JSON.stringify({ runId, timeoutMs: 5000 }),
    "--json",
  ]);
});

test("normal history and terminal must belong to this prompt and exact run", () => {
  const digest = "d".repeat(64);
  const user = { role: "user", content: promptFor(nonce) };
  const tool = { role: "assistant", content: [{ type: "toolCall", id: "some-tool" }] };
  const final = { role: "assistant", content: [{ type: "text", text: answerFor(nonce, digest) }] };
  const history = (messages: unknown[], key = session) =>
    inspectHistory({ sessionKey: key, messages }, session, nonce, digest);
  assert.equal(history([user, tool, final]), true);
  assert.equal(history([final]), false);
  assert.equal(history([user, final], "agent:main:wrong"), false);
  assert.equal(history([{ ...user, content: promptFor(otherNonce) }, final]), false);
  assert.equal(history([user, { ...final, content: answerFor(otherNonce, digest) }]), false);
  assert.equal(
    history([user, { ...final, content: "BOX_WORKSPACE_REPRO_SHA256 " + digest }]),
    false,
  );
  assert.equal(history([user, user, final]), false);
  assert.equal(history([user, final, final]), false);
  assert.equal(history([final, user]), false);
  assert.equal(history([user, final, tool]), false);
  assert.equal(inspectTerminal({ runId, status: "ok" }, runId), true);
  assert.equal(inspectTerminal({ runId: "wrong", status: "ok" }, runId), false);
  assert.equal(inspectTerminal({ runId, status: "timeout" }, runId), false);
});

test(
  "the independent owner check pins immutable files and refuses substitution",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    const uid = process.getuid?.();
    assert.notEqual(uid, undefined);
    const parent = mkdtempSync(join(tmpdir(), "box-owner-check-"));
    const directory = join(parent, "openclaw-external-workspace-owner");
    const binding = join(directory, "binding.json");
    const ca = join(directory, "ca.pem");
    mkdirSync(directory, { mode: 0o700 });
    const immutable = (path: string, value: string) => {
      writeFileSync(path, value, { flag: "wx", mode: 0o444 });
      chmodSync(path, 0o444);
    };
    try {
      immutable(binding, "original binding");
      immutable(ca, "original ca");
      const owner = BigInt(uid ?? -1);
      assert.equal(
        await withOwnerFiles(parent, owner, async (files) => {
          assert.equal(files.ca.toString(), "original ca");
          files.assertCurrent();
          return files.binding.toString();
        }),
        "original binding",
      );

      await assert.rejects(
        withOwnerFiles(parent, owner, async () => {
          renameSync(ca, join(directory, "prior-ca.pem"));
          immutable(ca, "original ca");
        }),
        /OWNER_DIRECTORY_REPLACED|OWNER_FILE_REPLACED/,
      );

      chmodSync(ca, 0o644);
      await assert.rejects(
        withOwnerFiles(parent, owner, async () => {
          assert.fail("writable CA reached consumer");
        }),
        /OWNER_FILE_REFUSED/,
      );

      rmSync(ca);
      symlinkSync("prior-ca.pem", ca);
      await assert.rejects(
        withOwnerFiles(parent, owner, async () => {
          assert.fail("symbolic link reached consumer");
        }),
        { code: "ELOOP" },
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

const operator = fileURLToPath(
  new URL("../../deploy/examples/strands-box/ordinary-chat/operator.ts", import.meta.url),
);
const operatorPreload = new URL(
  "../fixtures/strands-box/operator-race-preload.ts",
  import.meta.url,
);
const installedUrl = "wss://installed.example.test/";
const otherInstalledUrl = "wss://alternate.example.test/";
const standaloneUrl = "ws://127.0.0.1:18789";

function withOperatorFixture(
  use: (fixture: {
    base: string;
    original: string;
    alternate: string;
    put: (path: string, row: object) => void;
    invoke: (args: string[], race?: OperatorRace) => SpawnSyncReturns<string>;
    runSubmit: (race?: OperatorRace) => SpawnSyncReturns<string>;
  }) => void,
) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "box-operator-"));
  const original = join(base, "original", "run");
  const alternate = join(base, "alternate", "run");
  const cli = join(base, "gateway-cli.ts");
  const put = (path: string, row: object) =>
    writeFileSync(path, JSON.stringify(row), { flag: "wx", mode: 0o600 });
  const invoke = (args: string[], race?: OperatorRace) =>
    spawnSync(process.execPath, ["--import", operatorPreload.href, ...args], {
      env: { STRANDS_TEST_OPERATOR_ROOT: base, STRANDS_TEST_OPERATOR_RACE: race },
      encoding: "utf8",
      timeout: 10000,
    });
  const runSubmit = (race?: OperatorRace) => invoke([operator, "submit", original, cli], race);
  try {
    for (const directory of [original, alternate, join(base, "workspace")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(
      cli,
      `#!${process.execPath}
${readFileSync(operatorPreload, "utf8")}`,
      {
        mode: 0o700,
      },
    );
    const seeded = invoke([operator, "seed", original]);
    assert.equal(seeded.status, 0, seeded.stderr);
    const originalExpected = JSON.parse(readFileSync(join(original, "expected.json"), "utf8")) as {
      nonce: string;
    };
    const differentNonce = originalExpected.nonce === otherNonce ? nonce : otherNonce;
    put(join(alternate, "expected.json"), { ...originalExpected, nonce: differentNonce });
    const ownerReceipt = (char: string) => ({
      stage: "original_box_wss",
      verifiedTls: true,
      generationSha256: char.repeat(64),
      ingressLeafSha256: "1".repeat(64),
    });
    put(join(original, "owner-wss.json"), ownerReceipt("a"));
    put(join(alternate, "owner-wss.json"), ownerReceipt("b"));
    put(join(alternate, "gateway.json"), { url: otherInstalledUrl });
    use({ base, original, alternate, put, invoke, runSubmit });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function assertSubmission(base: string, run: string, url: string) {
  const intent = JSON.parse(readFileSync(join(run, "intent.json"), "utf8")) as {
    gatewayUrl: string;
    generationSha256: string;
    nonce: string;
  };
  const expected = JSON.parse(readFileSync(join(run, "expected.json"), "utf8")) as {
    nonce: string;
  };
  assert.equal(intent.nonce, expected.nonce);
  assert.equal(intent.generationSha256, "a".repeat(64));
  assert.equal(intent.gatewayUrl, url);
  assert.deepEqual(JSON.parse(readFileSync(join(run, "client-exit.json"), "utf8")), {
    code: 0,
    signal: null,
    accepted: true,
  });
  const invoked = JSON.parse(readFileSync(join(base, "cli.jsonl"), "utf8")) as string[];
  assert.equal(invoked[4], url);
}

for (const gateway of [undefined, installedUrl]) {
  test(
    `ordinary chat submits to ${gateway ?? standaloneUrl} with its own intent`,
    { skip: process.platform !== "linux" },
    () =>
      withOperatorFixture(({ base, original, put, runSubmit }) => {
        if (gateway) {
          put(join(original, "gateway.json"), { url: gateway });
        }
        const submitted = runSubmit();
        assert.equal(submitted.status, 0, submitted.stderr);
        assert.equal(submitted.stdout, "BOX_REPRO_CHAT_ACCEPTED\n");
        assertSubmission(base, original, gateway ?? standaloneUrl);
      }),
  );
}

for (const [race, refusal] of [
  ["gateway-removed", "BOX_REPRO_REFUSED"],
  ["gateway-removed-after-read", "INSTALLED_GATEWAY_ORIGIN_REFUSED"],
] as const) {
  test(
    `installed Gateway disappearance refuses without standalone submission (${race})`,
    { skip: process.platform !== "linux" },
    () =>
      withOperatorFixture(({ base, original, put, runSubmit }) => {
        put(join(original, "gateway.json"), { url: installedUrl });
        const submitted = runSubmit(race);
        assert.equal(existsSync(join(original, "gateway.json.moved")), true);
        assert.equal(submitted.status, 1, submitted.stderr);
        assert.equal(submitted.stderr, refusal + "\n");
        assert.equal(existsSync(join(original, "intent.json")), false);
        assert.equal(existsSync(join(original, "client-exit.json")), false);
        assert.equal(existsSync(join(base, "cli.jsonl")), false);
      }),
  );
}

test(
  "ordinary chat refuses a replaced workspace after checking its original marker",
  { skip: process.platform !== "linux" },
  () =>
    withOperatorFixture(({ base, original, put, runSubmit }) => {
      put(join(original, "gateway.json"), { url: installedUrl });
      const submitted = runSubmit("workspace-replaced-after-marker");
      assert.equal(existsSync(join(base, "moved-workspace", ".oce-model-marker")), true);
      assert.equal(existsSync(join(base, "workspace", ".oce-model-marker")), false);
      assert.equal(submitted.status, 1, submitted.stderr);
      assert.equal(submitted.stderr, "WORKSPACE_PATH_REFUSED\n");
      assert.equal(existsSync(join(original, "intent.json")), false);
      assert.equal(existsSync(join(original, "client-exit.json")), false);
      assert.equal(existsSync(join(base, "cli.jsonl")), false);
    }),
);

test(
  "seeded nonce stays in the admitted directory after ancestor symlink substitution",
  { skip: process.platform !== "linux" },
  () =>
    withOperatorFixture(({ base, original, alternate, invoke }) => {
      const nonceAt = (run: string) =>
        (JSON.parse(readFileSync(join(run, "expected.json"), "utf8")) as { nonce: string }).nonce;
      const expected = nonceAt(original);
      const foreign = nonceAt(alternate);
      assert.notEqual(expected, foreign);
      const observed = invoke(
        [
          "--input-type=module",
          "-e",
          `import { seededNonce } from ${JSON.stringify(operator)}; process.stdout.write(seededNonce(process.argv[1]));`,
          original,
        ],
        "ancestor-at-expected",
      );
      assert.equal(nonceAt(join(base, "moved", "run")), expected);
      assert.equal(nonceAt(original), foreign);
      assert.equal(observed.status, 0, observed.stderr);
      assert.equal(observed.stdout, expected);
    }),
);

test(
  "ordinary chat refuses a replaced run before calling the Gateway",
  { skip: process.platform !== "linux" },
  () =>
    withOperatorFixture(({ base, original, put, runSubmit }) => {
      put(join(original, "gateway.json"), { url: installedUrl });
      const submitted = runSubmit("directory-at-intent");
      assert.equal(submitted.status, 1, submitted.stderr);
      assert.equal(submitted.stderr, "REPRO_ROOT_REFUSED\n");
      // The exclusive write was already underway. Its intent stays with run A,
      // and the post-write custody check refuses before invoking the client.
      const moved = join(base, "moved");
      const intent = JSON.parse(readFileSync(join(moved, "intent.json"), "utf8")) as {
        gatewayUrl: string;
      };
      assert.equal(intent.gatewayUrl, installedUrl);
      assert.equal(existsSync(join(moved, "client-exit.json")), false);
      assert.equal(existsSync(join(base, "cli.jsonl")), false);
      assert.equal(existsSync(join(original, "intent.json")), false);
      assert.equal(existsSync(join(original, "client-exit.json")), false);
    }),
);
