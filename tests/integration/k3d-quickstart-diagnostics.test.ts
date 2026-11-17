import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(
  new URL("../../scripts/ci/k3d-quickstart/private-step.sh", import.meta.url),
);

const linearEvidence = fileURLToPath(
  new URL("../../scripts/ci/k3d-quickstart/linear-evidence.ts", import.meta.url),
);

test(
  "quickstart setup failure projects startup and deployment diagnostics without private output",
  {
    skip: process.platform !== "linux",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-diagnostics-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const scripts = join(directory, "scripts/ci/k3d-quickstart");
    const credentials = join(directory, "oce-credentials");
    const run = join(directory, "run");
    await Promise.all([scripts, credentials, run].map((path) => mkdir(path, { recursive: true })));
    const privateOutput = `private-output-${randomUUID()}`;
    const timing = "[occ-dev-timing] stage=controller-build elapsed_ms=123 failed=false";
    // These command fixtures supply an unavailable API and private runtime logs.
    // Only the real wrapper's projection is under test, not deployment behavior.
    await writeFile(
      join(run, "session.sh"),
      `
PLATFORM_NS=oce-system
RELEASE=openclaw-enterprise
TENANT_NAMESPACE=oce-tenant-fixture
namespace=ns_00000000-0000-4000-8000-000000000001
agent=agent_00000000-0000-4000-8000-000000000001
base=/namespaces/$namespace
request() { return 1; }
kube() {
  if [[ " $* " == *" get pods "* ]]; then
    printf '%s\\n' '{"apiVersion":"v1","kind":"PodList","metadata":{},"items":[]}'
  else
    cat "$RUN_DIR/runtime-fixture.log"
  fi
}
git() { command git -C "$OCE_DIAGNOSTIC_SOURCE" "$@"; }
`,
      { mode: 0o600 },
    );
    await writeFile(join(run, "requested-revision"), "rev_00000000-0000-4000-8000-000000000001\n");
    await writeFile(
      join(run, "runtime-fixture.log"),
      [
        privateOutput,
        JSON.stringify({
          severity: "ERROR",
          service: "occ-worker",
          event: "worker.error",
          code: "RUNTIME_MODEL_PROBE_FAILED",
        }),
        JSON.stringify({
          severity: "ERROR",
          service: "occ-worker",
          event: "worker.error",
          code: "PRIVATE_DIAG_SENTINEL",
        }),
        "",
      ].join("\n"),
    );
    // The stage is a subprocess fixture. The real wrapper owns exit propagation and
    // log projection; malformed or suffixed records must stay in its private log.
    await writeFile(
      join(scripts, "setup.sh"),
      [
        "#!/usr/bin/env bash",
        "cat <<'PRIVATE_OUTPUT'",
        privateOutput,
        timing,
        `[occ-dev-timing] stage=controller-build elapsed_ms=123 failed=false ${privateOutput}`,
        `[occ-dev-timing] stage=${privateOutput} elapsed_ms=1 failed=true`,
        `[occ-dev-timing] stage=runtime-build elapsed_ms=12345678901234567 failed=true`,
        "PRIVATE_OUTPUT",
        "exit 23",
        "",
      ].join("\n"),
    );
    const result = spawnSync("bash", [wrapper, "setup"], {
      cwd: directory,
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        RUN_DIR: run,
        OCE_DIAGNOSTIC_SOURCE: fileURLToPath(new URL("../../", import.meta.url)),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 23);
    const published = result.stdout + result.stderr;
    assert.ok(published.includes("setup failed (exit 23)"));
    assert.equal(
      published
        .split("\n")
        .filter((line) => line.startsWith("[occ-dev-timing]"))
        .join("\n"),
      timing,
    );
    assert.ok(!published.includes(privateOutput));
    assert.ok(published.includes("API Pods: 0, Ready: 0"));
    assert.ok(published.includes("Capability deployment status unavailable."));
    assert.ok(published.includes("Worker diagnostic: RUNTIME_MODEL_PROBE_FAILED"));
    assert.ok(!published.includes("PRIVATE_DIAG_SENTINEL"));
    assert.ok((await readFile(join(credentials, "setup.log"), "utf8")).includes(privateOutput));
  },
);

test(
  "quickstart browser recall publishes a source location without the private state path",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-browser-diagnostics-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const credentials = join(directory, "oce-credentials");
    const run = join(directory, "run");
    await Promise.all([mkdir(credentials), mkdir(run)]);
    // Supply the launcher's active-revision lookup so the real browser command
    // fails on missing installed state before it creates a Chromium profile.
    await writeFile(
      join(run, "session.sh"),
      [
        "namespace=ns_00000000-0000-4000-8000-000000000001",
        "agent=agt_00000000-0000-4000-8000-000000000001",
        'base="/namespaces/$namespace"',
        "CONSOLE_ORIGIN=https://console.fixture.oce.localhost",
        'request() { printf \'%s\\n\' \'{"data":{"activeRevisionId":"rev_00000000-0000-4000-8000-000000000001"}}\'; }',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = spawnSync("bash", [wrapper, "browser-recall"], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, RUNNER_TEMP: directory, RUN_DIR: run },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const published = result.stdout + result.stderr;
    assert.match(published, /^Control UI verification failed during initialize\.$/m);
    assert.match(published, /^quickstart-location browser\.ts:[0-9]{1,5}$/m);
    assert.ok(!published.includes(directory));
  },
);

test(
  "quickstart Linear failures keep malformed evidence and diagnostic errors private",
  { skip: process.platform !== "linux" },
  async (t) => {
    const malformedTool = {
      role: "assistant",
      content: [{ type: "toolCall", name: { toString: null, valueOf: null } }],
    };
    for (const [name, artifact, unreadableMarker] of [
      ["null history row", { history: { messages: [null] } }, false],
      [
        "malformed tool name",
        { history: { messages: [{ role: "user", content: "fixture marker" }, malformedTool] } },
        false,
      ],
      ["unreadable marker", {}, true],
    ] as const) {
      await t.test(name, async (caseContext) => {
        const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-linear-diagnostics-"));
        caseContext.after(() => rm(directory, { recursive: true, force: true }));
        const scripts = join(directory, "scripts/ci/k3d-quickstart");
        const credentials = join(directory, "oce-credentials");
        const run = join(directory, "run");
        await Promise.all(
          [scripts, credentials, run].map((path) => mkdir(path, { recursive: true })),
        );
        const privateOutput = `private-output-${randomUUID()}`;
        const marker = join(run, "linear-marker");

        // The actual diagnostic command reads these runner-owned artifacts after
        // the stage fails. The stage fixture supplies a failure without a live account.
        await Promise.all([
          copyFile(linearEvidence, join(scripts, "linear-evidence.ts")),
          writeFile(join(scripts, "linear.sh"), `printf '%s\\n' '${privateOutput}'\nexit 23\n`),
          writeFile(join(run, "linear-result"), JSON.stringify(artifact)),
          writeFile(join(run, "linear-stage"), "evidence\n"),
          unreadableMarker ? mkdir(marker) : writeFile(marker, "fixture marker\n"),
        ]);
        const result = spawnSync("bash", [wrapper, "linear"], {
          cwd: directory,
          env: { ...process.env, RUNNER_TEMP: directory, RUN_DIR: run },
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 23);
        assert.equal(result.stderr, "");
        assert.ok(result.stdout.includes("linear failed (exit 23)"));
        assert.ok(!result.stdout.includes(privateOutput));
        const privateLog = await readFile(join(credentials, "linear.log"), "utf8");
        assert.ok(privateLog.includes(privateOutput));
        if (unreadableMarker) {
          assert.ok(result.stdout.includes("Linear diagnostics unavailable."));
          assert.ok(privateLog.includes("EISDIR"));
        } else {
          assert.ok(result.stdout.includes("Linear stage: evidence"));
          assert.ok(!result.stdout.includes("Linear diagnostics unavailable."));
        }
      });
    }
  },
);

test("quickstart Linear history rejects array rows and content blocks", async (t) => {
  const marker = "fixture marker";
  const team = "c38f6cb7-728c-4b26-b10e-fd723fa972ce";
  const toolName = "codex_apps.linear.list_teams";
  const toolCallId = "fixture-call";
  const toolCall = { type: "toolCall", name: toolName, id: toolCallId };
  const toolResult = { role: "toolResult", toolName, toolCallId, content: { team } };
  for (const [name, mode, exit] of [
    ["valid history", "valid", 0],
    ["array message row", "message", 1],
    ["array assistant block", "block", 1],
  ] as const) {
    await t.test(name, async (caseContext) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-linear-history-"));
      caseContext.after(() => rm(directory, { recursive: true, force: true }));
      // Each invalid artifact also contains the same valid marked turn and tool result.
      // The additional malformed row or block must prevent a history-only success.
      const messages = [
        { role: "user", content: marker },
        { role: "assistant", content: mode === "block" ? [toolCall, []] : [toolCall] },
        toolResult,
        ...(mode === "message" ? [[]] : []),
      ];
      await Promise.all([
        writeFile(join(directory, "linear-marker"), marker),
        writeFile(
          join(directory, "linear-result"),
          JSON.stringify({
            outcome: { status: "ok", terminalReply: { text: team } },
            history: { messages },
          }),
        ),
      ]);
      const result = spawnSync(process.execPath, [linearEvidence, "history", directory], {
        env: { ...process.env, OCC_TEST_LINEAR_TEAM_ID: team },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(result.status, exit);
    });
  }
});

test("quickstart Linear history checks fields before accepting the matched run", async (t) => {
  const marker = "fixture marker";
  const team = "c38f6cb7-728c-4b26-b10e-fd723fa972ce";
  const runId = "fixture-run";
  const name = "codex_apps.linear.list_teams";
  const id = "fixture-call";
  const call = { type: "toolCall", name, id };
  const result = {
    role: "toolResult",
    toolName: name,
    toolCallId: id,
    __openclaw: { runId },
    content: { team },
  };
  for (const [label, extraBlock, extraRow, matchedResult, exit] of [
    ["valid attributed history", undefined, undefined, result, 0],
    ["array run attribution", undefined, undefined, { ...result, __openclaw: [] }, 1],
    ["nonstring run ID", undefined, undefined, { ...result, __openclaw: { runId: 0 } }, 1],
    ["missing tool call name", { type: "toolCall", id: "extra" }, undefined, result, 1],
    ["empty tool call ID", { type: "toolCall", name, id: "" }, undefined, result, 1],
    ["empty tool result name", undefined, { ...result, toolName: "" }, result, 1],
    ["nonboolean result error", undefined, undefined, { ...result, isError: "true" }, 1],
  ] as const) {
    await t.test(label, async (caseContext) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-linear-fields-"));
      caseContext.after(() => rm(directory, { recursive: true, force: true }));
      const messages = [
        { role: "user", content: marker },
        { role: "assistant", content: extraBlock === undefined ? [call] : [call, extraBlock] },
        matchedResult,
        ...(extraRow === undefined ? [] : [extraRow]),
      ];
      // Every variant retains a marked prompt and team-bearing reply. A
      // malformed tool event must send the caller to the transcript fallback.
      await Promise.all([
        writeFile(join(directory, "linear-marker"), marker),
        writeFile(
          join(directory, "linear-result"),
          JSON.stringify({
            runId,
            outcome: { status: "ok", terminalReply: { text: team } },
            history: { messages },
          }),
        ),
      ]);
      const checked = spawnSync(process.execPath, [linearEvidence, "history", directory], {
        env: { ...process.env, OCC_TEST_LINEAR_TEAM_ID: team },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(checked.error, undefined);
      assert.equal(checked.stdout, "");
      assert.equal(checked.stderr, "");
      assert.equal(checked.status, exit);
    });
  }
});

test("quickstart Linear history requires prompt and result text", async (t) => {
  const marker = "fixture marker";
  const team = "c38f6cb7-728c-4b26-b10e-fd723fa972ce";
  const name = "codex_apps.linear.list_teams";
  const id = "fixture-call";
  const prompt = [{ type: "text", text: marker }];
  const content = [
    { type: "text", text: "teams", result: { teams: [{ id: team.toUpperCase() }] } },
  ];
  for (const [label, userContent, resultContent, exit] of [
    ["prompt text and nested team value", prompt, content, 0],
    [
      "prompt marker only in a field name",
      [{ type: "text", text: "unmarked", [marker]: "unrelated" }],
      content,
      1,
    ],
    [
      "team only in a field name",
      prompt,
      [{ type: "text", text: "no match", [team]: "unrelated" }],
      1,
    ],
  ] as const) {
    await t.test(label, async (caseContext) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-linear-evidence-"));
      caseContext.after(() => rm(directory, { recursive: true, force: true }));
      const messages = [
        { role: "user", content: userContent },
        { role: "assistant", content: [{ type: "toolCall", name, id }] },
        { role: "toolResult", toolName: name, toolCallId: id, content: resultContent },
      ];
      // The terminal reply always has the team. The history must also prove a
      // marked prompt and a matched result with the team in its actual content.
      await Promise.all([
        writeFile(join(directory, "linear-marker"), marker),
        writeFile(
          join(directory, "linear-result"),
          JSON.stringify({
            outcome: { status: "ok", terminalReply: { text: team } },
            history: { messages },
          }),
        ),
      ]);
      const checked = spawnSync(process.execPath, [linearEvidence, "history", directory], {
        env: { ...process.env, OCC_TEST_LINEAR_TEAM_ID: team },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(checked.error, undefined);
      assert.equal(checked.stdout, "");
      assert.equal(checked.stderr, "");
      assert.equal(checked.status, exit);
    });
  }
});
