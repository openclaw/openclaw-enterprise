import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientFiles } from "./config.ts";
import {
  readRuntimeRepositoryManifest,
  requireCurrentBinding,
  type RuntimeRepositoryManifest,
} from "./manifest.ts";
import { readPrivateFile } from "./private-files.ts";

export { normalizePushRefAllowlist } from "../../../credentials/client-contracts.ts";

interface NativeGitPaths {
  readonly node: string;
  readonly helper: string;
  readonly hooks?: string;
}

const installedPaths: NativeGitPaths = {
  node: "/usr/local/bin/node",
  helper:
    "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/git-helper.js",
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const configQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;

function validatePaths(paths: NativeGitPaths): void {
  for (const path of [
    paths.node,
    paths.helper,
    ...(paths.hooks === undefined ? [] : [paths.hooks]),
  ]) {
    if (
      !isAbsolute(path) ||
      path.length > 4096 ||
      [...path].some(
        (character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
      )
    ) {
      throw new Error("invalid-native-git-path");
    }
  }
}

/** Render only public routing metadata; bearer files are never opened here. */
export async function renderNativeGitConfiguration(
  manifest: RuntimeRepositoryManifest,
  finalRoot: string,
  paths: NativeGitPaths,
): Promise<string> {
  validatePaths(paths);
  const hosts = new Map<string, string>();
  const origins = new Map<string, { ca?: Buffer; caPath?: string }>();
  for (const binding of manifest.bindings) {
    const { client, configuration } = binding;
    const previous = hosts.get(client.canonicalApiHost);
    if (previous !== undefined && previous !== client.gatewayOrigin) {
      throw new Error("multiple-gateway-origins-for-host");
    }
    hosts.set(client.canonicalApiHost, client.gatewayOrigin);
    const ca = configuration.hasPublicCa
      ? await readPrivateFile(join(binding.materialDirectory, "ca.pem"), 64 * 1024)
      : undefined;
    const trust = origins.get(client.gatewayOrigin);
    if (trust && (Boolean(trust.ca) !== Boolean(ca) || (trust.ca && ca && !trust.ca.equals(ca)))) {
      throw new Error("conflicting-gateway-trust");
    }
    if (!trust) {
      origins.set(client.gatewayOrigin, {
        ...(ca ? { ca, caPath: join(binding.directory, "ca.pem") } : {}),
      });
    }
  }
  const helper = `!${shellQuote(paths.node)} ${shellQuote(paths.helper)} manifest ${shellQuote(finalRoot)} ${shellQuote(manifest.generation)}`;
  const lines: string[] = [];
  if (manifest.bindings.some(({ client }) => client.pushRefAllowlist !== undefined)) {
    lines.push(
      "[core]",
      "\thooksPath = " + configQuote(paths.hooks ?? join(dirname(paths.helper), "hooks")),
      '[oce "repository"]',
      "\tsession =",
      "\tmanifestRoot = " + configQuote(finalRoot),
      "\tgeneration = " + configQuote(manifest.generation),
    );
  }
  for (const [host, origin] of [...hosts].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    lines.push(
      `[url ${configQuote(`${origin}/`)}]`,
      `\tinsteadOf = ${configQuote(`https://${host}/`)}`,
    );
  }
  for (const [origin, trust] of [...origins].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    lines.push(
      `[credential ${configQuote(origin)}]`,
      "\thelper =",
      `\thelper = ${configQuote(helper)}`,
      "\tuseHttpPath = true",
      `[http ${configQuote(origin)}]`,
      "\tsslVerify = true",
      "\tfollowRedirects = false",
    );
    if (trust.caPath) {
      lines.push(`\tsslCAInfo = ${configQuote(trust.caPath)}`);
    }
  }
  const config = lines.join("\n") + "\n";
  if (Buffer.byteLength(config) > 256 * 1024) {
    throw new Error("native-git-configuration-too-large");
  }
  return config;
}

/** Called by material initialization before it atomically publishes a generation. */
export async function prepareNativeGitConfiguration(
  stagingRoot: string,
  finalRoot: string,
): Promise<void> {
  const manifest = await readRuntimeRepositoryManifest(stagingRoot, finalRoot);
  for (const binding of manifest.bindings) {
    requireCurrentBinding(binding);
  }
  const config = await renderNativeGitConfiguration(manifest, finalRoot, installedPaths);
  for (const binding of manifest.bindings) {
    requireCurrentBinding(binding);
  }
  const file = await open(
    join(stagingRoot, "gitconfig"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(config);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** The operator's single-session launcher uses the same stock Git defaults. */
export function singleSessionGitConfiguration(
  configuration: ClientFiles,
  directory: string,
): readonly string[] {
  const helperPath = join(
    dirname(fileURLToPath(import.meta.url)),
    `git-helper${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  );
  const helper = `!${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${shellQuote(directory)}`;
  const origin = configuration.client.gatewayOrigin;
  if (configuration.client.pushRefAllowlist !== undefined && import.meta.url.endsWith(".ts")) {
    throw new Error("push-policy-requires-packaged-client");
  }
  return [
    "oce.repository.session=" + directory,
    ...(configuration.client.pushRefAllowlist === undefined
      ? []
      : ["core.hooksPath=" + join(dirname(helperPath), "hooks")]),
    `url.${origin}/.insteadOf=https://${configuration.client.canonicalApiHost}/`,
    `credential.${origin}.helper=`,
    `credential.${origin}.helper=${helper}`,
    `credential.${origin}.useHttpPath=true`,
    `http.${origin}.sslVerify=true`,
    `http.${origin}.followRedirects=false`,
    ...(configuration.hasPublicCa ? [`http.${origin}.sslCAInfo=${join(directory, "ca.pem")}`] : []),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, stagingRoot, finalRoot, ...extra] = process.argv.slice(2);
  if (operation !== "prepare" || !stagingRoot || !finalRoot || extra.length) {
    process.stderr.write("invalid-native-git-request\n");
    process.exitCode = 1;
  } else {
    prepareNativeGitConfiguration(stagingRoot, finalRoot).catch(() => {
      process.stderr.write("native-git-preparation-failed\n");
      process.exitCode = 1;
    });
  }
}
