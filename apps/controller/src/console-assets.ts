import { readFile } from "node:fs/promises";

export interface ConsoleAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly statusCode: 200 | 404;
}

const CONSOLE_ROOT = new URL("./console/", import.meta.url);
const CONSOLE_SHELL = new URL("index.html", CONSOLE_ROOT);
const CONSOLE_ASSETS = new Map(
  Object.entries({
    "/console/api-client.mjs": {
      path: new URL("api-client.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/view-lifetime.mjs": {
      path: new URL("view-lifetime.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/navigation.mjs": {
      path: new URL("navigation.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/shell.mjs": {
      path: new URL("shell.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/list.mjs": {
      path: new URL("agents/list.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/create.mjs": {
      path: new URL("agents/create.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/starter-model.mjs": {
      path: new URL("agents/starter-model.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/workspace.mjs": {
      path: new URL("agents/workspace.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/detail.mjs": {
      path: new URL("agents/detail.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/native-admin.mjs": {
      path: new URL("agents/native-admin.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/harness-auth.mjs": {
      path: new URL("agents/harness-auth.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents/credentials.mjs": {
      path: new URL("agents/credentials.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/channels/slack.mjs": {
      path: new URL("channels/slack.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/channels/teams.mjs": {
      path: new URL("channels/teams.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/channels/shared-ui.mjs": {
      path: new URL("channels/shared-ui.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/console.css": {
      path: new URL("console.css", CONSOLE_ROOT),
      contentType: "text/css; charset=utf-8",
    },
    "/console/channels.css": {
      path: new URL("channels.css", CONSOLE_ROOT),
      contentType: "text/css; charset=utf-8",
    },
    "/console/channels.mjs": {
      path: new URL("channels.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents.mjs": {
      path: new URL("agents.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/dom.mjs": {
      path: new URL("dom.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/console.mjs": {
      path: new URL("console.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
  }),
);
const CONSOLE_SHELL_ROUTES = new Set([
  "/console",
  "/console/",
  "/console/login",
  "/console/agents",
  "/console/providers",
  "/console/namespaces",
  "/console/settings",
]);

export const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export async function readConsoleAsset(pathname: string): Promise<ConsoleAsset> {
  const asset = CONSOLE_ASSETS.get(pathname);
  if (asset !== undefined) {
    return {
      body: await readFile(asset.path),
      contentType: asset.contentType,
      statusCode: 200,
    };
  }
  return {
    body: await readFile(CONSOLE_SHELL),
    contentType: "text/html; charset=utf-8",
    statusCode:
      CONSOLE_SHELL_ROUTES.has(pathname) ||
      /^\/console\/agents\/(new|agt_[a-f0-9-]+)$/.test(pathname)
        ? 200
        : 404,
  };
}
