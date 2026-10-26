import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";

import { renderConsoleThemeShell, type ConsoleTheme } from "./console-theme.ts";

export interface ConsoleAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly statusCode: 200 | 404;
  /** Set when `body` is compressed for the request's Accept-Encoding. */
  readonly contentEncoding?: "br" | "gzip";
  /** Static script and style assets vary by Accept-Encoding; the HTML shell never does. */
  readonly variesByEncoding?: true;
}

interface EncodedAsset {
  readonly identity: Buffer;
  readonly br: Buffer;
  readonly gzip: Buffer;
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
// Compressed once per asset content: the files are static per build.
const encodedAssets = new Map<string, Promise<EncodedAsset>>();
const encodedThemes = new WeakMap<ConsoleTheme, Map<string, Promise<EncodedAsset>>>();

const CONSOLE_ROOT = new URL("./console/", import.meta.url);
const CONSOLE_SHELL = new URL("index.html", CONSOLE_ROOT);
const CONSOLE_ASSETS = new Map([
  ...Object.entries({
    "image/png": [
      "oce-mascot.png",
      "oce-mascot-inverse.png",
      "favicon-16.png",
      "favicon-32.png",
      "apple-touch-icon.png",
    ],
    "image/vnd.microsoft.icon": ["favicon.ico"],
    "text/javascript; charset=utf-8": [
      "api-client.mts",
      "configuration-fields.mts",
      "driver-configurations.mts",
      "view-lifetime.mts",
      "navigation.mts",
      "shell.mts",
      "namespaces.mts",
      "secrets.mts",
      "runtime-images.mts",
      "agents/list.mts",
      "agents/access-reasons.mts",
      "agents/collection.mts",
      "agents/lifecycle-confirmation.mts",
      "agents/logs.mts",
      "agents/sandbox-policy.mts",
      "agents/logs-view.mts",
      "agents/presets.mts",
      "agents/create.mts",
      "agents/provisioning-job.mts",
      "agents/plugin-discovery.mts",
      "agents/slack-directory.mts",
      "agents/slack-approvers.mts",
      "agents/plugin-fields.mts",
      "agents/plugins.mts",
      "agents/repositories.mts",
      "agents/repository-profiles.mts",
      "agents/starter-model.mjs",
      "agents/workspace.mts",
      "agents/access.mts",
      "agents/detail.mts",
      "agents/deployment-evidence.mts",
      "agents/deployment-diagnostics.mts",
      "agents/deployment-recovery.mts",
      "agents/deletion.mts",
      "agents/stop.mts",
      "agents/native-admin.mts",
      "agents/harness-auth.mts",
      "agents/device-login.mts",
      "agents/credential-access.mts",
      "agents/secret-picker.mts",
      "agents/credentials.mts",
      "channels/slack.mts",
      "channels/shared-ui.mts",
      "channels.mts",
      "agents.mjs",
      "carry.mts",
      "drafts.mts",
      "dom.mts",
      "console.mjs",
    ],
    "font/woff2": ["fonts/instrument-sans-latin.woff2"],
    "text/css; charset=utf-8": ["console.css", "channels.css"],
  }).flatMap(([contentType, paths]) =>
    paths.map((path) => {
      // Browser imports use JavaScript extensions. Source paths never come from the request.
      const url = `/console/${path.replace(/\.mts$/, ".mjs")}`;
      return [url, { path: new URL(path, CONSOLE_ROOT), contentType }] as const;
    }),
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
  // The Console reads Slack tokens with OCC's environment reference grammar.
  [
    "/console/environment-references.mjs",
    {
      path: new URL("../../../packages/occ/src/environment-references.ts", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  // The Console offers each failed deployment's next step from OCC's own table.
  [
    "/console/deployment-failure-steps.mjs",
    {
      path: new URL("../../../packages/occ/src/deployment-failure-steps.ts", import.meta.url),
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
  "/console/secrets",
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

/** The public files Storybook gets from the same reader as the controller. */
export function consoleAssetPaths(): Iterable<string> {
  return CONSOLE_ASSETS.keys();
}

const browserModules = new Map<string, { source: Buffer; javascript: Buffer }>();

// Node 24 erases types without moving source lines. Reuse that result until the file changes;
// the Console TypeScript project checks types and rejects syntax that would require a transform.
function browserJavaScript(pathname: string, source: Buffer): Buffer {
  const previous = browserModules.get(pathname);
  if (previous?.source.equals(source)) {
    return previous.javascript;
  }
  const javascript = Buffer.from(stripTypeScriptTypes(source.toString("utf8")));
  browserModules.set(pathname, { source, javascript });
  return javascript;
}

/**
 * Reads a console asset. Pass the request's Accept-Encoding to receive a brotli or gzip body for
 * static scripts and styles. Only these build-time files are compressed: they carry no secret or
 * request data, so compression cannot leak one (BREACH). The HTML shell, which also answers the
 * sign-in route, stays identity.
 */
export async function readConsoleAsset(
  pathname: string,
  acceptEncoding?: string,
  theme?: ConsoleTheme,
): Promise<ConsoleAsset> {
  if (pathname.startsWith("/console/theme/")) {
    const asset = theme?.assets.get(pathname);
    if (theme === undefined || asset === undefined) {
      return {
        body: Buffer.from("Theme asset not found.\n"),
        contentType: "text/plain; charset=utf-8",
        statusCode: 404,
      };
    }
    if (!asset.contentType.startsWith("text/")) {
      return { ...asset, statusCode: 200 };
    }
    let cache = encodedThemes.get(theme);
    if (cache === undefined) {
      cache = new Map();
      encodedThemes.set(theme, cache);
    }
    return encodedAsset(pathname, asset.body, asset.contentType, acceptEncoding, cache);
  }
  if (pathname === "/console/default-codex-preset.mjs") {
    const preset = JSON.parse(
      await readFile(
        new URL("../../../deploy/presets/default-codex.json", import.meta.url),
        "utf8",
      ),
    );
    return encodedAsset(
      pathname,
      Buffer.from(`export default ${JSON.stringify(preset)};\n`),
      "text/javascript; charset=utf-8",
      acceptEncoding,
    );
  }
  const asset = CONSOLE_ASSETS.get(pathname);
  if (asset !== undefined) {
    const source = await readFile(asset.path);
    if (!asset.contentType.startsWith("text/")) {
      return { body: source, contentType: asset.contentType, statusCode: 200 };
    }
    const body = /\.m?ts$/.test(asset.path.pathname) ? browserJavaScript(pathname, source) : source;
    return encodedAsset(pathname, body, asset.contentType, acceptEncoding);
  }
  const shell = await readFile(CONSOLE_SHELL);
  return {
    body:
      theme === undefined
        ? shell
        : Buffer.from(renderConsoleThemeShell(shell.toString("utf8"), theme)),
    contentType: "text/html; charset=utf-8",
    statusCode:
      CONSOLE_SHELL_ROUTES.has(pathname) ||
      /^\/console\/agents\/(new|agt_[a-f0-9-]+)$/.test(pathname)
        ? 200
        : 404,
  };
}

async function encodedAsset(
  pathname: string,
  body: Buffer,
  contentType: string,
  acceptEncoding: string | undefined,
  cache = encodedAssets,
): Promise<ConsoleAsset> {
  const identity = { body, contentType, statusCode: 200, variesByEncoding: true } as const;
  const encoding = preferredEncoding(acceptEncoding);
  if (encoding === undefined) {
    return identity;
  }
  // Look the entry up without awaiting first, so concurrent first requests share one compression.
  const existing = cache.get(pathname);
  let encoded = existing === undefined ? undefined : await existing.catch(() => undefined);
  if (encoded === undefined || !encoded.identity.equals(body)) {
    const pending = Promise.all([
      brotliAsync(body, {
        params: {
          [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
          // Quality 10 is within 3% of 11 at under half the one-time CPU.
          [zlib.BROTLI_PARAM_QUALITY]: 10,
          [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }),
      gzipAsync(body, { level: zlib.Z_BEST_COMPRESSION }),
    ]).then(([br, gzipped]) => ({ identity: body, br, gzip: gzipped }));
    cache.set(pathname, pending);
    // Never cache a failure: the next request compresses again.
    pending.catch(() => {
      if (cache.get(pathname) === pending) {
        cache.delete(pathname);
      }
    });
    encoded = await pending;
  }
  const compressed = encoded[encoding];
  return compressed.length < body.length
    ? { ...identity, body: compressed, contentEncoding: encoding }
    : identity;
}

/** The accepted coding with the highest q-value; brotli wins a tie. Unlisted codings fall to `*`. */
function preferredEncoding(acceptEncoding: string | undefined): "br" | "gzip" | undefined {
  if (acceptEncoding === undefined) {
    return undefined;
  }
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding.split(",")) {
    const [name = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const q = parameters.find((parameter) => parameter.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name, Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 1) : 0);
  }
  const weight = (name: string) => weights.get(name) ?? weights.get("*") ?? 0;
  const br = weight("br");
  const gzipWeight = weight("gzip");
  // Identity is an acceptable fallback by default; an explicit higher weight also makes it
  // the preferred representation. Keep the existing compression preference on a tie.
  if ((weights.get("identity") ?? 0) > Math.max(br, gzipWeight)) {
    return undefined;
  }
  if (br > 0 && br >= gzipWeight) {
    return "br";
  }
  return gzipWeight > 0 ? "gzip" : undefined;
}
