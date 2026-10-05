import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowsPushRef, readPushedBranchRef } from "../../../credentials/client-contracts.ts";
import { readClientConfiguration } from "./config.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
  requireCurrentBinding,
  type RuntimeRepositoryBinding,
  type RuntimeRepositoryManifest,
} from "./manifest.ts";
import { hasGitPushDestination, selectGitPushDestination } from "./targets.ts";

function gitOutput(args: readonly string[], absent = false): string | undefined {
  const result = spawnSync("/usr/bin/git", args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (absent && result.status === 1 && !result.error) {
    return undefined;
  }
  if (result.status !== 0 || result.error) {
    throw new Error("repository-hook-inspection-failed");
  }
  return result.stdout;
}

function setting(name: string): string | undefined {
  const output = gitOutput(["config", "--null", "--get", "oce.repository." + name], true);
  if (output === undefined) {
    return undefined;
  }
  if (!output.endsWith("\0") || output.slice(0, -1).includes("\0")) {
    throw new Error("repository-hook-inspection-failed");
  }
  return output.slice(0, -1) || undefined;
}

/** True when the push may proceed, or the refusal message the hook prints. */
async function checkPush(destination: string, input: Buffer): Promise<true | string> {
  if (!destination.startsWith("https://")) {
    return true;
  }
  const directory = setting("session");
  let manifest: RuntimeRepositoryManifest;
  let expectedGeneration: string | undefined;
  let pinned: RuntimeRepositoryBinding | undefined;
  if (directory) {
    const configuration = await readClientConfiguration(directory);
    const binding: RuntimeRepositoryBinding = {
      repositoryRef: "operator",
      sessionId: configuration.sessionId,
      deadlineWallMs: configuration.deadlineWallMs,
      directory: resolve(directory),
      materialDirectory: resolve(directory),
      client: configuration.client,
      configuration,
    };
    manifest = { generation: "", bindings: [binding] };
  } else {
    const root = setting("manifestRoot");
    expectedGeneration = setting("generation");
    if (!root || !expectedGeneration) {
      throw new Error("invalid-repository-selection");
    }
    manifest = await readRuntimeRepositoryManifest(root);
  }
  // An unrelated destination must not be rejected by an inherited pin.
  if (!hasGitPushDestination(manifest, destination)) {
    return true;
  }
  if (!directory) {
    if (manifest.generation !== expectedGeneration) {
      throw new Error("invalid-repository-selection");
    }
    pinned = inheritedRepositoryBinding(manifest, process.env);
  }
  const binding = selectGitPushDestination(manifest, destination, pinned);
  if (!binding || binding.client.pushRefAllowlist === undefined) {
    return true;
  }
  requireCurrentBinding(binding);
  // Read as latin1 so each byte is one character; the remote ref is then decoded as
  // strict UTF-8 with the gateway's rules, so both refuse the same refs.
  const lines = input.toString("latin1").split("\n");
  if (lines.pop() !== "") {
    throw new Error("invalid-pre-push-input");
  }
  for (const line of lines) {
    // Git writes an object-name source (`HEAD@{1 hour ago}`) verbatim, so the
    // local ref may contain spaces; the last three fields cannot.
    const fields =
      /^(.+) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([^ ]+) ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(line);
    if (!fields) {
      throw new Error("invalid-pre-push-input");
    }
    const read = readPushedBranchRef(Buffer.from(fields[3]!, "latin1"));
    if (!("ref" in read)) {
      // The reason names a code point, never the raw name, so the terminal shows no
      // invisible or direction-changing character.
      return `repository-push-ref-not-allowed: ${read.refused}`;
    }
    if (!allowsPushRef(binding.client.pushRefAllowlist, read.ref)) {
      return "repository-push-ref-not-allowed";
    }
  }
  return true;
}

async function readPushInput(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) {
      throw new Error("pre-push-input-too-large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** This hook's presence replaces Git's built-in updateInstead implementation. */
function defaultPushToCheckout(args: readonly string[]): number {
  if (args.length !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(args[0]!)) {
    throw new Error("invalid-push-to-checkout-input");
  }
  const checkedGit = (arguments_: readonly string[]): void => {
    const result = spawnSync("/usr/bin/git", arguments_, { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error("repository-checkout-update-failed");
    }
  };
  // Preserve Git's default clean-index/worktree checks, including an unborn HEAD.
  checkedGit(["update-index", "-q", "--ignore-submodules", "--refresh"]);
  checkedGit(["diff-files", "--quiet", "--ignore-submodules", "--"]);
  const history = spawnSync("/usr/bin/git", ["cat-file", "-e", "HEAD"], { stdio: "ignore" });
  if (history.error || history.signal) {
    throw new Error("repository-hook-inspection-failed");
  }
  const head =
    history.status === 0 ? "HEAD" : gitOutput(["hash-object", "-t", "tree", "--stdin"])!.trim();
  checkedGit(["diff-index", "--quiet", "--cached", "--ignore-submodules", head, "--"]);
  checkedGit(["read-tree", "-u", "-m", args[0]!]);
  return 0;
}

async function commonDirectory(): Promise<string> {
  if (process.env.GIT_COMMON_DIR) {
    return resolve(process.env.GIT_COMMON_DIR);
  }
  if (process.env.GIT_DIR) {
    try {
      await access(join(process.env.GIT_DIR, "commondir"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // During init Git supplies GIT_DIR before HEAD exists. A linked worktree
      // has a commondir file and must still resolve its shared hook directory.
      return resolve(process.env.GIT_DIR);
    }
  }
  const output = gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"])!;
  if (!output.endsWith("\n")) {
    throw new Error("repository-hook-inspection-failed");
  }
  return output.slice(0, -1);
}

/** Image-owned dispatch preserves Git's ordinary hooks in the common directory. */
async function run(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  if (!name || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("invalid-repository-hook");
  }
  let input: Buffer | undefined;
  if (name === "pre-push") {
    if (args.length !== 2) {
      throw new Error("invalid-pre-push-input");
    }
    input = await readPushInput();
    const verdict = await checkPush(args[1]!, input);
    if (verdict !== true) {
      process.stderr.write(verdict + "\n");
      return 1;
    }
  }
  const common = await commonDirectory();
  if (!isAbsolute(common) || /[\r\n\0]/.test(common)) {
    throw new Error("repository-hook-inspection-failed");
  }
  const hook = join(common, "hooks", name);
  const activeHooks = (process.env.OCE_REPOSITORY_ACTIVE_HOOKS ?? "").split("\n").filter(Boolean);
  if (activeHooks.includes(hook)) {
    throw new Error("recursive-repository-hook");
  }
  try {
    await access(hook, constants.X_OK);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return name === "push-to-checkout" ? defaultPushToCheckout(args) : 0;
    }
    throw error;
  }
  const env = { ...process.env, OCE_REPOSITORY_ACTIVE_HOOKS: [...activeHooks, hook].join("\n") };
  const child =
    input === undefined
      ? spawnSync(hook, args, { env, stdio: "inherit" })
      : spawnSync(hook, args, { env, input, stdio: ["pipe", "inherit", "inherit"] });
  if (child.error) {
    throw new Error("repository-hook-execution-failed");
  }
  return child.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("repository-pre-push-guard-failed\n");
      process.exitCode = 1;
    },
  );
}
