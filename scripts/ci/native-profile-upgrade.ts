import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "./prepare-command.ts";

// The native-profile feature's first parent builds with upstream Node binaries.
export const nativeProfileBaseline = Object.freeze({
  revision: "28593a5b76bbb2afaf86ae2972853fd5d734b0ff",
  tree: "b5c3b6ef3a3641d57aae4116482a500b346c47a3",
  nativeCommit: "82b682c627ba8bfc2c2bd51cf46ad8f51c583857",
  sourceArchiveSha256: "f9f1c3b20a1f382783d6b0fafdcc10c5beb41079c216831258ae541217e85a20",
  migrations: "1ada4ee887ea812aac1cda2f07f2062a2c5d4658",
  runtimeTree: "95f793d9ae0dbe76ed82b718a03a2fc898f1fce4",
  controllerRecipe: "d539b81bf22959a45e71378b0a42f602138c6af5",
});
export const nativeProfileUpgradeFile = "tests/integration/native-profile-upgrade-k3d-real.test.ts";

function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function sourceMetadata(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null) {
    throw new TypeError("Cannot read properties of null (reading 'commit')");
  }
  return isPropertyBag(value) ? value : {};
}

// A JSON array containing a single hash coerces to that hash at any nesting depth.
type SourceHash = string | [SourceHash];

function assertSourceHashes(source: Record<string, unknown>): asserts source is {
  commit: SourceHash;
  sourceArchiveSha256: SourceHash;
} {
  assert.ok(
    /^[a-f0-9]{40}$/.test(String(source.commit)) &&
      /^[a-f0-9]{64}$/.test(String(source.sourceArchiveSha256)),
  );
}

export function nativeProfileSourceReceipt(value: unknown) {
  if (
    !isPropertyBag(value) ||
    !Object.entries(nativeProfileBaseline).every(([key, expected]) => value[key] === expected) ||
    typeof value.tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.tree)
  ) {
    throw new Error(
      "Native profile baseline source receipt does not match the fixed pre-feature source.",
    );
  }
  return { ...nativeProfileBaseline };
}

export function selectsNativeProfileUpgrade(lane: unknown, file?: unknown) {
  return lane === "gateway-routing" && (file === undefined || file === nativeProfileUpgradeFile);
}

// Verify the complete old build context, including its migration catalog. The
// candidate owns a separate, observed catalog; it need not equal the baseline.
export async function verifyNativeProfileBaseline(
  repository: string,
  run: typeof execFile = execFile,
) {
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: repository })).stdout.trim();
  assert.equal(await git("rev-parse", "HEAD"), nativeProfileBaseline.revision);
  assert.equal(await git("status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(await git("rev-parse", "HEAD:migrations"), nativeProfileBaseline.migrations);
  assert.equal(await git("rev-parse", "HEAD:deploy/runtime"), nativeProfileBaseline.runtimeTree);
  assert.equal(await git("rev-parse", "HEAD:Dockerfile"), nativeProfileBaseline.controllerRecipe);
  const source = sourceMetadata(
    await readFile(join(repository, "deploy/runtime/openclaw-source.json"), "utf8"),
  );
  assert.equal(source.commit, nativeProfileBaseline.nativeCommit);
  assert.equal(source.sourceArchiveSha256, nativeProfileBaseline.sourceArchiveSha256);
  const legacy = await readFile(
    join(repository, "apps/controller/src/http/native-admin.ts"),
    "utf8",
  );
  assert.match(legacy, /compute\.getGatewayEndpoint\?\.\(revision\)/);
  assert.match(legacy, /compute\.getGatewayChatEndpoint\?\.\(revision\)/);
  assert.doesNotMatch(legacy, /getGatewayBrowserRequest/);
  return nativeProfileSourceReceipt({
    ...nativeProfileBaseline,
    tree: await git("rev-parse", "HEAD^{tree}"),
  });
}

// Record the tested candidate independently because its bridges, migrations and
// native pin can differ from the baseline.
export async function nativeProfileCandidateSource(repository: string) {
  const git = async (...args: string[]) =>
    (await execFile("git", args, { cwd: repository })).stdout.trim();
  const source = sourceMetadata(
    await readFile(join(repository, "deploy/runtime/openclaw-source.json"), "utf8"),
  );
  assertSourceHashes(source);
  const bridgePatches = (await git("ls-tree", "-r", "HEAD", "deploy/runtime"))
    .split("\n")
    .flatMap((line) => {
      const match =
        /^100644 blob ([a-f0-9]{40})\t(deploy\/runtime\/openclaw-[a-z0-9-]+\.patch)$/.exec(line);
      if (!match) {
        return [];
      }
      const blob = match[1];
      const path = match[2];
      assert.ok(blob !== undefined && path !== undefined);
      return [{ path, blob }];
    });
  assert.ok(bridgePatches.length > 0, "candidate native bridge inventory is required");
  return {
    revision: await git("rev-parse", "HEAD"),
    tree: await git("rev-parse", "HEAD^{tree}"),
    controllerRecipe: await git("rev-parse", "HEAD:Dockerfile"),
    runtimeRecipe: await git("rev-parse", "HEAD:deploy/runtime/Dockerfile"),
    runtimeTree: await git("rev-parse", "HEAD:deploy/runtime"),
    migrations: await git("rev-parse", "HEAD:migrations"),
    nativeCommit: source.commit,
    sourceArchiveSha256: source.sourceArchiveSha256,
    bridgePatches,
  };
}

export async function withNativeProfileBaseline<Result>(
  repository: string,
  operation: (
    sourceRoot: string,
    receipt: Awaited<ReturnType<typeof verifyNativeProfileBaseline>>,
  ) => Promise<Result>,
): Promise<Result> {
  const run = (args: string[]) => execFile("git", args, { cwd: repository, timeoutMs: 120_000 });
  try {
    await run(["cat-file", "-e", nativeProfileBaseline.revision + "^{commit}"]);
  } catch {
    // Public, fixed source; never select credentials or a moving branch. CI's
    // checkout uses persist-credentials:false. Reuse its existing object store.
    const { stdout } = await run(["rev-parse", "--is-shallow-repository"]);
    const depth = stdout.trim() === "true" ? ["--depth=1"] : [];
    await run([
      "fetch",
      "--no-tags",
      ...depth,
      "https://github.com/openclaw/openclaw-enterprise.git",
      nativeProfileBaseline.revision,
    ]);
  }

  const directory = await mkdtemp(join(tmpdir(), "oce-native-upgrade-source-"));
  const source = join(directory, "source");
  let added = false;
  try {
    await run(["worktree", "add", "--detach", source, nativeProfileBaseline.revision]);
    added = true;
    const receipt = await verifyNativeProfileBaseline(source);
    return await operation(source, receipt);
  } finally {
    if (added) {
      await run(["worktree", "remove", source]);
    }
    await rm(directory, { recursive: true, force: true });
  }
}
