import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQaCheck } from "../helpers/qa-check.mjs";
import { verifyQaStrandsSandbox } from "../helpers/qa-strands-sandbox.mjs";
import { verifyStrandsSemanticMemory } from "../helpers/qa-strands-semantic-memory.mjs";
import { verifyStrandsWorkspaceWorkflows } from "../helpers/qa-strands-workspace.mjs";

const namespaceId = "ns_11111111";
const agentId = "agt_22222222";
const modelSecretId = "sec_33333333";
const configurationId = "cfg_44444444";
const namespacePath = `/namespaces/${namespaceId}`;
const agentPath = `${namespacePath}/agents/${agentId}`;
const modelSecretPath = `${namespacePath}/secrets/${modelSecretId}`;

function fixtureState() {
  return {
    agent: {
      id: agentId,
      namespaceId,
      desiredRuntimeState: "stopped",
      configurationId,
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId, id: modelSecretId },
      },
    },
    secret: {
      id: modelSecretId,
      namespaceId,
      ref: { kind: "secret", namespaceId, id: modelSecretId },
      consumers: {
        agents: [agentId],
        configurations: [] as string[],
        credentialSources: [] as string[],
        provisioningRequests: [] as string[],
        unreadable: 0,
        truncated: false,
      },
    },
    configuration: {
      id: configurationId,
      namespaceId,
      kind: "agent",
      generation: 7,
      values: {
        agents: { defaults: { model: "codex/test-model" } },
        plugins: { allow: ["memory-core"], entries: {}, load: { paths: [] } },
        memory: { search: { provider: "none" } },
        models: { providers: {} },
      },
      secretBindings: {},
    },
  };
}

test("QA cleanup executes all actions when evidence storage keeps failing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, "report.json");
  const result = { checks: [] };
  const save = () => writeFile(evidence, JSON.stringify(result));
  await save();
  // Use a real persistent filesystem failure after setup, with no patched fs.
  await rm(evidence);
  await mkdir(evidence);
  const credential = join(root, "synthetic-credential");
  const restored = join(root, "restored");
  await writeFile(credential, "test-only-value");
  const failures: unknown[] = [];
  for (const [name, action] of [
    [
      "stop failure",
      async () => {
        throw new Error("stop failed");
      },
    ],
    ["credential withdrawal", () => rm(credential)],
    ["configuration restoration", () => writeFile(restored, "original")],
  ] as const) {
    try {
      await runQaCheck({ result, save, name, action });
    } catch (error) {
      failures.push(error);
    }
  }
  assert.equal(failures.length, 3, "reporting errors still fail the run");
  assert.match(String(failures[0]), /stop failed/u);
  await assert.rejects(readFile(credential), { code: "ENOENT" });
  assert.equal(await readFile(restored, "utf8"), "original");
});

