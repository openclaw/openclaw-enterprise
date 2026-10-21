import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import {
  consoleThemeColorRoles,
  type ConsoleTheme,
  type ConsoleThemeAsset,
} from "../console-theme.ts";

export class ConsoleThemeError extends Error {
  constructor(detail: string) {
    super(`Console theme: ${detail}`);
    this.name = "ConsoleThemeError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(root: string, name: string, limit: number): Promise<Buffer> {
  // ConfigMap projections use symlinks. The mount and its parents are operator-controlled;
  // O_NOFOLLOW protects the resolved file, not a parent another writer could replace.
  const path = await realpath(join(root, name));
  const inside = relative(root, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new ConsoleThemeError(`${name} resolves outside the theme directory.`);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new ConsoleThemeError(`${name} must be a regular file of at most ${limit} bytes.`);
    }
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > limit) {
      throw new ConsoleThemeError(`${name} exceeds ${limit} bytes.`);
    }
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

function imageType(name: string, body: Buffer, favicon: boolean): string {
  const extension = extname(name).toLowerCase();
  if (
    extension === ".png" &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    !favicon &&
    extension === ".webp" &&
    body.length >= 12 &&
    body.toString("ascii", 0, 4) === "RIFF" &&
    body.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    favicon &&
    extension === ".ico" &&
    body.length >= 6 &&
    body.readUInt32LE(0) === 65536 &&
    body.readUInt16LE(4) > 0
  ) {
    return "image/vnd.microsoft.icon";
  }
  throw new ConsoleThemeError(`${name} has an unsupported image format or signature.`);
}

/** Only the API loads themes; no request reads operator-controlled filesystem paths. */
export async function loadConsoleTheme(
  directory: string | undefined,
): Promise<ConsoleTheme | undefined> {
  if (directory === undefined) {
    return undefined;
  }
  if (!isAbsolute(directory)) {
    throw new ConsoleThemeError("OCC_CONSOLE_THEME_DIR must be an absolute directory.");
  }
  try {
    const root = await realpath(directory);
    const manifestBytes = await readBounded(root, "theme.json", 64 * 1024);
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    const keys = new Set([
      "schemaVersion",
      "displayName",
      "logo",
      "favicon",
      "appleTouchIcon",
      "colors",
    ]);
    if (
      !object(manifest) ||
      manifest.schemaVersion !== 1 ||
      Object.keys(manifest).some((key) => !keys.has(key))
    ) {
      throw new ConsoleThemeError("theme.json requires schemaVersion 1 and supported fields only.");
    }
    const displayName =
      manifest.displayName === undefined ? "OpenClaw Enterprise" : manifest.displayName;
    if (
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      [...displayName].length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(displayName)
    ) {
      throw new ConsoleThemeError(
        "displayName must contain 1–80 characters without control characters.",
      );
    }
    const colors = manifest.colors === undefined ? {} : manifest.colors;
    if (!object(colors)) {
      throw new ConsoleThemeError("colors must be an object of supported color roles.");
    }
    const declarations = Object.entries(colors).map(([role, color]) => {
      if (
        !Object.hasOwn(consoleThemeColorRoles, role) ||
        typeof color !== "string" ||
        !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)
      ) {
        throw new ConsoleThemeError(
          "colors must use supported roles and six- or eight-digit hex colors.",
        );
      }
      return `  --color-${consoleThemeColorRoles[role as keyof typeof consoleThemeColorRoles]}: ${color};`;
    });
    const assets = new Map<string, ConsoleThemeAsset>();
    let total = manifestBytes.length;
    async function image(
      field: "logo" | "favicon" | "appleTouchIcon",
    ): Promise<string | undefined> {
      const name = (manifest as Record<string, unknown>)[field];
      if (name === undefined) {
        return undefined;
      }
      if (
        typeof name !== "string" ||
        !/^[a-z\d][a-z\d._-]*\.(?:png|webp|ico)$/i.test(name) ||
        name.includes("..")
      ) {
        throw new ConsoleThemeError(`${field} must name a supported image in the theme directory.`);
      }
      const url = `/console/theme/${name}`;
      const existing = assets.get(url);
      const body = existing?.body ?? (await readBounded(root, name, 256 * 1024));
      const contentType = imageType(name, body, field === "favicon");
      if (existing === undefined) {
        total += body.length;
        assets.set(url, { body, contentType });
      }
      return url;
    }
    const logoUrl = (await image("logo")) ?? "/console/oce-mascot.png";
    const faviconUrl = await image("favicon");
    const appleTouchIconUrl = await image("appleTouchIcon");
    if (total > 768 * 1024) {
      throw new ConsoleThemeError("referenced bundle exceeds 768 KiB.");
    }
    assets.set("/console/theme/colors.css", {
      body: Buffer.from(`:root {\n${declarations.join("\n")}\n}\n`),
      contentType: "text/css; charset=utf-8",
    });
    return Object.freeze({
      displayName,
      logoUrl,
      ...(faviconUrl === undefined ? {} : { faviconUrl }),
      ...(appleTouchIconUrl === undefined ? {} : { appleTouchIconUrl }),
      assets,
    });
  } catch (error) {
    if (error instanceof ConsoleThemeError) {
      throw error;
    }
    throw new ConsoleThemeError(
      "cannot read the configured bundle; check theme.json, referenced images, and permissions.",
    );
  }
}
