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
        child.kill("SIGTERM");
        if (error) {
          reject(error);
        } else {
          resolve(results);
        }
      };

      const sendNext = () => {
        const request = requests[next];
        child.stdin.write(JSON.stringify(request) + "\n");
      };

      const sendInitialized = () => {
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      };

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
          const error = asRecord(message.error);
          finish(
            new NotImplementedError(
              "codex-plugin-catalog-discovery",
              `Codex plugin catalog discovery failed during ${requests[next]?.method}: ${
                error?.message ?? "unknown error"
              }`,
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