test("Strands preflight refuses mismatched or nonexclusive model Secrets before any mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-strands-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operatorKey = join(directory, "operator-key");
  const modelKey = join(directory, "model-key");
  const fixturePath = join(directory, "fixture.json");
  await writeFile(operatorKey, "synthetic-operator-key", { mode: 0o600 });
  await writeFile(modelKey, "synthetic-model-key", { mode: 0o600 });
  const kubectl = join(directory, "kubectl");
  await writeFile(
    kubectl,
    `#!${process.execPath}\nconst namespace = process.argv.includes("namespace");\nprocess.stdout.write(JSON.stringify(namespace ? {metadata:{labels:{"openclaw.dev/namespace":"${namespaceId}"}}} : {items:[]}));\n`,
  );
  await chmod(kubectl, 0o700);
  const previous = {
    PATH: process.env.PATH,
    OCC_TEST_QA_STRANDS_FIXTURE: process.env.OCC_TEST_QA_STRANDS_FIXTURE,
    OCC_TEST_QA_OPENAI_KEY_FILE: process.env.OCC_TEST_QA_OPENAI_KEY_FILE,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.OCC_TEST_QA_STRANDS_FIXTURE = fixturePath;
  process.env.OCC_TEST_QA_OPENAI_KEY_FILE = modelKey;

  let state = fixtureState();
  const requests: Array<{ method: string; path: string }> = [];
  let beforeResponse: ((method: string, path: string) => void) | undefined;
  let acceptSecretWrites = false;
  const acceptedSecretValues: unknown[] = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? "";
    const path = request.url ?? "";
    requests.push({ method, path });
    beforeResponse?.(method, path);
    if (acceptSecretWrites && method === "PATCH" && path === modelSecretPath) {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      acceptedSecretValues.push(JSON.parse(body).value);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: state.secret }));
      return;
    }
    const data =
      method === "GET"
        ? path === agentPath
          ? state.agent
          : path === modelSecretPath
            ? state.secret
            : path === `${namespacePath}/configurations/${configurationId}`
              ? state.configuration
              : undefined
        : undefined;
    response.writeHead(data ? 200 : 500, { "content-type": "application/json" });
    response.end(JSON.stringify(data ? { data } : { error: { message: "unexpected API effect" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    fixturePath,
    JSON.stringify({
      allowAgentLifecycleMutation: true,
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      apiKeyFile: operatorKey,
      kubeconfig: join(directory, "unused-kubeconfig"),
      namespaceId,
      namespaceName: "qa-tenant",
      agentId,
      modelSecretId,
      model: "test-model",
      runtimeImage: `runtime@sha256:${"a".repeat(64)}`,
    }),
  );
  const variants: Array<{
    name: string;
    change: (value: ReturnType<typeof fixtureState>) => void;
    expected: RegExp;
  }> = [
    {
      name: "wrong Secret ID",
      change: (value) => {
        value.agent.harnessAuth.source.id = "sec_99999999";
      },
      expected: /exact API-key binding/u,
    },
    {
      name: "wrong auth method",
      change: (value) => {
        value.agent.harnessAuth.method = "codex_pat";
      },
      expected: /exact API-key binding/u,
    },
    {
      name: "cross-Namespace binding",
      change: (value) => {
        value.agent.harnessAuth.source.namespaceId = "ns_99999999";
      },
      expected: /exact API-key binding/u,
    },
    {
      name: "another Agent consumer",
      change: (value) => {
        value.secret.consumers.agents.push("agt_99999999");
      },
      expected: /non-test Agent consumers/u,
    },
    {
      name: "detached Agent",
      change: (value) => {
        value.secret.consumers.agents = [];
      },
      expected: /Secret must name this Agent/u,
    },
    {
      name: "unreadable consumer",
      change: (value) => {
        value.secret.consumers.unreadable = 1;
      },
      expected: /all be readable/u,
    },
    {
      name: "truncated consumers",
      change: (value) => {
        value.secret.consumers.truncated = true;
      },
      expected: /inventory must be complete/u,
    },
    ...(["configurations", "credentialSources", "provisioningRequests"] as const).map((kind) => ({
      name: `${kind} consumer`,
      change: (value: ReturnType<typeof fixtureState>) => {
        value.secret.consumers[kind].push("foreign-resource");
      },
      expected: new RegExp(`no ${kind} consumers`, "u"),
    })),
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      state = fixtureState();
      variant.change(state);
      requests.length = 0;
      const error = await verifyQaStrandsSandbox(directory).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      assert.ok(error, "invalid fixture must be refused");
      assert.ok(requests.length > 0, "the real helper must reach the recording API");
      assert.deepEqual(
        requests.filter(({ method }) => method !== "GET"),
        [],
        "preflight refusal must not stop an Agent, alter a Secret or write a Configuration",
      );
      assert.match(String(error), variant.expected);
    });
  }
  for (const variant of [
    {
      name: "Agent authentication rebind",
      at: agentPath,
      change() {
        state.agent.harnessAuth.source.id = "sec_99999999";
      },
    },
    {
      name: "Agent starts running",
      at: agentPath,
      change() {
        state.agent.desiredRuntimeState = "running";
      },
    },
    {
      name: "Agent Configuration rebind",
      at: agentPath,
      change() {
        state.agent.configurationId = "cfg_99999999";
      },
    },
    {
      name: "Configuration generation update",
      at: `${namespacePath}/configurations/${configurationId}`,
      change() {
        state.configuration.generation++;
      },
    },
    {
      name: "consumer detach",
      at: modelSecretPath,
      change() {
        state.secret.consumers.agents = [];
      },
    },
    {
      name: "foreign consumer attachment",
      at: modelSecretPath,
      change() {
        state.secret.consumers.agents.push("agt_99999999");
      },
    },
  ]) {
    await t.test(`installation refuses ${variant.name} after good preflight`, async () => {
      state = fixtureState();
      requests.length = 0;
      beforeResponse = (method, path) => {
        if (
          method === "GET" &&
          path === variant.at &&
          requests.filter((entry) => entry.method === "GET" && entry.path === path).length === 2
        ) {
          variant.change();
        }
      };
      await assert.rejects(verifyQaStrandsSandbox(directory), /Strands sandbox acceptance failed/u);
      assert.deepEqual(
        requests.filter(({ method }) => method !== "GET"),
        [],
        "a changed installation boundary must refuse before any model-key or lifecycle mutation",
      );
      beforeResponse = undefined;
    });
  }
  await t.test(
    "withdrawal still scrubs an installed key after legitimate consumer detach",
    async () => {
      state = fixtureState();
      requests.length = 0;
      acceptSecretWrites = true;
      beforeResponse = (method, path) => {
        if (method === "PATCH" && path === modelSecretPath) {
          state.secret.consumers.agents = [];
        }
      };
      await assert.rejects(verifyQaStrandsSandbox(directory), /Strands sandbox acceptance failed/u);
      assert.equal(
        requests.filter(({ method, path }) => method === "PATCH" && path === modelSecretPath)
          .length,
        2,
        "the successful installation and withdrawal reach an otherwise exclusive Secret",
      );
      assert.deepEqual(acceptedSecretValues, [
        "synthetic-model-key",
        "synthetic-invalid-key-for-credential-free-startup",
      ]);
      beforeResponse = undefined;
      acceptSecretWrites = false;
    },
  );
  await t.test("a valid exclusive binding reaches the requested Secret write", async () => {
    state = fixtureState();
    requests.length = 0;
    await assert.rejects(verifyQaStrandsSandbox(directory), /Strands sandbox acceptance failed/u);
    assert.deepEqual(
      requests.find(({ method }) => method !== "GET"),
      {
        method: "PATCH",
        path: modelSecretPath,
      },
    );
  });
});

