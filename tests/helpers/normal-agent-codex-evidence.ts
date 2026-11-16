import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nativePolicyRequirementsSummary } from "./normal-agent-native-diagnostics.ts";
import {
  matchingOperations,
  observationFields,
  standaloneArguments,
} from "./normal-agent-repository-command.ts";

type ObserverSocket = {
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(event: "open" | "error" | "close", listener: () => void): void;
  send(text: string): void;
  close(): void;
};

type ObservedCommand = {
  id: unknown;
  operations: unknown[];
  status: unknown;
  exitCode: unknown;
  http400: boolean;
  pushRefRefused: boolean;
  sandboxDenied: boolean;
  failureCategories: string[];
  commitShas: string[];
  pullUrls: string[];
};

type ObservedTurn = {
  threadId: unknown;
  turnId: unknown;
  status: unknown;
  cwdMatchesExpectedWorkspace: boolean;
  rolloutPath: unknown;
  commands: ObservedCommand[];
};

type PluginRuntimeStatus = {
  readRuntime(): unknown;
  hasEnabledSelections(runtime: unknown): boolean;
  readStatus(): Promise<unknown>;
  deriveToken(startupId: string): string;
};

async function appServerToken(dependencies: PluginRuntimeStatus) {
  // Plugin-enabled peers rotate their token per startup. The production status
  // reader verifies that it belongs to the selected peer.
  const runtime = dependencies.readRuntime();
  const manifest = observationFields(observationFields(runtime)?.manifest);
  if (manifest?.kind === "codex" && dependencies.hasEnabledSelections(runtime)) {
    const status = observationFields(await dependencies.readStatus());
    if (typeof status?.startupId !== "string") {
      throw new Error("missing native startup ID");
    }
    process.env.APP_SERVER_TOKEN = dependencies.deriveToken(status.startupId);
  }
  return process.env.APP_SERVER_TOKEN;
}

function openObserverSocket(token: string | undefined) {
  // The serialized probe runs inside the Gateway, which provides ws.
  /* eslint-disable @typescript-eslint/no-require-imports -- Gateway node -e uses CommonJS. */
  const WebSocket = require("ws") as new (
    address: string | undefined,
    options: { headers: { Authorization: string } },
  ) => ObserverSocket;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return new WebSocket(process.env.APP_SERVER_URL, {
    headers: { Authorization: "Bearer " + token },
  });
}

function nativeInventory(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid native inventory");
  }
  return value;
}

