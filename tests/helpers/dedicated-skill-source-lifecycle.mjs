import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

// Callers use a real Gateway and a separate Harness; file reads are independent
// observations, not replacements for the Gateway -> paired-node publication path.
export async function assertDedicatedSkillSourceLifecycle({
  callGateway,
  readHarnessFile,
  readGatewayFile,
  withNodeWritesDenied,
  slug = `source-lifecycle-${randomUUID()}`,
}) {
  const directory = await mkdtemp(join(tmpdir(), "oce-skill-source-"));
  const target = `/home/node/workspace/skills/${slug}`;
  const sourcePath = `${target}/SKILL.md`;
  const lockPaths = [".clawhub", ".clawdhub"].map(
    (directory) => `/home/node/workspace/${directory}/lock.json`,
  );
  const content = (version) =>
    `---\nname: ${slug}\ndescription: Verify dedicated Skill source version ${version}.\n---\nReturn SOURCE_VERSION_${version}.\n`;
  async function install(version, force) {
    await writeFile(join(directory, "SKILL.md"), content(version));
    const archivePath = join(directory, "source.zip");
    await rm(archivePath, { force: true });
    await executeFile("zip", ["-q", archivePath, "SKILL.md"], {
      cwd: directory,
      timeout: 10_000,
    });
    const archive = await readFile(archivePath);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const { uploadId } = await callGateway("skills.upload.begin", {
      kind: "skill-archive",
      slug,
      sizeBytes: archive.length,
      sha256,
      force,
    });
    assert.equal(typeof uploadId, "string");
    await callGateway("skills.upload.chunk", {
      uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await callGateway("skills.upload.commit", { uploadId, sha256 });
    const installed = await callGateway("skills.install", {
      agentId: "main",
      source: "upload",
      slug,
      uploadId,
      sha256,
      force,
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.targetDir, target);
    assert.equal(installed.sha256, sha256);
  }
  async function assertInstalled(version) {
    assert.equal(await readHarnessFile(sourcePath), content(version));
    assert.equal(await readGatewayFile(sourcePath), null, "source belongs to the Harness");
    const status = await callGateway("skills.status", { agentId: "main" });
    assert.ok(status.skills.some((skill) => skill.name === slug && skill.filePath === sourcePath));
  }
  try {
    await install(1, false);
    await assertInstalled(1);
    await install(2, true);
    await assertInstalled(2);
    // Uploads do not create ClawHub tracking. Preserve any existing registry installs.
    const previousLocks = await Promise.all(lockPaths.map(readHarnessFile));
    await withNodeWritesDenied(async () => {
      await assert.rejects(
        () => install(3, true),
        /Workspace worker requires an existing file grant/u,
      );
      assert.equal(await readHarnessFile(sourcePath), content(2));
      assert.deepEqual(await Promise.all(lockPaths.map(readHarnessFile)), previousLocks);
      assert.equal(await readGatewayFile(sourcePath), null);
    });
    // Restored policy must permit a subsequent operation on the same retained workspace.
    await install(3, true);
    await assertInstalled(3);
    return { slug, sourcePath, lockPaths };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
