#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Options = Partial<
  Record<
    | "source"
    | "out"
    | "variant"
    | "expected-tree"
    | "runtime-image"
    | "artifacts"
    | "archive"
    | "record-sha256",
    string
  >
>;
function option(options: Options, name: keyof Options): string {
  const value = options[name];
  assert.ok(value, `--${name} is required`);
  return value;
}
interface Prepared {
  inputs: typeof inputs;
  variant: keyof typeof trees;
  tree: string;
}
interface BuildRecord extends Prepared {
  openclaw: string;
  target: string;
  rustc: string;
  oceRevision: string;
  runtimeImage: string;
  sha256: Record<string, string>;
}
const here = dirname(fileURLToPath(import.meta.url));
const inputs = {
  upstream: "1ad7e987af6db807d66d896600c76a7d8d100b32",
  container: "05efc455d65dfea67734f5cb71ca27b0ff5e9582",
  stdin: "aa1b8e419cf0deaad25113ab68d45451fef05450",
  mergeBase: "069c39cfd29f830aaadd2a1af362753a57c7b202",
};
const trees = {
  candidate: "57c4375a447f16f7b281cf0f4c590c351965af3a",
  baseline: "7cafba29bdc8cb7db1b2db9512bb2a4bd0c15d20",
};
const openclaw = "f8386bc7df0a6c9eda7a28ae81943c5c06a414ff";
const target = "aarch64-unknown-linux-gnu";
const binaries = ["strands-box", "strands-box-sock-alias", "strands-box-contain-trampoline"];
const bridges = [
  "inner.mjs",
  "outer.mjs",
  "proxy-preload.mjs",
  "readiness.mjs",
  "supervisor.mjs",
  "transport.mjs",
];
const files = [...binaries, ...bridges.map((name) => `bridge/${name}`)];
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const run = (command: string, args: string[], cwd = process.cwd()) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
const git = (cwd: string, ...args: string[]) => run("git", args, cwd).toString().trim();
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const save = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function hashFile(path: string) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = readSync(fd, buffer)) > 0) {
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function immutable(image: string | undefined) {
  assert.match(
    image ?? "",
    /^[^\s@]+@sha256:[a-f0-9]{64}$/,
    "use an immutable image reference with @sha256 digest",
  );
}
function currentUid(): number {
  assert.ok(process.geteuid, "file verification requires POSIX ownership information");
  return process.geteuid();
}
function regular(path: string, mode?: number, owner = currentUid()) {
  // O_NOFOLLOW protects the leaf. Ancestors belong to the trusted build tree
  // (or the root-owned image /opt tree); this is not an untrusted-path resolver.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile(), `not a regular file: ${path}`);
    assert.equal(stat.uid, owner, `${path}: unexpected file owner`);
    if (mode !== undefined) {
      assert.equal(stat.mode & 0o777, mode, `${path}: installed mode mismatch`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function executable(bytes: Buffer, name: string) {
  assert.ok(
    bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])),
    `${name}: expected ELF executable`,
  );
  assert.ok(
    bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === 183 &&
      [2, 3].includes(bytes.readUInt16LE(16)),
    `${name}: expected 64-bit little-endian AArch64 executable`,
  );
}
function clean(repo: string) {
  assert.equal(
    git(repo, "status", "--porcelain", "--untracked-files=all"),
    "",
    `source must be clean: ${repo}`,
  );
}
function verifySource(source: string, expected: string) {
  assert.ok(
    Object.values(trees).includes(expected),
    "expected tree must be a pinned baseline or candidate",
  );
  assert.equal(
    git(source, "rev-parse", "HEAD^{tree}"),
    expected,
    "Box tree mismatch; refusing compilation",
  );
  clean(source);
}
function prepare(options: Options) {
  const out = resolve(option(options, "out"));
  const variant = options.variant ?? "candidate";
  assert.ok(
    variant === "candidate" || variant === "baseline",
    "variant must be candidate or baseline",
  );
  const expected = options["expected-tree"] ?? trees[variant];
  mkdirSync(out); // Never reuse or modify another checkout.
  const source = join(out, "source");
  assert.ok(
    lstatSync(option(options, "source")).isDirectory(),
    "source must be a local Git repository",
  );
  run("git", [
    "clone",
    "--no-hardlinks",
    "--no-checkout",
    resolve(option(options, "source")),
    source,
  ]);
  for (const commit of Object.values(inputs)) {
    git(source, "cat-file", "-e", `${commit}^{commit}`);
  }
  assert.equal(git(source, "merge-base", inputs.container, inputs.stdin), inputs.mergeBase);
  const delta = run(
    "git",
    ["diff", "--full-index", "--binary", inputs.mergeBase, inputs.stdin],
    source,
  );
  const patch = join(out, "stdin.patch");
  writeFileSync(patch, delta);
  const first =
    variant === "baseline"
      ? inputs.container
      : git(source, "merge-tree", "--write-tree", inputs.upstream, inputs.container);
  git(source, "read-tree", first);
  git(source, "apply", "--cached", "--3way", patch);
  const tree = git(source, "write-tree");
  assert.equal(tree, expected, "Box tree mismatch; refusing compilation");
  assert.equal(tree, trees[variant], "composition must match the pinned variant");
  const commit = git(
    source,
    "-c",
    "user.name=Box build",
    "-c",
    "user.email=box-build@example.invalid",
    "commit-tree",
    tree,
    "-m",
    `Prepared Box ${variant}`,
  );
  git(source, "checkout", "--detach", "--force", commit);
  verifySource(source, expected);
  save(join(out, "source.json"), { inputs, variant, tree });
  console.log(`Prepared ${variant} ${tree} in ${source}`);
}
function verify(directory: string, installed = false, recordSha256?: string) {
  const recordBytes = regular(
    join(directory, "build-record.json"),
    installed ? 0o444 : undefined,
    installed ? 0 : currentUid(),
  );
  if (installed) {
    assert.equal(sha(recordBytes), recordSha256, "build record digest mismatch");
  }
  const record = JSON.parse(recordBytes.toString()) as BuildRecord;
  if (!installed) {
    assert.deepEqual(
      readdirSync(join(directory, "bridge")).sort(),
      [...bridges].sort(),
      "unrecorded bridge files",
    );
  }
  assert.deepEqual(record.inputs, inputs);
  assert.equal(record.tree, trees[record.variant], "unrecognized Box tree");
  assert.ok(record.tree, "missing Box tree");
  assert.equal(record.target, target);
  assert.equal(record.openclaw, openclaw);
  assert.match(record.oceRevision, /^[a-f0-9]{40}$/);
  assert.match(record.rustc, /^rustc 1\.98\.1 /);
  immutable(record.runtimeImage);
  assert.deepEqual(
    Object.keys(record.sha256).sort(),
    [...files].sort(),
    "artifact inventory mismatch",
  );
  for (const name of files) {
    const path =
      installed && name.startsWith("bridge/")
        ? join("/opt/oce/strands-box", name.slice(7))
        : join(directory, name);
    const bytes = regular(
      path,
      installed ? (binaries.includes(name) ? 0o555 : 0o444) : undefined,
      installed ? 0 : currentUid(),
    );
    assert.equal(sha(bytes), record.sha256[name], `${name}: SHA-256 mismatch`);
    if (binaries.includes(name)) {
      executable(bytes, name);
    }
  }
  return record;
}
function build(options: Options) {
  const out = resolve(option(options, "out"));
  const source = join(out, "source");
  const prepared = json<Prepared>(join(out, "source.json"));
  assert.deepEqual(prepared.inputs, inputs);
  assert.equal(prepared.tree, trees[prepared.variant]);
  verifySource(source, options["expected-tree"] ?? prepared.tree);
  assert.ok(
    platform() === "linux" && arch() === "arm64",
    "native compilation requires Linux ARM64; preparation is supported on this host",
  );
  immutable(options["runtime-image"]);
  const oce = git(here, "rev-parse", "--show-toplevel");
  clean(oce);
  const base = JSON.parse(
    run("docker", ["image", "inspect", option(options, "runtime-image")]).toString(),
  )[0];
  assert.equal(base.Os, "linux");
  assert.equal(base.Architecture, "arm64");
  assert.equal(
    base.Config.Labels["org.openclaw.image.revision"],
    openclaw,
    "base must preserve the comparison OpenClaw revision and patch set",
  );
  assert.match(readFileSync(join(source, "rust-toolchain.toml"), "utf8"), /channel = "1\.98\.1"/);
  const rustcPath = run("rustup", ["which", "--toolchain", "1.98.1", "rustc"]).toString().trim();
  const rustc = run(rustcPath, ["-vV"], source).toString().trim();
  assert.ok(rustc.includes(`host: ${target}`), "Rust host must match the native GNU ARM64 target");
  const artifacts = join(out, "artifacts");
  mkdirSync(artifacts);
  mkdirSync(join(artifacts, "bridge"));
  // Explicit target and target-dir override ambient Cargo target configuration.
  const targetDir = join(out, "target");
  execFileSync(
    "cargo",
    [
      "+1.98.1",
      "build",
      "--locked",
      "--release",
      "--workspace",
      "--bins",
      "--target",
      target,
      "--target-dir",
      targetDir,
    ],
    {
      cwd: source,
      stdio: "inherit",
      env: {
        ...process.env,
        RUSTUP_AUTO_INSTALL: "0",
        RUSTC: rustcPath,
        RUSTC_WRAPPER: "",
        RUSTC_WORKSPACE_WRAPPER: "",
      },
    },
  );
  verifySource(source, prepared.tree);
  clean(oce);
  for (const name of binaries) {
    const path = join(targetDir, target, "release", name);
    executable(regular(path), name);
    copyFileSync(path, join(artifacts, name));
    chmodSync(join(artifacts, name), 0o555);
  }
  for (const name of bridges) {
    copyFileSync(join(here, name), join(artifacts, "bridge", name));
    chmodSync(join(artifacts, "bridge", name), 0o444);
  }
  const hashes = Object.fromEntries(
    files.map((name) => [name, sha(regular(join(artifacts, name)))]),
  );
  save(join(artifacts, "build-record.json"), {
    ...prepared,
    openclaw,
    target,
    rustc,
    oceRevision: git(oce, "rev-parse", "HEAD"),
    runtimeImage: option(options, "runtime-image"),
    sha256: hashes,
  });
  copyFileSync(join(here, "build.ts"), join(artifacts, "build.ts"));
  verify(artifacts);
  console.log(`Built and verified ${artifacts}`);
}
function packageImage(options: Options) {
  const artifacts = resolve(option(options, "artifacts"));
  const record = verify(artifacts);
  assert.equal(
    sha(regular(join(artifacts, "build.ts"))),
    sha(regular(join(here, "build.ts"))),
    "use the verifier from this OCE checkout",
  );
  const oce = git(here, "rev-parse", "--show-toplevel");
  clean(oce);
  assert.equal(
    git(oce, "rev-parse", "HEAD"),
    record.oceRevision,
    "package from the OCE revision that built these artifacts",
  );
  const out = resolve(option(options, "out"));
  mkdirSync(out);
  const metadata = join(out, "metadata.json");
  execFileSync(
    "docker",
    [
      "buildx",
      "build",
      "--platform",
      "linux/arm64",
      "--provenance=false",
      "--file",
      join(here, "Dockerfile"),
      "--build-arg",
      `OCE_RUNTIME_IMAGE=${record.runtimeImage}`,
      "--build-arg",
      `BUILD_RECORD_SHA256=${sha(regular(join(artifacts, "build-record.json")))}`,
      "--metadata-file",
      metadata,
      "--output",
      `type=oci,dest=${join(out, "image.tar")}`,
      artifacts,
    ],
    { stdio: "inherit" },
  );
  recordImage({ artifacts, archive: join(out, "image.tar"), out }, true);
}
function recordImage(options: Options, packaging = false) {
  const artifacts = resolve(option(options, "artifacts"));
  const record = verify(artifacts);
  const out = resolve(option(options, "out"));
  if (!packaging) {
    mkdirSync(out);
  }
  const archive = resolve(option(options, "archive"));
  // The OCI archive is inspectable without publishing or starting a container.
  const index = JSON.parse(run("tar", ["-xOf", archive, "index.json"]).toString());
  assert.equal(index.manifests.length, 1, "expected one image descriptor");
  const descriptor = index.manifests[0];
  assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
  const manifest = run("tar", ["-xOf", archive, `blobs/sha256/${descriptor.digest.slice(7)}`]);
  assert.equal(`sha256:${sha(manifest)}`, descriptor.digest, "OCI manifest digest mismatch");
  const parsed = JSON.parse(manifest.toString());
  assert.ok(Array.isArray(parsed.layers), "expected a single platform manifest, not an index");
  assert.ok(parsed.layers.length > 0, "zero-layer images cannot contain the Box payload");
  assert.match(parsed.config.digest, /^sha256:[a-f0-9]{64}$/);
  const config = run("tar", ["-xOf", archive, `blobs/sha256/${parsed.config.digest.slice(7)}`]);
  assert.equal(`sha256:${sha(config)}`, parsed.config.digest, "OCI config digest mismatch");
  const imageConfig = JSON.parse(config.toString());
  assert.equal(imageConfig.architecture, "arm64");
  assert.equal(imageConfig.os, "linux");
  assert.equal(
    imageConfig.config.Labels["org.strands-box.build-record-sha256"],
    hashFile(join(artifacts, "build-record.json")),
    "image build-record label mismatch",
  );
  if (packaging) {
    assert.equal(
      json<Record<string, string>>(join(out, "metadata.json"))["containerimage.digest"],
      descriptor.digest,
    );
  }
  writeFileSync(join(out, "manifest.json"), manifest, { flag: "wx" });
  save(join(out, "image-record.json"), {
    verification: "identity-only; installed payload verification is required by QA",
    manifestDigest: descriptor.digest,
    configDigest: parsed.config.digest,
    buildRecordSha256: sha(regular(join(artifacts, "build-record.json"))),
    archiveSha256: hashFile(archive),
    oceRevision: record.oceRevision,
  });
  console.log(
    `Recorded identity ${descriptor.digest}; see ${out}/image-record.json. Payload remains unverified until installed QA. No image was published.`,
  );
}
const usage = `Usage: node deploy/runtime/strands-box/build.ts COMMAND [OPTIONS]
  prepare --source LOCAL_GIT_REPOSITORY --out NEW_DIRECTORY [--variant candidate|baseline] [--expected-tree SHA]
  build --out PREPARED_DIRECTORY --runtime-image IMAGE@sha256:DIGEST [--expected-tree SHA]
  verify --artifacts ARTIFACT_DIRECTORY
  package --artifacts ARTIFACT_DIRECTORY --out NEW_IMAGE_DIRECTORY
  record-image --artifacts ARTIFACT_DIRECTORY --archive FINAL_OCI_TAR --out NEW_RECEIPT_DIRECTORY
Preparation needs a local repository containing all pinned commits; it never fetches.
Build requires a clean OCE checkout, native Linux ARM64, Rust 1.98.1 and a locally available matching runtime image.
Package writes a local OCI archive and external digest record; it never publishes.`;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
    args[0] = "help";
  }
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "source",
        "out",
        "variant",
        "expected-tree",
        "runtime-image",
        "artifacts",
        "archive",
        "record-sha256",
      ].map((name) => [name, { type: "string" as const }]),
    ),
  });
  assert.equal(positionals.length, 1, usage);
  const required: Record<string, (keyof Options)[]> = {
    prepare: ["source", "out"],
    build: ["out"],
    verify: ["artifacts"],
    package: ["artifacts", "out"],
    "record-image": ["artifacts", "archive", "out"],
  };
  for (const name of required[positionals[0] ?? ""] ?? []) {
    assert.ok(values[name], `--${name} is required\n${usage}`);
  }
  switch (positionals[0]) {
    case "help":
      console.log(usage);
      break;
    case "prepare":
      prepare(values);
      break;
    case "build":
      build(values);
      break;
    case "verify":
      verify(resolve(option(values, "artifacts")));
      console.log("Artifacts verified");
      break;
    case "verify-installed":
      assert.equal(
        verify(here, true, values["record-sha256"]).runtimeImage,
        values["runtime-image"],
        "runtime base differs from build record",
      );
      break;
    case "package":
      packageImage(values);
      break;
    case "record-image":
      recordImage(values);
      break;
    default:
      throw new Error(usage);
  }
} catch (error) {
  console.error(`Box build: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
