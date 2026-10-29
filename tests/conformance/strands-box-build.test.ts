import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  strandsPayloadProbe,
  verifyPayloadFiles,
} from "../../deploy/runtime/strands-box/payload.ts";
import {
  strandsImageIdentity,
  assertStrandsRunningImage,
  replacementRuntimePods,
} from "../helpers/qa-strands-image.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "box-build-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("Box packaging refuses changed, absent, symlinked and non-ARM64 artifacts before Docker", async (t) => {
  const path = await directory(t);
  await mkdir(join(path, "bridge"));
  // Synthetic ELF headers exercise package validation, not compilation or runtime proof.
  const elf = Buffer.alloc(64);
  elf.set([127, 69, 76, 70, 2, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(183, 18);
  const record = {
    inputs: {
      upstream: "1ad7e987af6db807d66d896600c76a7d8d100b32",
      container: "05efc455d65dfea67734f5cb71ca27b0ff5e9582",
      stdin: "aa1b8e419cf0deaad25113ab68d45451fef05450",
      mergeBase: "069c39cfd29f830aaadd2a1af362753a57c7b202",
    },
    variant: "candidate",
    tree: "57c4375a447f16f7b281cf0f4c590c351965af3a",
    openclaw: "f8386bc7df0a6c9eda7a28ae81943c5c06a414ff",
    oceRevision: "c7d00d7486a91de8e40d47573ec7d78fbec8690d",
    rustc: "rustc 1.98.1 (synthetic package fixture)",
    target: "aarch64-unknown-linux-gnu",
    runtimeImage: `example.invalid/runtime@sha256:${"a".repeat(64)}`,
    sha256: {} as Record<string, string>,
  };
  const names = ["strands-box", "strands-box-sock-alias", "strands-box-contain-trampoline"];
  for (const name of names) {
    await writeFile(join(path, name), elf);
    record.sha256[name] = hash(elf);
  }
  for (const name of ["inner", "outer", "proxy-preload", "readiness", "supervisor", "transport"]) {
    const file = `bridge/${name}.mjs`;
    await writeFile(join(path, file), "// synthetic bridge\n");
    record.sha256[file] = hash("// synthetic bridge\n");
  }
  const save = () => writeFile(join(path, "build-record.json"), JSON.stringify(record));
  await save();
  const invoke = (command: string) =>
    spawnSync(
      process.execPath,
      [
        resolve("deploy/runtime/strands-box/build.ts"),
        command,
        "--artifacts",
        path,
        ...(command === "package" ? ["--out", join(path, "image")] : []),
      ],
      {
        encoding: "utf8",
        // A successful negative test cannot depend on an installed Docker client.
        env: { ...process.env, PATH: path },
      },
    );
  assert.equal(invoke("verify").status, 0);
  const probe = strandsPayloadProbe(await readFile(join(path, "build-record.json")));
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: probe.script,
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const payloadPath = join(path, "strands-box");
  await chmod(payloadPath, 0o555);
  const installed = [{ path: payloadPath, sha256: hash(elf), mode: 0o555 }];
  verifyPayloadFiles(installed);
  await chmod(payloadPath, 0o755);
  await writeFile(payloadPath, "later layer replaced the executable");
  await chmod(payloadPath, 0o555);
  assert.throws(() => verifyPayloadFiles(installed), /installed SHA-256 mismatch/u);
  await chmod(payloadPath, 0o755);
  await writeFile(payloadPath, elf);
  await chmod(payloadPath, 0o555);
  verifyPayloadFiles(installed);

  await t.test("offline OCI receipts verify the manifest and build-record digest", async () => {
    const layout = await directory(t);
    await mkdir(join(layout, "blobs/sha256"), { recursive: true });
    const config = JSON.stringify({
      architecture: "arm64",
      os: "linux",
      config: {
        Labels: {
          "org.strands-box.build-record-sha256": hash(
            await readFile(join(path, "build-record.json")),
          ),
        },
      },
    });
    const manifest = JSON.stringify({
      schemaVersion: 2,
      config: { digest: `sha256:${hash(config)}` },
      layers: [],
    });
    await writeFile(join(layout, "blobs/sha256", hash(config)), config);
    const manifestPath = join(layout, "blobs/sha256", hash(manifest));
    await writeFile(manifestPath, manifest);
    await writeFile(
      join(layout, "index.json"),
      JSON.stringify({ manifests: [{ digest: `sha256:${hash(manifest)}` }] }),
    );
    const archive = join(layout, "image.tar");
    const pack = () => {
      const packed = spawnSync("tar", ["-cf", archive, "-C", layout, "index.json", "blobs"], {
        encoding: "utf8",
      });
      assert.equal(packed.status, 0, packed.stderr);
    };
    const receipt = join(layout, "receipt");
    const recordImage = (out: string) =>
      spawnSync(
        process.execPath,
        [
          resolve("deploy/runtime/strands-box/build.ts"),
          "record-image",
          "--artifacts",
          path,
          "--archive",
          archive,
          "--out",
          out,
        ],
        { encoding: "utf8" },
      );
    pack();
    const empty = recordImage(join(layout, "empty-receipt"));
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /zero-layer images cannot contain the Box payload/u);
    const nonemptyManifest = JSON.stringify({
      schemaVersion: 2,
      config: { digest: `sha256:${hash(config)}` },
      layers: [{ digest: `sha256:${hash("payload placeholder")}` }],
    });
    await writeFile(join(layout, "blobs/sha256", hash(nonemptyManifest)), nonemptyManifest);
    await writeFile(
      join(layout, "index.json"),
      JSON.stringify({ manifests: [{ digest: `sha256:${hash(nonemptyManifest)}` }] }),
    );
    pack();
    const accepted = recordImage(receipt);
    assert.equal(accepted.status, 0, accepted.stderr);
    const observed = JSON.parse(await readFile(join(receipt, "image-record.json"), "utf8"));
    assert.equal(observed.manifestDigest, `sha256:${hash(nonemptyManifest)}`);
    assert.match(observed.verification, /identity-only/u);
    assert.equal(observed.buildRecordSha256, hash(await readFile(join(path, "build-record.json"))));
    await writeFile(join(layout, "blobs/sha256", hash(nonemptyManifest)), nonemptyManifest + " ");
    pack();
    const rejected = recordImage(join(layout, "wrong-receipt"));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /OCI manifest digest mismatch/u);
  });
  await writeFile(join(path, "bridge/unrecorded.mjs"), "// extra");
  const extra = invoke("package");
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /unrecorded bridge files/u);
  await rm(join(path, "bridge/unrecorded.mjs"));
  await writeFile(join(path, "bridge/inner.mjs"), "substituted");
  let result = invoke("package");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inner\.mjs: SHA-256 mismatch/u);
  await writeFile(join(path, "bridge/inner.mjs"), "// synthetic bridge\n");
  const wrongArchitecture = Buffer.from(elf);
  wrongArchitecture.writeUInt16LE(62, 18);
  await chmod(join(path, names[0]!), 0o755);
  await writeFile(join(path, names[0]!), wrongArchitecture);
  record.sha256[names[0]!] = hash(wrongArchitecture);
  await save();
  result = invoke("package");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected 64-bit little-endian AArch64 executable/u);
  await rm(join(path, names[0]!));
  result = invoke("package");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/u);
  await symlink(join(path, names[1]!), join(path, names[0]!));
  result = invoke("package");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular file/u);
});

