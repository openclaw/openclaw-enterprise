import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Script } from "node:vm";
import {
  COMPUTE_AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const require = createRequire(import.meta.url);

// Execute the actual emitted asset initialization definitions, before startup can
// open listeners or run child processes. No production-only export is needed.
function publisher(home: string, io: object = fs, entrypoint = COMPUTE_AGENT_WITH_NODE_ENTRYPOINT) {
  const end = entrypoint.indexOf("\nconst startupPhaseOrigin =");
  assert.ok(end > 0);
  return new Script(`${entrypoint.slice(0, end)}\npublishImageTree;`).runInNewContext({
    require: (name: string) => (name === "node:fs" ? io : require(name)),
    process: { env: { HOME: home } },
    Buffer,
  }) as (source: string, destination: string, required: boolean) => void;
}

function directory(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "runtime-assets-"));
  t.after(() => {
    // Fixtures include read-only directories; restore only this test's own tree.
    function writable(path: string) {
      fs.chmodSync(path, 0o700);
      for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          writable(join(path, entry.name));
        }
      }
    }
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("runtime assets copy bytes, modes and links when filesystem copy acceleration is unavailable", (t) => {
  const home = directory(t);
  const source = join(home, "image");
  const destination = join(home, "published");
  fs.mkdirSync(join(source, "nested"), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 131_105 }, (_, index) => index % 251));
  fs.writeFileSync(join(source, "executable.bin"), bytes);
  fs.chmodSync(join(source, "executable.bin"), 0o755);
  fs.writeFileSync(join(source, "empty"), "");
  execFileSync("mkfifo", [join(source, "pipe")]);
  fs.writeFileSync(join(source, "nested", "readme"), "read-only source\n");
  fs.chmodSync(join(source, "nested", "readme"), 0o444);
  fs.chmodSync(join(source, "nested"), 0o555);
  for (const [name, target] of [
    ["relative", "executable.bin"],
    ["absolute", join(source, "executable.bin")],
    ["directory", "nested"],
    ["dangling", "missing"],
  ] as const) {
    fs.symlinkSync(target, join(source, name));
  }
  fs.symlinkSync(source, join(home, "image-alias"));
  fs.symlinkSync("../image-alias/executable.bin", join(source, "alias-target"));
  fs.symlinkSync("../image-alias/missing", join(source, "dangling-alias"));
  fs.symlinkSync("../image-alias/executable.bin/child", join(source, "non-directory-prefix"));
  fs.symlinkSync("../image-alias/nested/../missing/child", join(source, "missing-suffix"));
  fs.symlinkSync("executable.bin/", join(source, "file-as-directory"));
  fs.symlinkSync("missing/.", join(source, "missing-directory"));
  fs.symlinkSync("missing/child/..", join(source, "missing-parent"));
  fs.symlinkSync("nested/", join(source, "existing-directory"));
  fs.mkdirSync(destination);
  fs.chmodSync(destination, 0o751);
  fs.writeFileSync(join(destination, "stale"), "old publication");
  const legacy = join(home, "legacy-copy");
  fs.cpSync(source, legacy, { recursive: true });

  // Model the measured unsupported copy primitive, not the copy result. Real
  // reads/writes still produce the destination, including short writes.
  const io = {
    ...fs,
    cpSync(from: string, to: string, options?: fs.CopySyncOptions) {
      if (!fs.lstatSync(from).isSymbolicLink()) {
        throw Object.assign(new Error("copy acceleration unavailable"), { code: "EPERM" });
      }
      return fs.cpSync(from, to, options);
    },
    copyFileSync() {
      throw Object.assign(new Error("copy acceleration unavailable"), { code: "EPERM" });
    },
    writeSync(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      return fs.writeSync(fd, buffer, offset, Math.min(length, 1137), position);
    },
  };
  const publish = publisher(home, io);
  publish(source, destination, true);
  assert.deepEqual(fs.readFileSync(join(destination, "executable.bin")), bytes);
  assert.equal(fs.statSync(join(destination, "empty")).size, 0);
  assert.equal(fs.statSync(join(destination, "executable.bin")).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(join(destination, "nested")).mode & 0o7777, 0o555);
  assert.equal(fs.statSync(join(destination, "nested", "readme")).mode & 0o7777, 0o444);
  assert.equal(
    fs.readFileSync(join(destination, "nested", "readme"), "utf8"),
    "read-only source\n",
  );
  assert.equal(fs.statSync(destination).mode & 0o7777, 0o751);
  assert.equal(fs.existsSync(join(destination, "stale")), false);
  assert.equal(fs.lstatSync(join(legacy, "pipe"), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(join(destination, "pipe"), { throwIfNoEntry: false }), undefined);
  for (const [name, target] of [
    ["relative", "executable.bin"],
    ["absolute", "executable.bin"],
    ["directory", "nested"],
    ["dangling", "missing"],
    ["alias-target", "executable.bin"],
    ["dangling-alias", "missing"],
    ["non-directory-prefix", "executable.bin/child"],
    ["missing-suffix", "missing/child"],
    ["file-as-directory", "executable.bin/"],
    ["missing-directory", "missing/"],
    ["missing-parent", "missing/"],
    ["existing-directory", "nested"],
  ] as const) {
    assert.equal(fs.lstatSync(join(destination, name)).isSymbolicLink(), true);
    const legacyTarget = fs.readlinkSync(join(legacy, name));
    assert.equal(legacyTarget, join(source, target));
    assert.equal(fs.readlinkSync(join(destination, name)), legacyTarget);
  }
  assert.throws(() => fs.statSync(join(destination, "file-as-directory")), { code: "ENOTDIR" });
  assert.deepEqual(fs.readFileSync(join(source, "executable.bin")), bytes);
  assert.equal(fs.statSync(join(source, "nested")).mode & 0o7777, 0o555);

  // The same definitions also run in Gateway and native-worker prefixes, which
  // have different imports. Exercise a nested copy from each emitted consumer.
  for (const [name, entrypoint] of [
    ["gateway", GATEWAY_RUNTIME_ENTRYPOINT],
    ["native", NATIVE_WORKER_ENTRYPOINT],
  ] as const) {
    const target = join(home, name);
    publisher(home, io, entrypoint)(source, target, true);
    assert.deepEqual(fs.readFileSync(join(target, "executable.bin")), bytes);
    assert.equal(fs.statSync(join(target, "nested")).mode & 0o7777, 0o555);
  }

  const optional = join(home, "optional");
  fs.mkdirSync(optional);
  fs.writeFileSync(join(optional, "stale"), "old optional asset");
  publish(join(home, "missing"), optional, false);
  assert.deepEqual(fs.readdirSync(optional), []);
  assert.throws(
    () => publish(join(home, "missing"), optional, true),
    /Required runtime asset tree is missing/,
  );
  assert.throws(() => publish(optional, destination, true), /Required runtime asset tree is empty/);
});

