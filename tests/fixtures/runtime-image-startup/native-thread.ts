import type { bundledExport, loadCodexClient, loadCodexConfig } from "./bundled-codex.ts";
import type { list, parseJson, record, text } from "./wire.ts";

export async function probeNativeThread(
  load: typeof bundledExport,
  loadClient: typeof loadCodexClient,
  loadConfig: typeof loadCodexConfig,
  asList: typeof list,
  parse: typeof parseJson,
  read: typeof record,
  asText: typeof text,
  inspectAccess: typeof probeNativeThreadAccess,
) {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const cp = await import("node:child_process");
  const fs = await import("node:fs");
  const { createServer } = await import("node:http");
  const { createConnection } = await import("node:net");
  const providerPath = "/tmp/synthetic-egress-provider.mjs";
  const { syntheticResponsesEvents, encodeSyntheticEvents }: Record<string, unknown> = await import(
    providerPath
  );
  assert.ok(
    typeof syntheticResponsesEvents === "function" && typeof encodeSyntheticEvents === "function",
  );
  const responseEvents = syntheticResponsesEvents as (model: unknown, text: string) => unknown;
  const encodeEvents = encodeSyntheticEvents as (events: Record<string, unknown>[]) => unknown;
  const payload = read(parse(fs.readFileSync(0, "utf8")));
  const entrypointArguments = asList(payload.entrypointArguments).map(asText);
  const syntheticApiKey = asText(payload.syntheticApiKey);
  const workspace = "/home/node/workspace";
  const codexHome = "/home/node/.codex";
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync("/home/node/.openclaw/plugin-skills", { recursive: true });
  fs.mkdirSync("/home/node/openclaw-runtime-assets/plugin-skills", { recursive: true });
  const outsideControl = "/home/node/.openclaw/plugin-skills/thread-control";
  const outsideWrite = "/home/node/.openclaw/plugin-skills/thread-outside-write";
  fs.writeFileSync(outsideControl, "synthetic-read-only-control");
  fs.writeFileSync(codexHome + "/auth.json", JSON.stringify({ OPENAI_API_KEY: syntheticApiKey }), {
    mode: 0o600,
  });
  const sentinel = codexHome + "/skill-access-sentinel-thread";
  fs.writeFileSync(sentinel, "synthetic-owned-sentinel", { mode: 0o600 });
  const probePath = workspace + "/thread-sandbox-probe.cjs";
  // A sibling read is a failure even when a later outside write is denied.
  // Emit only access results; never include contents from a protected file.
  fs.writeFileSync(
    probePath,
    "(" +
      inspectAccess.toString() +
      ")(" +
      [sentinel, outsideControl, outsideWrite].map((path) => JSON.stringify(path)).join(", ") +
      ");",
  );
  const resolveConfig = await loadConfig(load, read);
  const threadPermissions = await load("thread-requests", "codexThreadSandboxOrPermissions");
  const options = resolveConfig({ pluginConfig: payload.brokerConfiguration });
  const threadConfig = await load("thread-requests", "buildCodexRuntimeThreadConfig");
  const buildTurnStartParams = await load("dynamic-tools", "buildTurnStartParams");
  const networkProxy = read(options.networkProxy);
  const configPatch = read(networkProxy.configPatch);
  const profileName = asText(networkProxy.profileName);
  let shellCalls = 0;
  let providerFailure: string | undefined;
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.method, "POST");
      const chunks: Buffer[] = [];
      const source: AsyncIterable<unknown, unknown, unknown> = request;
      for await (const chunk of source) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const body = read(parse(Buffer.concat(chunks).toString("utf8")));
      const parsedEvents: unknown = responseEvents(body.model, "READY");
      const events = asList(parsedEvents).map(read);
      if (
        shellCalls === 0 &&
        JSON.stringify(body.input)?.includes("Run the synthetic sandbox probe once.")
      ) {
        shellCalls += 1;
        const tools = asList(body.tools ?? [])
          .map(read)
          .flatMap((tool) => asList(tool.tools ?? [tool]))
          .map(read);
        assert.ok(
          tools.some((tool) => tool.name === "exec" && tool.type === "custom"),
          "native code-mode exec must be advertised",
        );
        const command = {
          cmd: "node " + probePath,
          yield_time_ms: 10000,
          max_output_tokens: 1024,
          login: false,
          sandbox_permissions: "use_default",
        };
        const call = {
          type: "custom_tool_call",
          id: "ctc_thread_probe",
          call_id: "call_thread_probe",
          name: "exec",
          status: "completed",
          input:
            '// @exec: {"yield_time_ms": 10000}\ntext(await tools.exec_command(' +
            JSON.stringify(command) +
            "));",
        };
        events.splice(
          1,
          events.length - 2,
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...call, input: "", status: "in_progress" },
          },
          {
            type: "response.custom_tool_call_input.delta",
            item_id: call.id,
            output_index: 0,
            delta: call.input,
          },
          { type: "response.output_item.done", output_index: 0, item: call },
        );
        read(read(events.at(-1)).response).output = [call];
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const encoded: unknown = encodeEvents(events);
      assert.ok(Buffer.isBuffer(encoded));
      response.end(encoded);
    } catch {
      providerFailure = "synthetic-provider-contract-failed";
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => provider.listen(4711, "127.0.0.1", resolve));
  const environment = {
    ...read(payload.environment),
    PATH: process.env.PATH,
    HOME: "/home/node",
    CODEX_HOME: codexHome,
    CODEX_LOGIN_MODE: "api_key",
    OPENAI_API_KEY: syntheticApiKey,
    OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
    APP_SERVER_TOKEN: "synthetic-transport-token",
    APP_SERVER_PORT: "4500",
  };
  const startClient = await loadClient(load, read);
  const notifications: Record<string, unknown>[] = [];
  let client: Awaited<ReturnType<typeof startClient>> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let closing = false;
  // Run the complete OCE entrypoint, including synthetic API-key login and
  // readiness. Its real authenticated WebSocket is consumed by the packaged client.
  const native = cp.spawn(process.execPath, ["-e", ...entrypointArguments], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  native.stderr.resume();
  try {
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(new Error("native-thread-probe-timeout; provider=" + (providerFailure ?? "ok"))),
        90_000,
      );
    });
    await Promise.race([
      expired,
      (async () => {
        for (;;) {
          if (closing || native.exitCode !== null) {
            throw new Error("native-entrypoint-stopped-before-ready");
          }
          const listening = await new Promise<boolean>((resolve) => {
            const socket = createConnection({ host: "127.0.0.1", port: 4500 });
            socket.once("connect", () => {
              socket.destroy();
              resolve(true);
            });
            socket.once("error", () => {
              socket.destroy();
              resolve(false);
            });
          });
          if (listening) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        client = await startClient({
          transport: "websocket",
          url: "ws://127.0.0.1:4500",
          authToken: environment.APP_SERVER_TOKEN,
        });
        client.addNotificationHandler((notification) => {
          notifications.push(read(notification));
        });
        await client.initialize();
        const thread = read(
          await client.request("thread/start", {
            cwd: workspace,
            ephemeral: true,
            model: "gpt-5",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            ...read(threadPermissions(options)),
            config: threadConfig(
              { ...configPatch, "features.memories": false },
              { nativeCodeModeEnabled: true },
            ),
          }),
        );
        const activeId =
          thread.activePermissionProfile == null
            ? undefined
            : read(thread.activePermissionProfile).id;
        const provenance = {
          cwdMatchesExpectedWorkspace: thread.cwd === workspace,
          activePermissionProfileId: activeId == null ? null : asText(activeId).slice(0, 128),
          expectedPermissionProfile: profileName,
          legacySandboxType: thread.sandbox == null ? null : (read(thread.sandbox).type ?? null),
        };
        console.error("openclaw-ci-thread-sandbox-provenance=" + JSON.stringify(provenance));
        assert.equal(provenance.cwdMatchesExpectedWorkspace, true);
        const turnParams = read(
          await buildTurnStartParams(
            {
              prompt: "Run the synthetic sandbox probe once.",
              hostCapabilities: {},
              config: {},
            },
            {
              threadId: asText(read(thread.thread).id),
              cwd: workspace,
              appServer: options,
              // Keep the same native model; exercise the Gateway's actual per-turn
              // cwd and permission construction, not model-selection behavior.
              preserveNativeTurnSettings: true,
            },
          ),
        );
        assert.equal(turnParams.cwd, workspace);
        const turn = read(await client.request("turn/start", turnParams));
        const turnId = asText(read(turn.turn).id);
        for (;;) {
          if (closing) {
            throw new Error("native-thread-probe-closed");
          }
          const completed = notifications
            .filter((message) => message.method === "turn/completed")
            .map((message) => read(read(message.params).turn))
            .find((observedTurn) => observedTurn.id === turnId);
          if (completed) {
            assert.equal(completed.status, "completed", "native turn must complete");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(providerFailure, undefined);
        assert.equal(shellCalls, 1);
        const commands = notifications
          .filter((message) => message.method === "item/completed")
          .map((message) => read(read(message.params).item))
          .filter((item) => item.type === "commandExecution");
        assert.equal(commands.length, 1, "one real native shell command must run");
        const command = read(commands[0]);
        // The probe prints only booleans. Keep that evidence even when exit 74
        // reproduces the live sibling-read failure.
        const access = parse(asText(command.aggregatedOutput).trim());
        console.error("openclaw-ci-thread-sandbox-access=" + JSON.stringify(access));
        assert.equal(activeId, profileName);
        assert.equal(command.exitCode, 0, "native per-thread filesystem isolation failed");
        assert.deepEqual(access, {
          systemSkillReadable: true,
          systemSkillWriteDenied: true,
          siblingReadDenied: true,
          authReadDenied: true,
          outsideControlReadable: true,
          outsideWriteDenied: true,
        });
        assert.equal(fs.existsSync(outsideWrite), false, "outside write must not reach the host");
        assert.equal(fs.readFileSync(outsideControl, "utf8"), "synthetic-read-only-control");
        assert.equal(
          fs.readFileSync(workspace + "/thread-workspace-write", "utf8"),
          "synthetic-workspace-write",
        );
        console.log("native-thread-sandbox-confirmed");
      })(),
    ]);
  } finally {
    closing = true;
    clearTimeout(deadline);
    client?.close();
    native.kill("SIGTERM");
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}

// Runs as the single tool call inside the native Codex sandbox.
export function probeNativeThreadAccess(
  sentinel: string,
  outsideControl: string,
  outsideWrite: string,
) {
  const fs = process.getBuiltinModule("node:fs");
  const skill = "/home/node/.codex/skills/.system/skill-creator/SKILL.md";
  function denied(operation: () => unknown) {
    try {
      operation();
      return false;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        ["EACCES", "EPERM", "EROFS", "ENOENT"].includes(error.code)
      )) {
        throw error;
      }
      return true;
    }
  }
  const report = {
    systemSkillReadable: /name: skill-creator/.test(fs.readFileSync(skill, "utf8")),
    systemSkillWriteDenied: denied(() => fs.appendFileSync(skill, "\nsynthetic-thread-probe\n")),
    siblingReadDenied: denied(() => fs.readFileSync(sentinel)),
    authReadDenied: denied(() => fs.readFileSync("/home/node/.codex/auth.json")),
    // A write to an unbound parent can succeed in the sandbox's private tmpfs.
    outsideControlReadable:
      fs.readFileSync(outsideControl, "utf8") === "synthetic-read-only-control",
    outsideWriteDenied: denied(() => fs.writeFileSync(outsideWrite, "synthetic")),
  };
  fs.writeFileSync("/home/node/workspace/thread-workspace-write", "synthetic-workspace-write");
  console.log(JSON.stringify(report));
  process.exit(Object.values(report).every(Boolean) ? 0 : 74);
}
