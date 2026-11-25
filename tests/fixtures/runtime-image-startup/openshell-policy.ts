import type { bundledExport, loadCodexClient, loadCodexConfig } from "./bundled-codex.ts";
import type { list, parseJson, record, text } from "./wire.ts";

export async function probeOpenShellPolicy(
  historicalCodex: boolean,
  load: typeof bundledExport,
  loadClient: typeof loadCodexClient,
  loadConfig: typeof loadCodexConfig,
  asList: typeof list,
  parse: typeof parseJson,
  read: typeof record,
  asText: typeof text,
  peerScript: typeof probeOpenShellPeer,
) {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const resolveCodexAppServerRuntimeOptions = await loadConfig(load, read);
  const threadPermissions = await load("thread-requests", "codexThreadSandboxOrPermissions");
  const buildTurnStartParams = await load("dynamic-tools", "buildTurnStartParams");
  const startClient = await loadClient(load, read);
  const config = {
    agents: { defaults: { model: "codex/gpt-6-astra" } },
    models: {
      providers: {
        codex: {
          baseUrl: "http://127.0.0.1:9",
          api: "openai-responses",
          models: [{ id: "gpt-6-astra", name: "gpt-6-astra" }],
        },
      },
    },
  };
  const profile = ":danger-full-access";
  const providerEnv = { OPENCLAW_CODEX_PROVIDER_PERMISSION_PROFILE: profile };
  async function permissionFields(
    appServer: Record<string, unknown>,
    sandboxPolicy?: { type: "readOnly" },
  ) {
    const thread = threadPermissions(appServer);
    const turn = read(
      await buildTurnStartParams(
        { prompt: "policy check", hostCapabilities: {}, config },
        {
          appServer,
          sandboxPolicy,
          cwd: "/tmp",
          preserveNativeTurnSettings: true,
        },
      ),
    );
    return [
      thread,
      turn.permissions ?? (turn.sandboxPolicy == null ? undefined : read(turn.sandboxPolicy).type),
    ];
  }
  const results = await Promise.all(
    asList(parse(asText(process.argv[1]))).map(async (value) => {
      const { appServer, modelProvider } = read(value);
      const resolve = (env: NodeJS.ProcessEnv) =>
        resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer },
          modelProvider,
          model: "gpt-6-astra",
          config,
          env,
          requirementsToml: null,
        });
      const runtime = resolve(providerEnv);
      assert.deepEqual(await permissionFields(runtime), [{ permissions: profile }, profile]);
      const local = resolve({});
      assert.deepEqual(await permissionFields(local), [
        { sandbox: "danger-full-access" },
        "dangerFullAccess",
      ]);
      const restricted = { ...runtime, sandbox: "workspace-write" };
      assert.deepEqual(await permissionFields(restricted), [
        { sandbox: "workspace-write" },
        "workspaceWrite",
      ]);
      const proxied = resolveCodexAppServerRuntimeOptions({
        pluginConfig: {
          appServer: {
            ...read(appServer),
            networkProxy: {
              enabled: true,
              baseProfile: "workspace",
              mode: "limited",
              domains: {},
              unixSockets: {},
            },
          },
        },
        modelProvider,
        model: "gpt-6-astra",
        config,
        env: providerEnv,
        requirementsToml: null,
      });
      const { profileName } = read(proxied.networkProxy);
      assert.ok(profileName);
      assert.deepEqual(
        await permissionFields(proxied),
        historicalCodex ? [{}, undefined] : [{ permissions: profileName }, profileName],
      );
      assert.equal((await permissionFields(runtime, { type: "readOnly" }))[1], "readOnly");
      return { sandbox: runtime.sandbox, approvalsReviewer: runtime.approvalsReviewer };
    }),
  );

  // A real Codex can accept thread/start yet constrain its effective sandbox. The bundled
  // Gateway client must surface that refusal before the caller can use the thread for a turn.
  const client = await startClient({
    transport: "stdio",
    commandSource: "config",
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
  });
  try {
    await client.initialize();
    const request = {
      cwd: "/tmp",
      ephemeral: true,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    };
    const control = read(
      await client.request("thread/start", { ...request, sandbox: "read-only" }),
    );
    assert.equal(read(control.sandbox).type, "readOnly");
    await assert.rejects(
      client.request("thread/start", { ...request, permissions: profile }),
      (error) => {
        const message =
          "thread/start: Codex did not grant the requested :danger-full-access profile";
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          historicalCodex
            ? message
            : message +
                " (comparison=sandbox-readOnly). Check native permission requirements and runtime compatibility.",
        );
        return true;
      },
    );
    if (!historicalCodex) {
      // Managed read-only requirements also refuse a workspace profile. Check the native
      // response before exposing that silently substituted thread to the Gateway caller.
      for (const [selection, source, selectors] of [
        [{ permissions: ":workspace" }, "permissions", "single"],
        [{ config: { default_permissions: ":workspace" } }, "configDefault", "single"],
        [
          { permissions: ":workspace", config: { default_permissions: ":workspace" } },
          "permissions",
          "both-equal",
        ],
        [
          { permissions: ":workspace", config: { default_permissions: ":read-only" } },
          "permissions",
          "both-different",
        ],
      ] as const) {
        await assert.rejects(
          client.request("thread/start", { ...request, ...selection }),
          (error) => {
            // The real managed read-only response has activePermissionProfile: null.
            // Exact text also excludes arbitrary profile values from the diagnostic.
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              "thread/start: Codex did not grant the requested permission profile (requestSource=" +
                source +
                ", selectors=" +
                selectors +
                ", comparison=field-null). " +
                "Ask your workspace administrator to verify profile availability and runtime compatibility before retrying.",
            );
            return true;
          },
        );
      }
      // Malformed-peer metadata coverage through the actual bundled client, not native
      // Codex proof: preserve the real control response except for the omitted field.
      const peerSource =
        "(" +
        peerScript.toString() +
        ")(" +
        parse.toString() +
        "," +
        read.toString() +
        "," +
        asText.toString() +
        ");";
      const { activePermissionProfile: _profile, ...withoutProfile } = control;
      const startPeer = (result: unknown) =>
        startClient({
          transport: "stdio",
          commandSource: "config",
          command: process.execPath,
          args: ["-e", peerSource, JSON.stringify(result), asText(client.getServerVersion())],
        });
      const peer = await startPeer(withoutProfile);
      try {
        await peer.initialize();
        await assert.rejects(
          peer.request(
            "thread/start",
            { ...request, permissions: ":workspace" },
            { timeoutMs: 5000 },
          ),
          (error) => {
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              "thread/start: Codex did not grant the requested permission profile " +
                "(requestSource=permissions, selectors=single, comparison=field-absent). " +
                "Ask your workspace administrator to verify profile availability and runtime compatibility before retrying.",
            );
            return true;
          },
        );
      } finally {
        await peer.closeAndWait({ exitTimeoutMs: 2000, forceKillDelayMs: 500 });
      }
      // Protocol peers exercise the real client's guard, not native permission grants.
      // Unknown peer values must never appear in diagnostics; valid grants still pass.
      const { sandbox: _sandbox, ...withoutSandbox } = control;
      for (const [result, comparison] of [
        [null, "nonobject-result"],
        [withoutSandbox, "field-absent"],
        [{ ...control, sandbox: null }, "field-null"],
        [{ ...control, sandbox: [] }, "field-not-object"],
        [{ ...control, sandbox: {} }, "type-not-string"],
        [{ ...control, sandbox: { type: "private-peer-value" } }, "type-unrecognized"],
        [{ ...control, sandbox: { type: "workspaceWrite" } }, "sandbox-workspaceWrite"],
        [{ ...control, sandbox: { type: "externalSandbox" } }, "sandbox-externalSandbox"],
        [{ ...control, sandbox: { type: "dangerFullAccess" } }, null],
      ] as const) {
        const peer = await startPeer(result);
        try {
          await peer.initialize();
          for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
            const response = peer.request(
              method,
              { ...request, permissions: profile },
              { timeoutMs: 5000 },
            );
            if (comparison === null) {
              assert.deepEqual(await response, result);
            } else {
              await assert.rejects(response, (error) => {
                assert.ok(error instanceof Error);
                assert.equal(
                  error.message,
                  method +
                    ": Codex did not grant the requested :danger-full-access profile (comparison=" +
                    comparison +
                    "). Check native permission requirements and runtime compatibility.",
                );
                return true;
              });
            }
          }
        } finally {
          await peer.closeAndWait({ exitTimeoutMs: 2000, forceKillDelayMs: 500 });
        }
      }
    }
  } finally {
    client.close();
  }
  process.stdout.write(JSON.stringify(results));
}

// The peer preserves the native control response except for the fields each
// test changes. It shares stdin/stdout framing with the packaged client.
export function probeOpenShellPeer(
  parse: typeof parseJson,
  read: typeof record,
  asText: typeof text,
) {
  const { createInterface } = process.getBuiltinModule("node:readline");
  const result = parse(asText(process.argv[1]));
  setTimeout(() => process.exit(1), 10000).unref();
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = read(parse(line));
    if (request.id === undefined) {
      return;
    }
    if (
      !["initialize", "thread/start", "thread/resume", "thread/fork"].includes(
        asText(request.method),
      )
    ) {
      process.exit(1);
    }
    const response =
      request.method === "initialize"
        ? { userAgent: "codex-cli/" + process.argv[2], codexHome: "/home/node/.codex" }
        : result;
    process.stdout.write(JSON.stringify({ id: request.id, result: response }) + "\n");
  });
}