test("runtime asset publication refuses a destination symlink before clearing its target", (t) => {
  const home = directory(t);
  const source = join(home, "image");
  const destination = join(home, "openclaw-runtime-assets", "bundled-skills");
  const target = join(home, "existing-directory");
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, "asset"), "new publication");
  fs.mkdirSync(join(destination, ".."));
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, "sentinel"), "keep this file");
  fs.symlinkSync(target, destination);

  // Run the emitted supervisor through its startup call. Map only image paths
  // into the fixture and stop before the supervisor starts its child processes.
  const startupCall = "\ninitializeRuntimeAssets();";
  const start = COMPUTE_AGENT_WITH_NODE_ENTRYPOINT.indexOf(startupCall);
  assert.ok(start > 0);
  const startup = new Script(
    COMPUTE_AGENT_WITH_NODE_ENTRYPOINT.slice(0, start + startupCall.length)
      .replace('"/app/skills"', JSON.stringify(source))
      .replace('"/app/custodian-skills"', JSON.stringify(join(home, "missing-custodian")))
      .replace('"/app/plugin-skills"', JSON.stringify(join(home, "missing-plugin"))),
  );
  const env = {
    HOME: home,
    OPENCLAW_NODE_STATE_DIR: join(home, "state"),
    OPENCLAW_NODE_SETUP_PATH: join(home, "setup"),
  };
  const runStartup = () => startup.runInNewContext({ require, process: { env }, Buffer });

  assert.throws(runStartup, /destination is not a directory/);
  assert.throws(
    () => publisher(home)(join(home, "missing"), destination, false),
    /destination is not a directory/,
  );
  assert.equal(fs.readlinkSync(destination), target);
  assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
  assert.equal(fs.readFileSync(join(target, "sentinel"), "utf8"), "keep this file");

  fs.unlinkSync(destination);
  runStartup();
  assert.equal(fs.readFileSync(join(destination, "asset"), "utf8"), "new publication");
});

