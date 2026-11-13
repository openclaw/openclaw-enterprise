import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { JsonValue } from "../../../apps/controller/src/drivers/repo/access/json-value.ts";
import type { CredentialServiceOwner } from "../../../apps/controller/src/drivers/repo/access/internal-contracts.ts";
import type {
  RepositoryCredentialSessionResult,
  ServiceConfig,
} from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { RuntimeRepositoryBinding } from "../../../apps/controller/src/drivers/repo/github/access/client/manifest.ts";
import { appRoot, appExtension, appModule, credentialClientPath } from "./runtime.mjs";
import { cleanEnvironment, run as runProcess, temporaryDirectory } from "./process.mjs";

type NativeMaterialEntry = { repositoryRef: string; publicCa?: Uint8Array } & (
  | { opened: RepositoryCredentialSessionResult; clientDirectory?: never }
  | { opened?: never; clientDirectory: string }
);
export type CredentialClientFixture = {
  clientDirectory: string;
  opened: RepositoryCredentialSessionResult;
  config: ServiceConfig;
  tls: { ca: Buffer };
  clock: { deadlines(): number[]; advance(milliseconds: number): Promise<void> };
  service: Pick<CredentialServiceOwner, "close">;
  git: {
    bare: string;
    trace: { method?: string; path: string; gitProtocol?: string | string[] }[];
    ref(name: string): Promise<string>;
    disconnectAfterNextAcceptedPush(): void;
    holdNextFetch(options?: { beforeHeaders?: boolean }): {
      observed: Promise<void>;
      release(): void;
    };
  };
  github: {
    trace: { method?: string; target: string; tokenIndex?: number; userAgent?: string }[];
    issuesOfTokens: { length: number };
    authenticationAttempts: { length: number };
    pulls: Map<
      number,
      { number: number; body: string; draft?: boolean; state: string; title: string }
    >;
    disconnectAfterMutation(method: string, target: string): void;
  };
};
export type StartCredentialClientFixture = (
  t: TestContext,
  options?: Parameters<typeof import("./service.mjs").startCredentialServiceFixture>[1],
) => Promise<CredentialClientFixture | undefined>;
type ClientCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeout?: number;
  allowFailure?: boolean;
  signal?: AbortSignal;
};
export type ClientCommand = (
  command: string,
  args: string[],
  options?: ClientCommandOptions,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const run = runProcess as ClientCommand;

// Source and delivered builds resolve the same module exports through different file paths.
export async function loadRepositoryClientModule<Module extends object>(
  path: string,
  exports: readonly (keyof Module)[],
): Promise<Module> {
  const value: unknown = await appModule(`drivers/repo/github/access/client/${path}`);
  assert.ok(value !== null && typeof value === "object");
  const module = value as Record<PropertyKey, unknown>;
  for (const name of exports) {
    assert.equal(typeof module[name], "function", `missing client export ${String(name)}`);
  }
  return value as Module;
}

const hash = (value: readonly string[] | readonly (readonly string[])[]) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Publish real session encoding and render the same native include used by initialization. */
export async function createNativeClientMaterial(
  t: TestContext,
  entries: readonly NativeMaterialEntry[],
  { ca, root }: { ca?: Uint8Array; root?: string } = {},
) {
  root ??= await temporaryDirectory(t, "repository-native-material-");
  await mkdir(join(root, "sessions"), { mode: 0o700 });
  const { readClientConfiguration, writeClientConfiguration } = await loadRepositoryClientModule<
    typeof import("../../../apps/controller/src/drivers/repo/github/access/client/config.ts")
  >("config", ["readClientConfiguration", "writeClientConfiguration"]);
  const { readRuntimeRepositoryManifest } = await loadRepositoryClientModule<
    typeof import("../../../apps/controller/src/drivers/repo/github/access/client/manifest.ts")
  >("manifest", ["readRuntimeRepositoryManifest"]);
  const { renderNativeGitConfiguration } = await loadRepositoryClientModule<
    typeof import("../../../apps/controller/src/drivers/repo/github/access/client/native-git.ts")
  >("native-git", ["renderNativeGitConfiguration"]);
  const bindings: Omit<RuntimeRepositoryBinding, "materialDirectory" | "configuration">[] = [];
  for (const { opened, clientDirectory, repositoryRef, publicCa = ca } of entries) {
    const configuration = opened
      ? {
          sessionId: opened.session.sessionId,
          deadlineWallMs: opened.session.deadlineWallMs,
          client: opened.client,
        }
      : await readClientConfiguration(clientDirectory);
    const directory = join(root, "sessions", hash([repositoryRef, configuration.sessionId]));
    if (opened) {
      await writeClientConfiguration(opened, directory, publicCa);
    } else {
      // Preserve the established clientDirectory-only fixture consumer, including
      // live qualification, without loading its bearer into the fixture process.
      await cp(clientDirectory, directory, { recursive: true, errorOnExist: true, force: false });
    }
    bindings.push({
      repositoryRef,
      sessionId: configuration.sessionId,
      deadlineWallMs: configuration.deadlineWallMs,
      directory,
      client: configuration.client,
    });
  }
  bindings.sort((a, b) =>
    a.repositoryRef < b.repositoryRef ? -1 : a.repositoryRef > b.repositoryRef ? 1 : 0,
  );
  const manifest = {
    version: 1,
    generation: hash(bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
    bindings,
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const helper = join(appRoot, `drivers/repo/github/access/client/git-helper.${appExtension}`);
  const requiresHooks = bindings.some(({ client }) => client.pushRefAllowlist !== undefined);
  let hooks: string | undefined;
  if (requiresHooks && appExtension === "js") {
    // Packaged qualification must execute the delivered hooks, without source mounts
    // or replacement wrappers hiding a missing/non-executable installed hook.
    hooks = join(dirname(helper), "hooks");
    await access(join(hooks, "pre-push"), constants.X_OK);
  } else if (requiresHooks) {
    // Executable test wrappers belong to a separate image stand-in, never to
    // the private material generation. They run the actual client dispatcher.
    hooks = await temporaryDirectory(t, "repository-native-hooks-");
    const names: unknown = JSON.parse(
      await readFile(
        new URL("../../../deploy/runtime/repository-credentials/hooks.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      Array.isArray(names) &&
        names.every((name: unknown): name is string => typeof name === "string"),
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const name of names) {
      await writeFile(
        join(hooks, name),
        "#!/bin/sh\nexec " +
          quote(process.execPath) +
          " " +
          quote(credentialClientPath("hook-dispatch")) +
          " " +
          name +
          ' "$@"\n',
        { mode: 0o755 },
      );
    }
  }
  const config = await renderNativeGitConfiguration(
    await readRuntimeRepositoryManifest(root),
    root,
    { node: process.execPath, helper, ...(hooks === undefined ? {} : { hooks }) },
  );
  await writeFile(join(root, "gitconfig"), config, { mode: 0o600 });
  return { root, manifest, config, helper, hooks };
}

/** Execute stock Git with a real native include; gh retains its private session configuration. */
export async function runPinnedClients(
  t: TestContext,
  fixture: Pick<CredentialClientFixture, "clientDirectory">,
  { signal = t.signal }: { signal?: AbortSignal } = {},
) {
  const directory = await temporaryDirectory(t, "repository-credentials-client-work-");
  const launcher = join(appRoot, `drivers/repo/github/access/client/launch.${appExtension}`);
  const material = await createNativeClientMaterial(t, [
    { clientDirectory: fixture.clientDirectory, repositoryRef: "fixture" },
  ]);
  const env: NodeJS.ProcessEnv = cleanEnvironment({
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, ".config"),
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  const invoke = (client: "git" | "gh", args: string[], options: ClientCommandOptions = {}) =>
    run(
      client === "git" ? "/usr/bin/git" : process.execPath,
      client === "git" ? args : [launcher, fixture.clientDirectory, "gh", ...args],
      { env, cwd: directory, signal, ...options },
    );
  const version = await run("gh", ["--version"], { env, signal });
  assert.match(version.stdout, /^gh version 2\.103\.2\b/);
  return {
    directory,
    material,
    git: (args: string[], options?: ClientCommandOptions) => invoke("git", args, options),
    gh: (args: string[], options?: ClientCommandOptions) => invoke("gh", args, options),
    async json(name: string, value: JsonValue) {
      const path = join(directory, name);
      await writeFile(path, JSON.stringify(value));
      return path;
    },
  };
}