test("semantic QA owns its Configuration and restores one bounded file across failures", async (t) => {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const fixturePath = "/home/node/workspace/memory/oce-qa-semantic.md";
  for (const variant of [
    "repeated",
    "new file",
    "lost binding reply",
    "lost restore reply",
    "failed semantic startup",
    "concurrent binding",
    "concurrent original",
    "concurrent clone",
    "concurrent file",
  ]) {
    await t.test(variant, async () => {
      const state = fixtureState();
      const original = structuredClone(state.configuration);
      let binding = configurationId;
      let running = true;
      let semanticStartupFailed = false;
      let cloneGeneration = 1;
      const cloneId = "cfg_55555555";
      const bytes = Buffer.from("existing workspace bytes\n");
      const files = new Map<string, Buffer>(variant === "new file" ? [] : [[fixturePath, bytes]]);
      const snapshots = new Map<string, Buffer>();
      const mutations: Array<{ method: string; path: string }> = [];
      const stops: string[] = [];
      const result: { semanticMemory?: Record<string, unknown> } = {};
      let creationCount = 0;
      const f = {
        fixture: { namespaceId, agentId },
        base: agentPath,
        sessionKey: "agent:main:synthetic-test",
        nonce: "synthetic-nonce",
        result,
        async api(
          method: string,
          path: string,
          body?: { configurationId?: string; values?: unknown },
        ) {
          if (method !== "GET") {
            mutations.push({ method, path });
          }
          if (method === "GET" && path === agentPath) {
            return {
              ...state.agent,
              configurationId: binding,
              desiredRuntimeState: running ? "running" : "stopped",
            };
          }
          if (method === "GET" && path === `${namespacePath}/configurations/${configurationId}`) {
            return structuredClone(state.configuration);
          }
          if (method === "POST" && path === `${namespacePath}/configurations`) {
            creationCount++;
            assert.notDeepEqual(
              body?.values,
              original.values,
              "semantic settings belong only to the clone",
            );
            return { ...original, id: cloneId, generation: cloneGeneration, values: body?.values };
          }
          if (method === "PATCH" && path === agentPath) {
            assert.equal(running, false, "only a stopped test Agent may be rebound");
            assert.equal(typeof body?.configurationId, "string");
            binding = body!.configurationId!;
            if (variant === "lost binding reply" && binding === cloneId) {
              throw new Error("lost binding response after commit");
            }
            if (variant === "lost restore reply" && binding === configurationId) {
              throw new Error("lost restore response after commit");
            }
            return { ...state.agent, configurationId: binding };
          }
          if (method === "GET" && path === `${namespacePath}/configurations/${cloneId}`) {
            return { ...original, id: cloneId, generation: cloneGeneration };
          }
          if (method === "DELETE" && path === `${namespacePath}/configurations/${cloneId}`) {
            assert.notEqual(binding, cloneId, "a referenced clone must not be deleted");
            return;
          }
          throw new Error(`unexpected API call ${method} ${path}`);
        },
        async gateway(method: string, params: Record<string, unknown> = {}) {
          assert.equal(running, true, "Gateway and node access require a running Agent");
          if (method === "node.list" && semanticStartupFailed && binding === cloneId) {
            throw new Error("node discovery unavailable during failed semantic startup");
          }
          if (method === "node.list") {
            return {
              nodes: [{ nodeId: "node-fixture", connected: true, commands: ["file.write"] }],
            };
          }
          if (method === "memory.search") {
            return { searchMode: "fts-only", results: [] };
          }
          if (method === "memory.index") {
            assert.equal(binding, configurationId);
            return { status: { provider: "none" } };
          }
          assert.equal(method, "tools.invoke");
          const args = params.args as {
            path?: string;
            contentBase64?: string;
            sourceMediaId?: string;
          };
          if (params.name === "dir_list") {
            return {
              ok: true,
              output: {
                details: {
                  entries: files.has(fixturePath) ? [{ name: "oce-qa-semantic.md" }] : [],
                  truncated: false,
                },
              },
            };
          }
          if (params.name === "file_fetch") {
            assert.equal(args.path, fixturePath);
            const value = files.get(fixturePath);
            assert.ok(value);
            const mediaId = `snapshot-${snapshots.size}`;
            snapshots.set(mediaId, Buffer.from(value));
            return {
              ok: true,
              output: { details: { mediaId, sha256: sha(value), size: value.length } },
            };
          }
          if (params.name === "file_write") {
            assert.equal(args.path, fixturePath);
            const value = args.sourceMediaId
              ? snapshots.get(args.sourceMediaId)
              : Buffer.from(args.contentBase64 ?? "", "base64");
            assert.ok(value, "restore must use an actual fetched media snapshot");
            files.set(fixturePath, Buffer.from(value));
            return { ok: true };
          }
          assert.equal(params.name, "memory_search");
          return { ok: true, output: { path: "memory/oce-qa-semantic.md" } };
        },
        async check(name: string, action: () => Promise<unknown>) {
          if (name === "read-only Gateway authority cannot rebuild the memory index") {
            if (variant === "concurrent binding") {
              binding = "cfg_foreign";
            }
            if (variant === "concurrent original") {
              state.configuration.generation++;
            }
            if (variant === "concurrent clone") {
              cloneGeneration++;
            }
            if (variant === "concurrent file") {
              files.set(fixturePath, Buffer.from("concurrent edit"));
            }
            throw new Error("stop after semantic setup");
          }
          return action();
        },
        async wait(_name: string, action: () => Promise<unknown>) {
          return action();
        },
        async stop(expected: string) {
          assert.equal(binding, expected);
          stops.push(expected);
          running = false;
        },
        async deploy(expected: string) {
          assert.equal(binding, expected);
          running = true;
          if (variant === "failed semantic startup" && expected === cloneId) {
            semanticStartupFailed = true;
            throw new Error("semantic startup failed before Gateway readiness");
          }
          return { id: "revision-fixture" };
        },
      };
      const attempts = variant === "repeated" ? 2 : 1;
      for (let i = 0; i < attempts; i++) {
        const failure = await verifyStrandsSemanticMemory(f).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof AggregateError);
        assert.match(failure.message, /Semantic memory qualification failed/u);
        if (variant === "failed semantic startup") {
          assert.ok(
            failure.errors.some((error: unknown) =>
              String(error).includes("node discovery unavailable"),
            ),
            "successful fallback must retain the initial restoration failure",
          );
        }
      }
      assert.equal(creationCount, attempts, "each attempt owns a fresh Configuration");
      assert.deepEqual(
        mutations.filter((entry) => entry.method === "PATCH" && entry.path !== agentPath),
        [],
        "neither the original nor clone Configuration document is overwritten",
      );
      assert.deepEqual(state.configuration.values, original.values);
      if (variant === "concurrent binding") {
        assert.equal(binding, "cfg_foreign");
        assert.deepEqual(
          stops,
          [configurationId],
          "cleanup must not stop or replace a concurrent binding",
        );
        assert.ok(!mutations.some((entry) => entry.method === "DELETE"));
      } else if (variant === "concurrent original") {
        assert.equal(binding, configurationId);
        assert.equal(running, false, "do not deploy a concurrently updated original generation");
        assert.equal(state.configuration.generation, original.generation + 1);
        assert.deepEqual(
          files.get(fixturePath),
          bytes,
          "restore prior file bytes before stopping the clone and refusing changed original startup",
        );
      } else {
        assert.equal(binding, configurationId);
        assert.equal(running, true);
        if (variant === "concurrent clone") {
          assert.ok(!mutations.some((entry) => entry.method === "DELETE"));
        } else {
          assert.equal(mutations.filter((entry) => entry.method === "DELETE").length, attempts);
        }
        if (variant === "concurrent file") {
          assert.equal(files.get(fixturePath)?.toString(), "concurrent edit");
        } else {
          assert.deepEqual(
            files.get(fixturePath),
            variant === "new file" ? Buffer.alloc(0) : bytes,
          );
        }
      }
      assert.equal(files.size, 1, "reruns cannot accumulate semantic fixtures");
    });
  }
});