test("runtime asset copy keeps incomplete files private and preserves the first error", (t) => {
  for (const prefix of [0, 2, null]) {
    const home = directory(t);
    const source = join(home, "image");
    const destination = join(home, "published");
    fs.mkdirSync(source);
    fs.writeFileSync(join(source, "asset"), "asset content");
    fs.chmodSync(join(source, "asset"), 0o4751);
    const descriptors: number[] = [];
    const writeError = Object.assign(new Error("write failed"), { code: "EIO" });
    const closeError = new Error("close failed");
    let writes = 0;
    let outputPath = "";
    const io = {
      ...fs,
      openSync(path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = fs.openSync(path, flags, mode);
        descriptors.push(fd);
        if (flags === "wx") {
          outputPath = String(path);
        }
        return fd;
      },
      writeSync(
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ) {
        assert.equal(fs.existsSync(join(destination, "asset")), false);
        assert.equal(fs.statSync(join(outputPath, "..")).mode & 0o777, 0o700);
        if (prefix !== null && (prefix === 0 || writes > 0)) {
          throw writeError;
        }
        writes += 1;
        const count = prefix === null ? length : Math.min(prefix, length);
        return fs.writeSync(fd, buffer, offset, count, position);
      },
      closeSync(fd: number) {
        fs.closeSync(fd);
        throw closeError;
      },
    };
    assert.throws(
      () => publisher(home, io)(source, destination, true),
      (error) => error === (prefix === null ? closeError : writeError),
    );
    assert.equal(descriptors.length, 2);
    for (const fd of descriptors) {
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    }
    assert.deepEqual(fs.readdirSync(destination), []);
    assert.equal(fs.readFileSync(join(source, "asset"), "utf8"), "asset content");
    assert.equal(fs.statSync(join(source, "asset")).mode & 0o7777, 0o4751);
  }
});

test("ordinary runtime asset publication does not replace a competing symlink", (t) => {
  const home = directory(t);
  const source = join(home, "image");
  const destination = join(home, "published");
  const sentinel = join(home, "sentinel");
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, "asset"), "complete asset");
  fs.writeFileSync(sentinel, "preserved");
  const io = {
    ...fs,
    linkSync(staged: fs.PathLike, target: fs.PathLike) {
      assert.equal(fs.readFileSync(staged, "utf8"), "complete asset");
      fs.symlinkSync(sentinel, target);
      fs.linkSync(staged, target);
    },
  };
  assert.throws(() => publisher(home, io)(source, destination, true), { code: "EEXIST" });
  assert.equal(fs.readlinkSync(join(destination, "asset")), sentinel);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserved");
  assert.deepEqual(fs.readdirSync(destination), ["asset"]);
});

