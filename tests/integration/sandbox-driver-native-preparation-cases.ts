import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import type { createOrphanedNativePreparation } from "./sandbox-driver-preparation-cases.ts";

type OrphanedNativePreparation = ReturnType<typeof createOrphanedNativePreparation>;
type PreparationDeployment = Awaited<ReturnType<OrphanedNativePreparation>>["deployment"];

function preparationManifest(deployment: PreparationDeployment) {
  const spec = deployment.spec?.template.spec;
  const container = spec?.containers[0];
  const program = container?.command?.[2];
  assert.ok(spec?.volumes);
  assert.ok(container?.volumeMounts);
  assert.ok(typeof program === "string");
  return { volumes: spec.volumes, volumeMounts: container.volumeMounts, program };
}

function volumeMount(mounts: ReturnType<typeof preparationManifest>["volumeMounts"], name: string) {
  const mount = mounts.find((entry) => entry.name === name);
  assert.ok(mount);
  return mount;
}

async function runNativePreparation(
  t: TestContext,
  program: string,
  directory: string,
): Promise<void> {
  const child = spawn(process.execPath, ["-e", program], {
    cwd: directory,
    env: { PATH: dirname(process.execPath) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    errors += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const stopDeadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  t.after(async () => {
    clearTimeout(stopDeadline);
    child.kill("SIGKILL");
    await exited;
  });
  const marker = join(directory, "preparation-status", "ready");
  for (;;) {
    assert.equal(child.exitCode, null, errors);
    assert.equal(child.signalCode, null, errors);
    const ready = await readFile(marker, "utf8").catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      return undefined;
    });
    if (ready !== undefined) {
      assert.equal(ready, "ready");
      break;
    }
    await delay(20);
  }
  // A preparer must acknowledge termination, rather than wait for Kubernetes to
  // force-kill it. The completion marker survives its successful shutdown.
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(await readFile(marker, "utf8"), "ready");
}

export function registerSandboxDriverNativePreparationCases(
  orphanedNativePreparation: OrphanedNativePreparation,
): void {
  test("OpenShell native preparation exits cleanly on SIGTERM after readiness", async (t) => {
    // Capture the production manifest through the existing transport fixture, then
    // execute its preparation process. Live Pod deletion is proved separately.
    const { deployment } = await orphanedNativePreparation({ scratch: true });
    const { volumes, volumeMounts, program: command } = preparationManifest(deployment);
    const directory = await temporaryDirectory(t, "openshell-preparation-stop-");
    for (const mount of volumeMounts) {
      await mkdir(join(directory, mount.mountPath), { recursive: true });
    }
    const claimRoot = (claimName: string) => {
      const volume = volumes.find((entry) => entry.persistentVolumeClaim?.claimName === claimName);
      assert.ok(volume);
      return join(directory, volumeMount(volumeMounts, volume.name).mountPath);
    };
    const scratchRoot = claimRoot("operator-scratch");
    // fsGroup-backed volumes commonly inherit setgid; a new private child must
    // still become 0700 without changing pre-existing operator state.
    await chmod(scratchRoot, 0o2770);
    const workspaceRoot = claimRoot("harness-workspace-codex");
    // Only OCE's durable workspace participates in legacy directory migration.
    // An operator may own this identically named sibling on the separate scratch PVC.
    const sibling = join(scratchRoot, ".scratch.kubelet-created");
    await mkdir(sibling, { mode: 0o750 });
    await writeFile(join(sibling, "operator-data"), "keep operator data");
    const siblingBefore = await stat(sibling);
    const legacyWorkspace = join(workspaceRoot, ".workspace.kubelet-created");
    await mkdir(legacyWorkspace);
    await writeFile(join(legacyWorkspace, "notes.md"), "keep durable workspace");
    // Only relocate mount paths; keep the generated preparation and signal code.
    const program = command
      .replaceAll("/workspace-preparation", join(directory, "workspace-preparation"))
      .replaceAll("/preparation-status", join(directory, "preparation-status"));
    await runNativePreparation(t, program, directory);
    assert.equal(await readFile(join(sibling, "operator-data"), "utf8"), "keep operator data");
    const siblingAfter = await stat(sibling);
    assert.equal(siblingAfter.ino, siblingBefore.ino);
    assert.equal(siblingAfter.mode, siblingBefore.mode);
    assert.equal(siblingAfter.uid, siblingBefore.uid);
    const initialized = await stat(join(scratchRoot, "scratch"));
    assert.equal(initialized.mode & 0o7777, 0o700);
    assert.ok(process.getuid);
    assert.equal(initialized.uid, process.getuid());
    await assert.rejects(stat(join(scratchRoot, "scratch", "operator-data")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(workspaceRoot, "workspace", "notes.md"), "utf8"),
      "keep durable workspace",
    );
    await assert.rejects(stat(legacyWorkspace), { code: "ENOENT" });
    assert.equal((await stat(scratchRoot)).mode & 0o7777, 0o2770);

    // Only a newly created scratch child may have its inherited setgid cleared.
    // An incompatible existing directory must fail without silently repairing it.
    const scratchDirectory = join(scratchRoot, "scratch");
    await chmod(scratchDirectory, 0o750);
    await writeFile(join(scratchDirectory, "retained"), "existing scratch data");
    const refused = spawnSync(process.execPath, ["-e", program], {
      cwd: directory,
      env: { PATH: dirname(process.execPath) },
      encoding: "utf8",
      timeout: 2000,
    });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /Private workspace preparation did not complete/);
    assert.equal((await stat(scratchDirectory)).mode & 0o7777, 0o750);
    assert.equal(
      await readFile(join(scratchDirectory, "retained"), "utf8"),
      "existing scratch data",
    );
    assert.equal(await readFile(join(sibling, "operator-data"), "utf8"), "keep operator data");
  });

  test("OpenShell preserves legacy workspace recovery when its data mount uses the scratch path", async (t) => {
    const { deployment } = await orphanedNativePreparation({ dataMountPath: "/sandbox/scratch" });
    const { volumes, volumeMounts, program: command } = preparationManifest(deployment);
    const directory = await temporaryDirectory(t, "openshell-workspace-path-");
    for (const mount of volumeMounts) {
      await mkdir(join(directory, mount.mountPath), { recursive: true });
    }
    const volume = volumes.find(
      ({ persistentVolumeClaim }) => persistentVolumeClaim?.claimName === "harness-workspace-codex",
    );
    assert.ok(volume);
    const root = join(directory, volumeMount(volumeMounts, volume.name).mountPath);
    // This is the existing durable claim: its configured destination does not
    // turn it into operator scratch or remove normal legacy workspace recovery.
    const saved = join(root, ".workspace.kubelet-created");
    await mkdir(saved);
    await writeFile(join(saved, "notes.md"), "durable workspace data");
    const program = command
      .replaceAll("/workspace-preparation", join(directory, "workspace-preparation"))
      .replaceAll("/preparation-status", join(directory, "preparation-status"));
    await runNativePreparation(t, program, directory);
    assert.equal(
      await readFile(join(root, "workspace", "notes.md"), "utf8"),
      "durable workspace data",
    );
    await assert.rejects(stat(saved), { code: "ENOENT" });
  });
}
