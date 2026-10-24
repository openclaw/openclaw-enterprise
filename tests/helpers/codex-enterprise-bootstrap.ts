import assert from "node:assert/strict";
import { execFile, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createProxy } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  EgressRequest,
  EgressResponse,
  EgressRoute,
} from "../../packages/contracts/src/index.ts";
import { createCodexWorkspacePatProvider } from "../../apps/controller/src/drivers/egress-proxy/codex-workspace-provider.ts";
import {
  assertWorkspaceProviderUrl,
  createCodexStartup,
  login,
  probe,
} from "../fixtures/codex-native-startup.mjs";
import { caAndLeaf } from "./certificates.mjs";

const model = "fixture-model";
const workspace = "11111111-1111-4111-8111-111111111111";
const selectedToken = "synthetic-enterprise-selected-token";
const placeholder = "oce-protected-egress";
const ownPath = fileURLToPath(import.meta.url);
const paths = [
  "/api/accounts/v1/user-auth-credential/whoami",
  "/backend-api/wham/accounts/check",
  "/backend-api/codex/models",
  "/backend-api/wham/config/bundle",
  "/backend-api/codex/responses",
];

// The real public classifier and response custodian own delivery. These fixed
// synthetic bindings do not claim to test issuer admission or a deployed sender.
export function enterpriseCustodian() {
  const provider = createCodexWorkspacePatProvider({ workspaceForSource: () => workspace });
  const ref = { id: "fixture", generation: 1 };
  const binding: EgressRoute["binding"] = {
    binding: ref,
    execution: {
      installationId: "i",
      namespaceId: "n",
      agentId: "a",
      servicePrincipalId: "s",
      revisionId: "r",
      executionId: "e",
    },
    source: {
      installationId: "i",
      namespaceId: "n",
      source: ref,
      backend: ref,
      provider: provider.ref,
    },
    grant: {
      kind: "workspace_inference",
      workspaceId: workspace,
      models: [model],
      providerTools: "none",
    },
    grantHash: "fixture",
    isolationId: "fixture",
  };
  return (request: EgressRequest, response: EgressResponse) => {
    const url = new URL(request.url);
    if (!paths.includes(url.pathname)) {
      return undefined;
    }
    const route: EgressRoute = {
      route: ref,
      binding,
      origin: url.pathname === paths[0] ? "https://auth.openai.com" : "https://chatgpt.com",
      path: url.pathname,
      method: url.pathname === paths[4] ? "POST" : "GET",
      operationPolicy: ref,
      responsePolicy: ref,
      deadlineMs: 30000,
    };
    const operation = provider.classify(route, request);
    return operation && provider.protectResponse(response, selectedToken, request, operation);
  };
}

export function enterprisePolicy(incompatible: boolean, instruction: string) {
  return {
    config_toml: {
      enterprise_managed: [
        {
          id: "instruction",
          name: "Instruction",
          contents: `developer_instructions = ${JSON.stringify(instruction)}`,
        },
      ],
    },
    requirements_toml: {
      enterprise_managed: [
        {
          id: "restriction",
          name: "Restriction",
          contents: incompatible
            ? 'model_provider = "unconfigured-fixture-provider"'
            : 'allowed_sandbox_modes = ["read-only"]',
        },
      ],
    },
  };
}