// This authenticated, read-only observer never starts or replays a model turn.
function observeRepositoryTurn(connectObserver: () => Promise<ObserverSocket>) {
  const marker = process.argv[1];
  const argumentsText = process.argv[2];
  if (argumentsText === undefined) {
    throw new Error("missing repository command expectations");
  }
  const expected: unknown = JSON.parse(argumentsText);
  (async () => {
    const socket = await connectObserver();
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (reason: Error) => void }
    >();
    let nextId = 0;
    let stage = "connect";
    let finished = false;
    const finish = (value: object) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(deadline);
      try {
        socket.close();
      } catch {
        /* Always retain the fixed observer receipt. */
      }
      process.stdout.write(JSON.stringify(value), () => process.exit(0));
    };
    const unavailable = (reason: string, failure?: unknown) =>
      finish({
        status: "unavailable",
        observerStage: stage,
        observerReason: reason,
        ...(failure ? { failure } : {}),
        commands: [],
      });
    const deadline = setTimeout(() => unavailable("deadline"), 20000);
    const request = (method: string, params: object) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    socket.addEventListener("message", ({ data }) => {
      const raw: unknown = JSON.parse(String(data));
      const message = observationFields(raw);
      if (typeof message?.id !== "number") {
        return;
      }
      const operation = pending.get(message.id);
      if (!operation) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        operation.reject(new Error("native read failed"));
      } else {
        operation.resolve(message.result);
      }
    });
    socket.addEventListener("error", () => unavailable("connection"));
    socket.addEventListener("open", async () => {
      try {
        stage = "initialize";
        await request("initialize", {
          clientInfo: { name: "repository-acceptance-observer", version: "1.0.0" },
        });
        socket.send(JSON.stringify({ method: "initialized" }));
        stage = "thread-list";
        const listed = observationFields(
          await request("thread/list", { limit: 20, modelProviders: [] }),
        );
        if (!listed) {
          throw new Error("missing native thread inventory");
        }
        if (listed.nextCursor !== null) {
          return unavailable("inventory-limit");
        }
        const matches: ObservedTurn[] = [];
        for (const row of nativeInventory(listed.data)) {
          const candidate = observationFields(row);
          stage = "thread-read";
          const read = observationFields(
            await request("thread/read", { threadId: candidate?.id, includeTurns: true }),
          );
          const thread = observationFields(read?.thread);
          if (!thread) {
            throw new Error("missing native thread");
          }
          for (const row of nativeInventory(thread.turns)) {
            const turn = observationFields(row);
            if (!turn) {
              throw new Error("invalid native turn");
            }
            const items = nativeInventory(turn.items).map(observationFields);
            if (
              !items.some(
                (item) =>
                  item?.type === "userMessage" &&
                  nativeInventory(item.content)
                    .map(observationFields)
                    .some(
                      (block) =>
                        block?.type === "text" &&
                        typeof block.text === "string" &&
                        block.text.includes(String(marker)),
                    ),
              )
            ) {
              continue;
            }
            const commands = items.flatMap((item) => {
              if (item?.type !== "commandExecution") {
                return [];
              }
              // Codex reports the actual shell argv as a quoted command. Accept
              // only its single non-login shell wrapper around one literal command.
              let args = standaloneArguments(item.command);
              if (
                args?.length === 3 &&
                (args[0] === "/bin/bash" || args[0] === "/bin/sh" || args[0] === "/usr/bin/bash") &&
                args[1] === "-c"
              ) {
                args = standaloneArguments(args[2]);
              }
              const output =
                typeof item.aggregatedOutput === "string"
                  ? item.aggregatedOutput.slice(-262144)
                  : "";
              const lines = output.split(/\r?\n/).map((line) => line.trim());
              // Hints from bounded native output, never raw output or verified causes.
              const patterns: [string, RegExp][] = [
                ["dns", /could not resolve host|ENOTFOUND|EAI_AGAIN/i],
                ["connect-refused", /ECONNREFUSED|connection refused/i],
                ["connect-failed", /failed to connect|ENETUNREACH|EHOSTUNREACH/i],
                ["connect-timeout", /ETIMEDOUT|connection timed out|connection timeout/i],
                ["connect-reset", /ECONNRESET|connection reset/i],
                [
                  "tls",
                  /certificate verify failed|server certificate verification failed|SSL certificate problem|SSL_ERROR|unable to get local issuer|self.signed certificate|GnuTLS recv error|TLS connection.*terminated/i,
                ],
                [
                  "http-auth-rejected",
                  /returned error: (?:401|403)\b|HTTP\/[0-9.]+ (?:401|403)\b|HTTP (?:error |status )?(?:401|403)\b/i,
                ],
                [
                  "local-path",
                  /not a git repository|destination path.*already exists|no such file or directory|ENOENT/i,
                ],
                [
                  "filesystem-denied",
                  /EACCES|EPERM|EROFS|permission denied|read.only file system/i,
                ],
              ];
              const failureCategories = patterns
                .filter(([, pattern]) => pattern.test(output))
                .map(([category]) => category);
              return [
                {
                  id: item.id,
                  operations: matchingOperations(expected, item.cwd, args),
                  status: item.status,
                  exitCode: item.exitCode,
                  http400: /returned error: 400\b/i.test(String(item.aggregatedOutput ?? "")),
                  pushRefRefused: /repository-push-ref-not-allowed\b/.test(
                    String(item.aggregatedOutput ?? ""),
                  ),
                  sandboxDenied: /SANDBOX_DENIED:(?:EACCES|EPERM|EROFS)\b/.test(output),
                  failureCategories,
                  commitShas: lines.filter((line) => /^[a-f0-9]{40}$/.test(line)),
                  pullUrls: lines.filter((line) =>
                    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(
                      line,
                    ),
                  ),
                },
              ];
            });
            matches.push({
              threadId: thread.id,
              turnId: turn.id,
              status: turn.status,
              cwdMatchesExpectedWorkspace:
                thread.cwd ===
                (Array.isArray(expected)
                  ? observationFields((expected as unknown[])[0])?.workdir
                  : undefined),
              rolloutPath: thread.path,
              commands,
            });
          }
        }
        const [match] = matches;
        if (matches.length !== 1 || !match) {
          return unavailable(matches.length ? "ambiguous-owned-turn" : "no-owned-turn");
        }
        finish(match);
      } catch (error) {
        unavailable("native-read-failed", observationFields(error)?.diagnostic);
      }
    });
  })().catch(() => {
    process.stdout.write(
      JSON.stringify({
        status: "unavailable",
        observerStage: "startup",
        observerReason: "connection-or-runtime-unavailable",
        commands: [],
      }),
    );
  });
}

