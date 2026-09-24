import { readFile } from "node:fs/promises";

export interface ConsoleAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly statusCode: 200 | 404;
}

const CONSOLE_ROOT = new URL("./console/", import.meta.url);
const CONSOLE_SHELL = new URL("index.html", CONSOLE_ROOT);
const CONSOLE_ASSETS = new Map([
  ...Object.entries({
    "image/png": ["oce-mascot.png", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png"],
    "image/vnd.microsoft.icon": ["favicon.ico"],
    "text/javascript; charset=utf-8": [
      "api-client.mjs",
      "view-lifetime.mjs",
      "navigation.mjs",
      "shell.mjs",
      "runtime-images.mjs",
      "agents/list.mjs",
      "agents/presets.mjs",
      "agents/create.mjs",
      "agents/plugin-fields.mjs",
      "agents/repositories.mjs",
      "agents/repository-profiles.mjs",
      "agents/starter-model.mjs",
      "agents/workspace.mjs",
      "agents/detail.mjs",
      "agents/deletion.mjs",
      "agents/stop.mjs",
      "agents/native-admin.mjs",
      "agents/harness-auth.mjs",
      "agents/secret-access.mjs",
      "agents/credentials.mjs",
      "channels/slack.mjs",
      "channels/shared-ui.mjs",
      "channels.mjs",
      "agents.mjs",
      "dom.mjs",
      "console.mjs",
    ],
    "font/woff2": ["fonts/instrument-sans-latin.woff2"],
    "text/css; charset=utf-8": ["console.css", "channels.css"],
  }).flatMap(([contentType, paths]) =>
    paths.map(
      (path) => [`/console/${path}`, { path: new URL(path, CONSOLE_ROOT), contentType }] as const,
    ),
  ),
  [
    "/console/workspace-defaults.mjs",
    {
      path: new URL("../../../packages/contracts/src/workspace-defaults.mjs", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/console/preset-variables.mjs",
    {
      path: new URL("../../../packages/contracts/src/preset-variables.mjs", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
]);
const CONSOLE_SHELL_ROUTES = new Set([
  "/console",
  "/console/",
  "/console/login",
  "/console/agents",
  "/console/backends",
  "/console/namespaces",
  "/console/settings",
]);

export const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Catalog Drivers can supply public HTTPS images from plugin publishers.
  "img-src 'self' https:",
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