test("the second QA Agent receives its own Configuration and is an explicit temporary Secret consumer", async (t) => {
  for (const lostReply of [false, true]) {
    await t.test(lostReply ? "lost create reply" : "later setup failure", async () => {
      const state = fixtureState();
      const secondId = "agt_66666666";
      const cloneId = "cfg_77777777";
      const calls: Array<{ method: string; path: string; body?: unknown }> = [];
      const consumerScopes: string[][] = [];
      const result: { secondAgent?: { id?: string } } = {};
      let secondPresent = false;
      let secondName = "";
      // Exercise the actual second-Agent setup/cleanup owner. Earlier native
      // workspace checks have separate runtime proof and are outside this case.
      await assert.rejects(
        verifyStrandsWorkspaceWorkflows({
          fixture: { namespaceId, agentId, modelSecretId },
          base: agentPath,
          nonce: "synthetic-nonce",
          memoryFact: "synthetic-memory",
          result,
          async check(name: string, action: () => Promise<unknown>) {
            if (
              name === "second Agent initial workspace and independent storage" ||
              name === "deleting second Agent removes its resources and preserves first Agent" ||
              name === "remove the second Agent's test-owned Configuration"
            ) {
              return action();
            }
          },
          async assertModelSecretConsumers(ids = [agentId]) {
            consumerScopes.push(ids);
          },
          async api(
            method: string,
            path: string,
            body?: { configurationId?: string; name?: string },
          ) {
            calls.push({ method, path, body });
            if (method === "GET" && path === agentPath) {
              return { ...state.agent, desiredRuntimeState: "running" };
            }
            if (method === "GET" && path === `${namespacePath}/configurations/${configurationId}`) {
              return structuredClone(state.configuration);
            }
            if (method === "POST" && path === `${namespacePath}/configurations`) {
              return { ...state.configuration, id: cloneId, generation: 1 };
            }
            if (method === "POST" && path === `${namespacePath}/agents`) {
              assert.equal(body?.configurationId, cloneId);
              secondPresent = true;
              secondName = body?.name ?? "";
              if (lostReply) {
                throw new Error("lost create reply after commit");
              }
              return { ...state.agent, id: secondId, configurationId: cloneId };
            }
            if (method === "POST" && path === `${namespacePath}/iam/roles`) {
              throw new Error("stop after second-Agent ownership checks");
            }
            if (method === "DELETE" && path === `${namespacePath}/agents/${secondId}`) {
              secondPresent = false;
              return;
            }
            if (method === "GET" && path === `${namespacePath}/agents`) {
              return secondPresent
                ? [{ ...state.agent, id: secondId, name: secondName, configurationId: cloneId }]
                : [];
            }
            if (method === "GET" && path === `${namespacePath}/configurations/${cloneId}`) {
              return { ...state.configuration, id: cloneId, generation: 1 };
            }
            if (method === "DELETE" && path === `${namespacePath}/configurations/${cloneId}`) {
              return;
            }
            throw new Error(`unexpected API call ${method} ${path}`);
          },
          async objects() {
            return [];
          },
          owned() {
            return [];
          },
          async wait(_name: string, action: () => Promise<unknown>) {
            return action();
          },
          async gateway(method: string) {
            assert.equal(method, "memory.search");
            return { results: [{ snippet: "synthetic-memory" }] };
          },
        }),
        /Second Agent qualification failed/u,
      );
      assert.deepEqual(consumerScopes, lostReply ? [[agentId]] : [[agentId], [agentId, secondId]]);
      assert.equal(
        result.secondAgent?.id,
        secondId,
        "lost replies retain the exact owned consumer identity",
      );
      assert.deepEqual(
        calls.filter(({ method }) => method === "DELETE").map(({ path }) => path),
        [`${namespacePath}/agents/${secondId}`, `${namespacePath}/configurations/${cloneId}`],
      );
      assert.ok(
        !calls.some(({ method, path }) => method === "PATCH" && path.includes("/configurations/")),
      );
    });
  }
});
