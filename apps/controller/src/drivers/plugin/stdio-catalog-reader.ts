import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

import type { PluginCatalogEntry } from "@openclaw-enterprise/contracts";
import { NotImplementedError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

import { codexCatalogEntries, type CodexPluginCatalogReader } from "./runtime-translator.ts";

type NativeCodexPluginCatalogReaderOptions = {
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly requestTimeoutMs?: number;
};

type JsonRpcRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// How long a Codex app-server gets to exit after SIGTERM before SIGKILL.
const CHILD_KILL_GRACE_MS = 1_000;

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NotImplementedError("codex-plugin-catalog-discovery", `${path} is required.`);
  }
  return value;
}

function requestTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60_000) {
    throw new NotImplementedError(
      "codex-plugin-catalog-discovery",
      "Codex plugin catalog requestTimeoutMs must be between 1 and 60000.",
    );
  }
  return value as number;
}

function ensureAuthenticated(accountResponse: unknown): void {
  const response = asRecord(accountResponse);
  const account = asRecord(response?.account);
  if (account === undefined) {
    throw new NotImplementedError(
      "codex-plugin-catalog-discovery",
      "Codex plugin catalog discovery requires an authenticated configured Codex home.",
    );
  }
  if (account.type !== "chatgpt") {
    throw new NotImplementedError(
      "codex-plugin-catalog-discovery",
      "Codex plugin catalog discovery requires a ChatGPT/Codex-backed account; API-key authentication cannot discover remote plugins.",
    );
  }
}

export class NativeCodexPluginCatalogReader implements CodexPluginCatalogReader {
  private readonly codexExecutable: string;
  private readonly codexHome: string;
  private readonly requestTimeoutMs: number;

  constructor(options: NativeCodexPluginCatalogReaderOptions) {
    this.codexExecutable = requiredString(options.codexExecutable, "codexExecutable");
    this.codexHome = requiredString(options.codexHome, "codexHome");
    this.requestTimeoutMs = requestTimeout(options.requestTimeoutMs);
  }

  async listCatalog(signal?: AbortSignal): Promise<readonly PluginCatalogEntry[]> {
    const [, account, plugins] = await this.requestSequence(
      [
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "openclaw-enterprise-plugin-catalog",
              title: "OpenClaw Enterprise Plugin Catalog",
              version: "1.0.0",
            },
            capabilities: { experimentalApi: true },
          },
        },
        { id: 2, method: "account/read", params: { refreshToken: false } },
        { id: 3, method: "plugin/list", params: {} },
      ],
      signal,
    );
    ensureAuthenticated(account);
    return codexCatalogEntries(plugins);
  }

  private async requestSequence(
    requests: readonly JsonRpcRequest[],
    signal: AbortSignal | undefined,
  ): Promise<readonly unknown[]> {
    if (signal?.aborted) {
      throw new NotImplementedError(
        "codex-plugin-catalog-discovery",
        "Codex plugin catalog discovery was aborted.",
      );
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(
        this.codexExecutable,
        ["-c", "features.plugins=true", "-c", "features.remote_plugin=true", "app-server"],
        {
          env: { ...process.env, CODEX_HOME: this.codexHome },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const results: unknown[] = [];
      let next = 0;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          new NotImplementedError(
            "codex-plugin-catalog-discovery",
            "Codex plugin catalog discovery timed out.",
          ),
        );
      }, this.requestTimeoutMs);
      const abort = () => {
        finish(
          new NotImplementedError(
            "codex-plugin-catalog-discovery",
            "Codex plugin catalog discovery was aborted.",
          ),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (child.exitCode === null && child.signalCode === null) {
          // A Codex that ignores SIGTERM would otherwise outlive the request and keep
          // this process's stdio pipes open.
          const kill = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
          kill.unref();
          child.once("exit", () => clearTimeout(kill));
          child.kill("SIGTERM");
        }
        if (error) {
          reject(error);
        } else {
          resolve(results);
        }
      };

      const write = (message: unknown) => {
        if (!settled) {
          child.stdin.write(JSON.stringify(message) + "\n");
        }
      };

      const sendNext = () => {
        write(requests[next]);
      };

      const sendInitialized = () => {
        write({ method: "initialized", params: {} });
      };

      // Codex can close its input or exit before reading a request (EPIPE). Without a
      // listener that write error is uncaught and ends this whole process.
      child.stdin.on("error", () => {
        finish(
          new NotImplementedError(
            "codex-plugin-catalog-discovery",
            "Codex plugin catalog discovery could not send its request to Codex.",
          ),
        );
      });

      createInterface({ input: child.stdout }).on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          finish(
            new NotImplementedError(
              "codex-plugin-catalog-discovery",
              "Codex plugin catalog discovery returned invalid JSON.",
            ),
          );
          return;
        }
        if (message.id !== requests[next]?.id) {
          return;
        }
        if (message.error !== undefined) {
          // The app-server's own message can name paths under the Codex home, and this
          // text becomes the 501 response body, so only our request method is named.
          // The reader has no logger to keep the detail server-side.
          finish(
            new NotImplementedError(
              "codex-plugin-catalog-discovery",
              `Codex plugin catalog discovery failed during ${requests[next]?.method}.`,
            ),
          );
          return;
        }
        results.push(message.result);
        if (requests[next]?.method === "initialize") {
          sendInitialized();
        }
        next += 1;
        if (next >= requests.length) {
          finish();
        } else {
          sendNext();
        }
      });

      child.stderr.resume();
      child.on("error", () => {
        finish(
          new NotImplementedError(
            "codex-plugin-catalog-discovery",
            "Codex plugin catalog discovery could not start the configured Codex executable.",
          ),
        );
      });
      child.on("exit", (code) => {
        if (settled) {
          return;
        }
        finish(
          new NotImplementedError(
            "codex-plugin-catalog-discovery",
            `Codex plugin catalog discovery exited before responding${
              code === null ? "" : ` with status ${code}`
            }.`,
          ),
        );
      });

      sendNext();
    });
  }
}