test("Strands QA requires a running image and verifies index-to-ARM64 manifest mapping", async (t) => {
  const path = await directory(t);
  const configDigest = `sha256:${"b".repeat(64)}`;
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: configDigest },
    layers: [],
  });
  const manifestDigest = `sha256:${hash(manifest)}`;
  const index = JSON.stringify({
    manifests: [
      { digest: `sha256:${"c".repeat(64)}`, platform: { os: "linux", architecture: "amd64" } },
      { digest: manifestDigest, platform: { os: "linux", architecture: "arm64" } },
    ],
  });
  const fixture = {
    runtimeImage: `example.invalid/runtime@sha256:${hash(index)}`,
    runtimeImageIndexFile: join(path, "index.json"),
    runtimeImageManifestFile: join(path, "manifest.json"),
  };
  await writeFile(fixture.runtimeImageIndexFile, index);
  await writeFile(fixture.runtimeImageManifestFile, manifest);
  const identity = await strandsImageIdentity(fixture);
  const container = { name: "box" };
  const status: {
    name: string;
    state: { running?: object; terminated?: object };
    imageID?: string;
  } = {
    name: "box",
    state: { running: {} },
    imageID: `example.invalid/runtime@${manifestDigest}`,
  };
  const pod = { metadata: { name: "agent" }, status: { containerStatuses: [status] } };
  assert.equal(assertStrandsRunningImage(pod, container, identity), status.imageID);
  status.imageID = `containerd://${configDigest}`;
  assert.equal(assertStrandsRunningImage(pod, container, identity), status.imageID);
  delete status.imageID;
  assert.throws(
    () => assertStrandsRunningImage(pod, container, identity),
    /running image ID is absent/u,
  );
  status.imageID = "";
  assert.throws(
    () => assertStrandsRunningImage(pod, container, identity),
    /running image ID is empty/u,
  );
  status.imageID = fixture.runtimeImage;
  assert.throws(
    () => assertStrandsRunningImage(pod, container, identity),
    /does not match the selected ARM64/u,
  );
  const direct = await strandsImageIdentity({
    runtimeImage: `example.invalid/runtime@${manifestDigest}`,
  });
  status.imageID = `docker-pullable://example.invalid/runtime@${manifestDigest}`;
  assert.equal(assertStrandsRunningImage(pod, container, direct), status.imageID);
  status.state = { terminated: {} };
  assert.throws(
    () => assertStrandsRunningImage(pod, container, direct),
    /container is not running/u,
  );
  await writeFile(
    fixture.runtimeImageManifestFile,
    (await readFile(fixture.runtimeImageManifestFile)) + " ",
  );
  await assert.rejects(strandsImageIdentity(fixture), /manifest digest mismatch/u);
  await writeFile(fixture.runtimeImageIndexFile, index + " ");
  await assert.rejects(strandsImageIdentity(fixture), /index digest mismatch/u);
});

test("replacement observation tolerates a terminating predecessor but rejects active duplicates", () => {
  const pod = (name: string, uid: string, role: string, deletionTimestamp?: string) => ({
    metadata: {
      name,
      uid,
      labels: { "openclaw.dev/workload-role": role },
      ...(deletionTimestamp ? { deletionTimestamp } : {}),
    },
  });
  const old = pod("old", "old-uid", "agent", "2026-10-29T00:00:00Z");
  const replacement = pod("new", "new-uid", "agent");
  const gateway = pod("gateway", "gateway-uid", "gateway");
  assert.deepEqual(replacementRuntimePods([old, replacement, gateway], replacement), [
    replacement,
    gateway,
  ]);
  assert.throws(
    () =>
      replacementRuntimePods([pod("old", "old-uid", "agent"), replacement, gateway], replacement),
    /exactly two active/u,
  );
  assert.throws(
    () =>
      replacementRuntimePods(
        [replacement, gateway, pod("duplicate", "extra", "gateway")],
        replacement,
      ),
    /exactly two active/u,
  );
  assert.throws(
    () => replacementRuntimePods([old, pod("new", "different-uid", "agent"), gateway], replacement),
    /replacement Pod is no longer active/u,
  );
});
