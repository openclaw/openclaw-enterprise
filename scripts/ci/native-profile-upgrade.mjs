import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "./prepare-command.ts";

// This is the exact pre-feature main parent, not a previous published release.
export const nativeProfileBaseline = Object.freeze({
  revision: "535e08cae41dfd5bda0c072fcb37039e699203eb",
  tree: "618072a31adcaafb75060fa49c2d4f2309c19c98",
  nativeCommit: "b58996d69286d55d1bbbd9b5c03b4ad837baac45",
  sourceArchiveSha256: "a53322b1af2a374970e381f5eea64292fe8deadfaa11e3802bd256044757d1f1",
  migrations: "275f512c05f0773ce10fb5302a2f80aa0a123176",
  runtimeTree: "321b4da892accee710bb260459de236d33d2a364",
  controllerRecipe: "174d60747bcd89de181c69fac573abd4cc660477",
});
export const nativeProfileUpgradeFile = "tests/integration/native-profile-upgrade-k3d-real.test.ts";

export function nativeProfileSourceReceipt(value) {
  if (
    value === null ||
    typeof value !== "object" ||
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

export function selectsNativeProfileUpgrade(lane, file) {
  return lane === "gateway-routing" && (file === undefined || file === nativeProfileUpgradeFile);
}

// Verify the complete old build context, including its migration catalog. The
// candidate owns a separate, observed catalog; it need not equal the baseline.
export async function verifyNativeProfileBaseline(repository, run = execFile) {
  const git = async (...args) => (await run("git", args, { cwd: repository })).stdout.trim();
  assert.equal(await git("rev-parse", "HEAD"), nativeProfileBaseline.revision);
  assert.equal(await git("status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(await git("rev-parse", "HEAD:migrations"), nativeProfileBaseline.migrations);
  assert.equal(await git("rev-parse", "HEAD:deploy/runtime"), nativeProfileBaseline.runtimeTree);
  assert.equal(await git("rev-parse", "HEAD:Dockerfile"), nativeProfileBaseline.controllerRecipe);
  const source = JSON.parse(
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

// The candidate is the actual tested checkout, not an assumed copy of the old
// nine-bridge runtime. A merge may add bridges, migrations or another native pin.
export async function nativeProfileCandidateSource(repository) {
  const git = async (...args) => (await execFile("git", args, { cwd: repository })).stdout.trim();
  const source = JSON.parse(
    await readFile(join(repository, "deploy/runtime/openclaw-source.json"), "utf8"),
  );
  assert.ok(
    /^[a-f0-9]{40}$/.test(source.commit) && /^[a-f0-9]{64}$/.test(source.sourceArchiveSha256),
  );
  const bridgePatches = (await git("ls-tree", "-r", "HEAD", "deploy/runtime"))
    .split("\n")
    .flatMap((line) => {
      const match =
        /^100644 blob ([a-f0-9]{40})\t(deploy\/runtime\/openclaw-[a-z0-9-]+\.patch)$/.exec(line);
      return match ? [{ path: match[2], blob: match[1] }] : [];
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

export async function withNativeProfileBaseline(repository, operation) {
  const run = (args) => execFile("git", args, { cwd: repository, timeoutMs: 120_000 });
  try {
    await run(["cat-file", "-e", nativeProfileBaseline.revision + "^{commit}"]);
  } catch {
    // Public, fixed source; never select credentials or a moving branch. CI's
    // checkout uses persist-credentials:false. Reuse its existing object store.
    await run([
      "fetch",
      "--no-tags",
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
