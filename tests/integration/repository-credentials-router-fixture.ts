import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { RepositoryCredentialClientConfiguration } from "../../apps/controller/src/drivers/repo/access/client-contracts.ts";
import type { RepositoryCredentialSessionResult } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { repositoryClientData } from "../fixtures/repository-credentials/builders.mjs";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.ts";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import { settled } from "../helpers/child-processes.mjs";
import { fileCompileCache } from "../helpers/compile-cache.mjs";

type CommandOptions = NonNullable<Parameters<typeof run>[2]>;
type CommandResult = Awaited<ReturnType<typeof run>>;
type Material = Awaited<ReturnType<typeof createNativeClientMaterial>>;
type Binding = Material["manifest"]["bindings"][number];

// The shared JavaScript helper drains siblings before returning results in input order.
export function settle<const T extends readonly unknown[]>(
  promises: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;
export function settle(promises: readonly unknown[]): Promise<unknown[]> {
  return settled(promises);
}

// Children get an allowlisted environment, so they only share the lane's Node
// compile cache when it is passed explicitly; outside CI the file keeps its own.
const compileCache = await fileCompileCache("repository-credentials-router");
export const clean = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  cleanEnvironment({ NODE_COMPILE_CACHE: compileCache, ...extra });

// Every case spawns Git or Node children, and Git starts the managed hook
// dispatcher for most commands; at most one top-level child per CPU runs.
const slots = Math.max(2, availableParallelism());
const waiting: (() => void)[] = [];
let active = 0;
export async function exec(command: string, args: readonly string[], options: CommandOptions) {
  if (active < slots) {
    active += 1;
  } else {
    // A finishing child hands its slot straight to the oldest waiter.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await run(command, args, options);
  } finally {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  }
}
export const gitWith =
  (defaults: CommandOptions = {}) =>
  (args: readonly string[], options: CommandOptions = {}) =>
    exec("/usr/bin/git", args, { ...defaults, ...options });
export const git = gitWith();

const hash = (value: readonly (readonly string[])[]) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const opened = (
  sessionId: string,
  {
    repository = "example/project",
    pushRefAllowlist,
  }: Pick<Partial<RepositoryCredentialClientConfiguration>, "repository" | "pushRefAllowlist"> = {},
): RepositoryCredentialSessionResult => ({
  session: {
    sessionId,
    deadlineWallMs: Date.now() + 86400000,
    state: "OPEN",
    binding: { providerInstanceId: "fixture", repositoryId: repository, grantId: sessionId },
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 0,
      revoked: 0,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  },
  bearer: `controlled_gateway_${sessionId}_${"0".repeat(32)}`,
  client: repositoryClientData({ repository, ...(pushRefAllowlist && { pushRefAllowlist }) }),
});
/** Native material from `[repositoryRef, opened]` pairs. */
export const nativeMaterial = (
  t: TestContext,
  ...entries: [string, RepositoryCredentialSessionResult][]
) =>
  createNativeClientMaterial(
    t,
    entries.map(([repositoryRef, session]) => ({ opened: session, repositoryRef })),
  );
export const protocol = (path = "example/project.git") =>
  `protocol=https\nhost=credentials.example.test\npath=${path}\n\n`;
export const environment = (
  material: Material,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const env = clean({
    HOME: material.root,
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
    ...extra,
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  return env;
};
export const fill = (
  material: Material,
  extra: NodeJS.ProcessEnv = {},
  path?: string,
  input = protocol(path),
) => git(["credential", "fill"], { env: environment(material, extra), input, allowFailure: true });
export const pin = (material: Material, binding: Binding) =>
  JSON.stringify([material.manifest.generation, binding.repositoryRef, binding.sessionId]);
export const pushLine = (ref: string, source = "HEAD") =>
  `${source} ${"1".repeat(40)} ${ref} ${"0".repeat(40)}\n`;
/** The pre-push guard's refusal when it cannot check a push, with its public reason. */
export const guardFailed = (reason?: string) =>
  `repository-pre-push-guard-failed${reason === undefined ? "" : `: ${reason}`}\n`;
/** Run the managed pre-push hook in `work` with `input` written to `name`. */
export const prePush = async (
  work: string,
  env: NodeJS.ProcessEnv,
  destination: string,
  input: string,
  name = "push-input",
) => {
  await writeFile(join(work, name), input);
  return git(
    ["hook", "run", `--to-stdin=${join(work, name)}`, "pre-push", "--", "origin", destination],
    { cwd: work, env, allowFailure: true },
  );
};
export const writeManifest = (material: Material, manifest: Material["manifest"]) =>
  writeFile(join(material.root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
/** A manifest over these bindings with their exact generation digest. */
export const manifestOf = (bindings: Binding[]) => ({
  version: 1,
  generation: hash(bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
  bindings,
});
/** Copy another material's sessions into `material`; returns its bindings at their new paths. */
export const relocated = async (material: Material, other: Material) => {
  await cp(join(other.root, "sessions"), join(material.root, "sessions"), { recursive: true });
  return other.manifest.bindings.map((binding) => ({
    ...binding,
    directory: binding.directory.replace(other.root, material.root),
  }));
};
/** A refused credential request releases nothing. */
export const refused = (result: CommandResult, message?: string) => {
  assert.notEqual(result.code, 0, message ?? "");
  assert.equal(result.stdout, "", message ?? "");
};
export const granted = (result: CommandResult, bearer: string) =>
  assert.equal(result.stdout.includes(bearer), true);
