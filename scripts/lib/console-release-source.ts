import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  renderConsoleThemeShell,
  type ConsoleTheme,
} from "../../apps/controller/src/console-theme.ts";
import { stampConsoleBuildRevision } from "../build-console-metadata.mjs";

export const ASSET_PATH = "/console/console.css";
export const MAX_HTML_BYTES = 256 * 1024;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const SOURCE_PATH = "apps/controller/src/console/";
const execute = promisify(execFile);
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface ReadBudget {
  signal: AbortSignal;
  timeout: number;
}

async function git(
  source: string,
  args: string[],
  limit: number,
  budget: ReadBudget,
): Promise<Buffer> {
  const { stdout } = await execute(
    "git",
    ["--no-lazy-fetch", "--no-replace-objects", "-C", source, ...args],
    {
      encoding: "buffer",
      maxBuffer: limit,
      ...budget,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  return stdout;
}

function appearsOnce(html: string, value: string): boolean {
  const position = html.indexOf(value);
  return position >= 0 && html.indexOf(value, position + value.length) < 0;
}

function section(html: string, opening: string, closing: string): string | undefined {
  const start = html.indexOf(opening);
  if (start < 0) {
    return undefined;
  }
  const end = html.indexOf(closing, start + opening.length);
  return end < 0 ? undefined : html.slice(start, end);
}

function stampReleaseShell(source: Buffer, revision: string): string | undefined {
  const html = utf8.decode(source);
  const head = section(html, "<head>", "</head>") ?? "";
  const marker = /<meta name="occ-build-revision" content="([^"]*)" \/>/.exec(head);
  if (
    !marker ||
    (marker[1] !== "" && marker[1] !== revision) ||
    !appearsOnce(html, "occ-build-revision") ||
    !appearsOnce(html, ASSET_PATH) ||
    !head.includes(`<link rel="stylesheet" href="${ASSET_PATH}" />`) ||
    /<base\b/i.test(html)
  ) {
    return undefined;
  }
  return stampConsoleBuildRevision(html, revision);
}

export async function loadReleasedConsole(
  source: string,
  revision: string,
  budget: ReadBudget,
): Promise<{ shell: string; asset: Buffer } | undefined> {
  try {
    const commit = await git(
      source,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      128,
      budget,
    );
    if (commit.toString("ascii").trim() !== revision) {
      return undefined;
    }
    const shellBytes = await git(
      source,
      ["cat-file", "blob", `${revision}:${SOURCE_PATH}index.html`],
      MAX_HTML_BYTES,
      budget,
    );
    const shell = stampReleaseShell(shellBytes, revision);
    if (!shell) {
      return undefined;
    }
    const asset = await git(
      source,
      ["cat-file", "blob", `${revision}:${SOURCE_PATH}console.css`],
      MAX_ASSET_BYTES,
      budget,
    );
    return { shell, asset };
  } catch {
    return undefined;
  }
}

const entities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
function attribute(html: string, prefix: string): string | undefined {
  const start = html.indexOf(prefix);
  if (start < 0) {
    return undefined;
  }
  const end = html.indexOf('"', start + prefix.length);
  return end < 0
    ? undefined
    : html
        .slice(start + prefix.length, end)
        .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]!);
}

function presentedTheme(html: string): ConsoleTheme | undefined {
  const displayPrefix = '<meta name="occ-console-display-name" content="';
  const metadata = section(html, displayPrefix, "</head>");
  if (metadata === undefined) {
    return undefined;
  }
  const displayName = attribute(metadata, displayPrefix);
  const logoUrl = attribute(metadata, '<meta name="occ-console-logo" content="');
  if (displayName === undefined || logoUrl === undefined || [...displayName].length > 80) {
    return undefined;
  }
  const faviconUrl = attribute(metadata, '<link rel="icon" href="');
  const appleTouchIconUrl = attribute(metadata, '<link rel="apple-touch-icon" href="');
  return {
    displayName,
    logoUrl,
    ...(faviconUrl === undefined ? {} : { faviconUrl }),
    ...(appleTouchIconUrl === undefined ? {} : { appleTouchIconUrl }),
    assets: new Map(),
  };
}

export function matchesReleaseShell(bytes: Buffer, shell: string): boolean {
  if (bytes.equals(Buffer.from(shell))) {
    return true;
  }
  try {
    const theme = presentedTheme(utf8.decode(bytes));
    return theme !== undefined && bytes.equals(Buffer.from(renderConsoleThemeShell(shell, theme)));
  } catch {
    return false;
  }
}