// One read on the deployed peer, independent of whether a model turn exists.
// TODO: Remove after the managed native-profile blocker is resolved.
function observeRepositoryRequirements(appServerToken: () => Promise<string | undefined>) {
  let socket: ObserverSocket | undefined;
  let stage = "runtime-status";
  let finished = false;
  const finish = (value: object) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(deadline);
    try {
      socket?.close();
    } catch {
      /* Keep the fixed receipt. */
    }
    process.stdout.write(
      JSON.stringify({ evidenceKind: "diagnostic-only", observerStage: stage, ...value }),
      () => process.exit(0),
    );
  };
  const deadline = setTimeout(
    () => finish({ available: false, reason: "observer-timeout" }),
    20000,
  );
  (async () => {
    const resolvedToken = await appServerToken();
    stage = "connect";
    const connection = openObserverSocket(resolvedToken);
    socket = connection;
    connection.addEventListener("error", () =>
      finish({ available: false, reason: "connection-unavailable" }),
    );
    connection.addEventListener("close", () =>
      finish({ available: false, reason: "connection-closed" }),
    );
    connection.addEventListener("open", () => {
      stage = "initialize";
      connection.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "repository-policy-observer", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          },
        }),
      );
    });
    connection.addEventListener("message", ({ data }) => {
      try {
        const raw: unknown = JSON.parse(String(data));
        const response = observationFields(raw);
        if (!response) {
          throw new Error("invalid native response");
        }
        if (
          (response.id === 1 && stage !== "initialize") ||
          (response.id === 2 && stage !== "requirements-read") ||
          (response.id !== 1 && response.id !== 2)
        ) {
          return;
        }
        if (response.error) {
          const codes: Record<string, string> = {
            "-32601": "method-not-found",
            "-32602": "invalid-params",
            "-32603": "internal-error",
            "-32000": "server-error",
          };
          const code = String(observationFields(response.error)?.code);
          return finish({
            available: false,
            reason: "native-rpc-refused",
            rpcCode: Object.hasOwn(codes, code) ? codes[code] : "other",
          });
        }
        if (response.id === 1) {
          connection.send(JSON.stringify({ method: "initialized" }));
          stage = "requirements-read";
          connection.send(JSON.stringify({ id: 2, method: "configRequirements/read" }));
        } else {
          finish(nativePolicyRequirementsSummary(response.result));
        }
      } catch {
        finish({ available: false, reason: "invalid-native-response" });
      }
    });
  })().catch(() => finish({ available: false, reason: "runtime-or-connection-unavailable" }));
}

// The production helper functions are injected as a group. Only the emitted
// JavaScript and process arguments are available inside the Gateway.
const appServerProgram = `
${PLUGIN_RUNTIME_HELPERS}
${observationFields}
${openObserverSocket}
const resolveAppServerToken = () => (${appServerToken})({
  readRuntime: readGatewayPluginRuntime,
  hasEnabledSelections: hasEnabledPluginSelections,
  readStatus: readPeerPluginRuntimeStatus,
  deriveToken: derivePluginAppServerToken,
});
`;

export const codexRepositoryEvidenceScript = `
${appServerProgram}
${nativeInventory}
${standaloneArguments}
${matchingOperations}
(${observeRepositoryTurn})(async () => openObserverSocket(await resolveAppServerToken()));
`;

export const codexRepositoryRequirementsScript = `
${appServerProgram}
${nativePolicyRequirementsSummary}
(${observeRepositoryRequirements})(resolveAppServerToken);
`;