async function nativeStartup(proxy: string, ca: string, challenge: string) {
  const cleanup: (() => void)[] = [];
  let nativeExit: number | null = null;
  let messages: string[] = [];
  let completed = 0;
  let childExecs = 0;
  const runtime = createCodexStartup(
    {
      after(fn: () => void) {
        cleanup.push(fn);
      },
    },
    {
      native: [login(), probe([])],
      providerPat: true,
      protectedInference: "signed",
      workspacePat: true,
      nativePath: process.env.PATH,
      model,
      nativeRunner(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
        for (const name of [
          "OPENAI_API_KEY",
          "CODEX_ACCESS_TOKEN",
          "APP_TOKEN_SHA",
          "APP_SERVER_TOKEN",
        ]) {
          assert.equal(Object.hasOwn(options.env ?? {}, name), false);
        }
        const home = options.env?.CODEX_HOME;
        assert.ok(home);
        assert.equal(statSync(home).mode & 0o777, 0o700);
        assert.equal(statSync(join(home, "auth.json")).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")), {
          personal_access_token: placeholder,
        });
        assert.ok(command.startsWith("/"), "native login and probe must bypass the npm launcher");
        if (args.includes("exec")) {
          assert.equal(runtime.marker(), undefined, "stale readiness removed at native exec");
          assertWorkspaceProviderUrl(args);
          childExecs++;
        }
        const result = spawnSync(command, args, {
          ...options,
          encoding: "utf8",
          env: {
            HOME: tmpdir(),
            CODEX_HOME: home,
            PATH: process.env.PATH,
            SSL_CERT_FILE: ca,
            CODEX_CA_CERTIFICATE: ca,
            HTTPS_PROXY: proxy,
            HTTP_PROXY: proxy,
            ALL_PROXY: proxy,
            NO_PROXY: "",
          },
        });
        assert.equal(result.error, undefined, result.stderr?.replaceAll(placeholder, "[marker]"));
        assert.equal(result.signal, null);
        if (args.includes("exec")) {
          nativeExit = result.status;
          const events = result.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          messages = events
            .filter((e) => e.type === "item.completed" && e.item?.type === "agent_message")
            .map((e) => e.item.text);
          completed = events.filter((e) => e.type === "turn.completed").length;
        } else {
          assert.equal(result.status, 0, "native login status");
        }
        return result;
      },
    },
  );
  try {
    assert.equal(runtime.marker(), "stale\n");
    runtime.start();
    await runtime.releaseProtectedExecution();
    runtime.assertNativeScriptConsumed();
    assert.equal(childExecs, 1);
    return {
      nativeExit,
      messages: messages.length,
      correlated: messages.length === 1 && messages[0] === challenge,
      completed,
      appStarts: runtime.appServerStarts,
      marker: runtime.marker() !== undefined,
      failure: runtime.status().runtimeFailure?.code ?? null,
    };
  } finally {
    for (const close of cleanup.reverse()) {
      close();
    }
  }
}

