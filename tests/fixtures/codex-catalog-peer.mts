#!/usr/bin/env node
import { closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type CodexCatalogPeer =
  | {
      readonly scenario: "catalog";
      readonly accountType: "chatgpt" | "apiKey";
      readonly catalog: unknown;
    }
  | {
      readonly scenario:
        "closed-input" | "rpc-error" | "ignore-term" | "invalid-envelope" | "catalog-file";
    };

function writeResponse(id: number, result: unknown) {
  console.log(JSON.stringify({ id, result }));
}

function serveRequests(respond: (method: string, id: number) => void) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message: unknown = JSON.parse(line);
    if (
      typeof message !== "object" ||
      message === null ||
      !("method" in message) ||
      typeof message.method !== "string" ||
      message.method === "initialized" ||
      !("id" in message) ||
      typeof message.id !== "number"
    ) {
      return;
    }
    respond(message.method, message.id);
  });
}

const settings: unknown = JSON.parse(readFileSync(new URL("peer.json", import.meta.url), "utf8"));
if (typeof settings !== "object" || settings === null || !("scenario" in settings)) {
  throw new Error("Missing catalog peer scenario.");
}

switch (settings.scenario) {
  case "catalog": {
    if (!("accountType" in settings) || !("catalog" in settings)) {
      throw new Error("Missing catalog peer response.");
    }
    const { accountType, catalog } = settings;
    serveRequests((method, id) => {
      if (method === "initialize") {
        writeResponse(id, {});
      }
      if (method === "account/read") {
        writeResponse(id, {
          account: { type: accountType, email: "fixture@example.test", planType: "team" },
          requiresOpenaiAuth: true,
        });
      }
      if (method === "plugin/list") {
        writeResponse(id, catalog);
        process.exit(0);
      }
    });
    break;
  }
  case "closed-input":
    closeSync(0);
    process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    setTimeout(() => {}, 2_000);
    break;
  case "rpc-error": {
    const leaked = fileURLToPath(new URL("home/operator/.codex/auth.json", import.meta.url));
    serveRequests((method, id) => {
      if (method === "initialize") {
        writeResponse(id, {});
        return;
      }
      console.log(
        JSON.stringify({
          id,
          error: { code: -32603, message: `failed to read ${leaked}: permission denied` },
        }),
      );
    });
    break;
  }
  case "ignore-term":
    process.on("SIGTERM", () => {});
    writeFileSync(new URL("codex.pid.tmp", import.meta.url), String(process.pid));
    renameSync(new URL("codex.pid.tmp", import.meta.url), new URL("codex.pid", import.meta.url));
    process.stdin.resume();
    setInterval(() => {}, 1_000);
    break;
  case "invalid-envelope":
    process.stdin.once("data", () => process.stdout.write("null\n"));
    break;
  case "catalog-file":
    serveRequests((method, id) => {
      if (method === "account/read") {
        writeResponse(id, { account: { type: "chatgpt" } });
      } else if (method === "plugin/list") {
        const result: unknown = JSON.parse(
          readFileSync(new URL("plugin-list-result.json", import.meta.url), "utf8"),
        );
        writeResponse(id, result);
      } else {
        writeResponse(id, {});
      }
    });
    break;
  default:
    throw new Error("Unknown catalog peer scenario.");
}