test("restricted native worker startup preserves baseline file contents and modes", (t) => {
  const home = directory(t);
  const image = join(home, "image");
  const skills = join(image, "skills");
  fs.mkdirSync(skills, { recursive: true });
  // Regular fixtures are copied, never executed. Native copy's set-ID behavior
  // depends on the writing identity and whether the file has content.
  const fixtures = [
    ["tool", 0o4751, "fixture tool"],
    ["ordinary", 0o644, "ordinary asset"],
    ["executable", 0o755, "executable asset"],
    ["setgid", 0o2751, "setgid asset"],
    ["sticky", 0o1751, "sticky asset"],
    ["setgid-without-exec", 0o2641, "non-executable group"],
    ["empty-setuid", 0o4751, ""],
  ] as const;
  for (const [name, mode, contents] of fixtures) {
    fs.writeFileSync(join(skills, name), contents);
    fs.chmodSync(join(skills, name), mode);
  }
  const legacy = join(home, "legacy-copy");
  fs.cpSync(skills, legacy, { recursive: true });

  const call = "\ninitializeRuntimeAssets();";
  const end = NATIVE_WORKER_ENTRYPOINT.indexOf(call);
  assert.ok(end > 0);
  const startup = NATIVE_WORKER_ENTRYPOINT.slice(0, end + call.length).replace(
    /"\/app\/(skills|custodian-skills|plugin-skills)"/g,
    (_, tree: string) => JSON.stringify(join(image, tree)),
  );
  const runStartup = (prelude = "") =>
    execFileSync(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${home}`,
        `--allow-fs-write=${home}`,
        "-e",
        `process.umask(0o077);\n${prelude}\n${startup}`,
      ],
      {
        stdio: "pipe",
        env: {
          HOME: home,
          TMPDIR: join(home, "tmp"),
          OPENCLAW_WORKSPACE_DIR: join(home, "workspace"),
          OPENCLAW_NODE_STATE_DIR: join(home, "node"),
          OPENCLAW_NODE_SETUP_CODE: "fixture",
          OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
          OPENCLAW_NATIVE_INFERENCE_CONFIG: "{}",
        },
      },
    );
  runStartup();
  const publishedDirectory = join(home, "openclaw-runtime-assets", "bundled-skills");
  for (const [name, mode, contents] of fixtures) {
    const publishedAsset = join(publishedDirectory, name);
    const publishedStat = fs.statSync(publishedAsset);
    assert.equal(fs.readFileSync(publishedAsset, "utf8"), contents);
    assert.equal(publishedStat.mode & 0o7777, fs.statSync(join(legacy, name)).mode & 0o7777);
    assert.equal(publishedStat.mode & 0o777, mode & 0o777);
    assert.equal(publishedStat.uid, fs.statSync(home).uid);
    assert.equal(publishedStat.gid, fs.statSync(home).gid);
    assert.equal(fs.readFileSync(join(skills, name), "utf8"), contents);
    assert.equal(fs.statSync(join(skills, name)).mode & 0o7777, mode);
  }

  // Keep one source for the independent exclusive-publication collision check.
  for (const [name] of fixtures) {
    if (name !== "tool") {
      fs.unlinkSync(join(skills, name));
    }
  }
  const published = join(publishedDirectory, "tool");
  // Install a competing destination entry immediately before exclusive publication.
  const sentinel = join(home, "sentinel");
  const pendingLink = join(home, "pending-link");
  fs.writeFileSync(sentinel, "keep", { mode: 0o600 });
  fs.symlinkSync(sentinel, pendingLink);
  const collision = `
    const io = require("node:fs");
    const link = io.linkSync;
    io.linkSync = (staged, destination) => {
      io.renameSync(${JSON.stringify(pendingLink)}, destination);
      link(staged, destination);
    };`;
  assert.throws(() => runStartup(collision), /EEXIST/);
  assert.equal(fs.readlinkSync(published), sentinel);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
  assert.equal(fs.statSync(sentinel).mode & 0o7777, 0o600);
  assert.deepEqual(fs.readdirSync(join(home, "openclaw-runtime-assets", "bundled-skills")), [
    "tool",
  ]);
});