async function packagedBootstrap(incompatible: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "enterprise-bootstrap-"));
  const instruction = `Use concise answers. Policy ${randomUUID()}`;
  const challenge = `READY ${randomUUID()}`;
  const protect = enterpriseCustodian();
  let posts = 0;
  let modelRequests = 0;
  let bundles = 0;
  let typed = false;
  let firstError: unknown;
  const observations: { path: string; released: boolean }[] = [];
  const servers: ReturnType<typeof createProxy>[] = [];
  const sockets = new Set<Socket>();
  try {
    const version = await promisify(execFile)("codex", ["--version"]);
    assert.equal(version.stdout.trim(), "codex-cli 0.163.0-alpha.2");
    const cert = await caAndLeaf(directory, {
      caKeyPem: undefined,
      leafKeyPem: undefined,
      caName: "Enterprise fixture CA",
      commonName: "chatgpt.com",
      subjectAltName: "DNS:auth.openai.com,DNS:chatgpt.com",
    });
    const tls = { key: await readFile(cert.keyPath), cert: await readFile(cert.certPath) };
    const server = createServer(tls, (req, res) => {
      void (async () => {
        const body = await buffer(req);
        const host = req.headers.host;
        assert.ok(host === "auth.openai.com" || host === "chatgpt.com");
        const url = new URL(req.url ?? "/", `https://${host}`);
        if (!paths.includes(url.pathname)) {
          res.writeHead(403).end();
          return;
        }
        assert.equal(
          req.headers.authorization,
          `Bearer ${placeholder}`,
          `${req.method} ${url.pathname} requires the projected marker`,
        );
        const request: EgressRequest = {
          id: randomUUID(),
          url: url.href,
          method: req.method ?? "",
          headers: Object.entries({ ...req.headers, host }).flatMap(([k, v]): [string, string][] =>
            v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
          ),
          body,
          deadlineAt: new Date(Date.now() + 30000).toISOString(),
        };
        let value: unknown;
        if (url.pathname === paths[0]) {
          value = {
            chatgpt_user_id: "fixture-user",
            chatgpt_account_id: workspace,
            chatgpt_plan_type: "enterprise",
            chatgpt_account_is_fedramp: false,
          };
        } else if (url.pathname === paths[1]) {
          value = {
            accounts: [
              {
                id: workspace,
                name: "Fixture",
                plan_type: "enterprise",
                structure: "workspace",
                workspace_backend_origin: "https://chatgpt.com",
                account_routing_override: "NO_CONSTRAINT",
              },
            ],
            account_ordering: [workspace],
            default_account_id: workspace,
          };
        } else if (url.pathname === paths[2]) {
          value = {
            models: [
              {
                slug: model,
                base_instructions: "",
                display_name: "Fixture",
                description: "Fixture",
                supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
                default_reasoning_level: "medium",
                shell_type: "unified_exec",
                visibility: "list",
                supported_in_api: true,
                priority: 1,
                support_verbosity: true,
                truncation_policy: { mode: "tokens", limit: 10000 },
                experimental_supported_tools: [],
                context_window: 128000,
              },
            ],
          };
        } else if (url.pathname === paths[3]) {
          bundles++;
          value = enterprisePolicy(incompatible, instruction);
        }
        let response: EgressResponse = {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: Buffer.from(JSON.stringify(value ?? {})),
          trailers: [],
        };
        if (url.pathname === paths[4]) {
          modelRequests++;
          const parsed = JSON.parse(body.toString());
          assert.equal(parsed.model, model);
          assert.equal(
            parsed.input.at(-1).content.at(-1).text,
            "Reply only READY. Do not use tools.",
          );
          typed = parsed.input.some(
            (item: {
              role: string;
              content?: { text?: string }[];
              internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] };
            }) =>
              item.role === "developer" &&
              item.content?.some(
                (part, i) =>
                  part.text === instruction &&
                  item.internal_chat_message_metadata_passthrough?.content_item_kinds?.[i] ===
                    "generic.developer_instructions",
              ),
          );
          assert.equal(typed, true);
          assert.equal(
            JSON.parse(parsed.client_metadata["x-codex-turn-metadata"]).sandbox_mode,
            "read-only",
          );
          const id = randomUUID();
          const item = {
            id: randomUUID(),
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: challenge, annotations: [] }],
          };
          const part = item.content[0]!;
          const events = [
            {
              type: "response.created",
              response: { id, model, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            },
            {
              type: "response.content_part.added",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              part: { ...part, text: "" },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              delta: challenge,
            },
            {
              type: "response.output_text.done",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              text: challenge,
            },
            {
              type: "response.content_part.done",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              part,
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id,
                model,
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ];
          response = {
            status: 200,
            headers: [["content-type", "text/event-stream"]],
            body: Buffer.from(
              events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
            ),
            trailers: [],
          };
        }
        const safe = protect(request, response);
        observations.push({ path: url.pathname, released: Boolean(safe) });
        if (!safe) {
          res.writeHead(403).end();
          return;
        }
        if (url.pathname === paths[4]) {
          posts++;
        }
        res.writeHead(safe.status, Object.fromEntries(safe.headers)).end(safe.body);
      })().catch((error) => {
        firstError ??= error;
        res.writeHead(500).end();
      });
    });
    const proxy = createProxy((_req, res) => res.writeHead(403).end());
    servers.push(proxy);
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (req, socket, head) => {
      if (!["auth.openai.com:443", "chatgpt.com:443"].includes(req.url ?? "") || head.length) {
        socket.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      server.emit("connection", socket);
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [ownPath, "child", `http://127.0.0.1:${address.port}`, cert.caPath, challenge],
      { timeout: 70000, maxBuffer: 1024 * 1024 },
    ).catch((error) => {
      if (firstError) {
        throw firstError;
      }
      throw new Error(`Native startup failed; routes: ${JSON.stringify(observations)}`, {
        cause: error,
      });
    });
    if (firstError) {
      throw firstError;
    }
    const result = JSON.parse(stdout);
    assert.equal(bundles, 1, JSON.stringify({ observations, result, modelRequests }));
    assert.equal(modelRequests, incompatible ? 0 : 1);
    if (incompatible) {
      assert.notEqual(result.nativeExit, 0);
      assert.equal(posts, 0);
      assert.equal(result.messages, 0);
      assert.equal(result.appStarts, 0);
      assert.equal(result.marker, false);
      assert.equal(result.failure, "MODEL_PROBE_FAILED");
    } else {
      assert.equal(posts, 1, JSON.stringify({ observations, result, typed }));
      assert.equal(typed, true);
      assert.deepEqual(result, {
        nativeExit: 0,
        messages: 1,
        correlated: true,
        completed: 1,
        appStarts: 1,
        marker: true,
        failure: null,
      });
    }
    console.log(JSON.stringify({ incompatible, posts, modelRequests, bundles, ...result }));
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === ownPath) {
  if (process.argv[2] === "child") {
    const [proxy, ca, challenge] = process.argv.slice(3);
    assert.ok(proxy && ca && challenge);
    console.log(JSON.stringify(await nativeStartup(proxy, ca, challenge)));
  } else {
    await packagedBootstrap(process.argv[2] === "incompatible");
  }
}
