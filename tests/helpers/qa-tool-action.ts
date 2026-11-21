import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { createQaAgent, createQaInstallation } from "./qa-installation.mjs";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

const toolProofFile = `
  const fs = require('node:fs');
  const [phase, file, marker] = process.argv.slice(1);
  if (phase === 'cleanup') {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    const entry = fs.lstatSync(file, { throwIfNoEntry: false });
    if (phase === 'precheck') {
      if (entry !== undefined) throw new Error('Scheduled or interactive tool proof path already exists');
    } else {
      if (!entry?.isFile()) throw new Error('Scheduled or interactive tool proof must be a regular file');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
          throw new Error('Scheduled or interactive tool proof file changed before readback');
        }
        const expected = Buffer.from(marker);
        const bytes = Buffer.alloc(expected.length + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        process.stdout.write(bytes.subarray(0, length).equals(expected) ? 'match' : 'mismatch');
      } finally {
        fs.closeSync(fd);
      }
    }
  }
`;

export async function verifyQaToolAction(
  f: Fixture,
  agent: Agent,
  marker: string,
  turn: (file: string) => Promise<void>,
): Promise<void> {
  const dedicated = agent.preset === "Codex";
  const role = dedicated ? "agent" : "gateway";
  const workspace = dedicated ? "/home/node/workspace" : "/home/node/.openclaw/workspace";
  const file = posix.join(workspace, `occ-tool-proof-${randomUUID()}`);
  const pod = await f.pod(agent, role);
  const { namespace, name, uid } = pod.metadata;
  const containerId = (selected: typeof pod) =>
    selected.status.containerStatuses?.find((status: { name: string }) => status.name === role)
      ?.containerID;
  const id = containerId(pod);
  assert.ok(
    uid && namespace && name && id,
    "Scheduled or interactive tool proof requires an identified workload",
  );
  const container = pod.spec.containers.find(
    (candidate: { name: string }) => candidate.name === role,
  );
  assert.ok(
    container?.volumeMounts?.some(
      (mount: { mountPath: string; readOnly?: boolean }) =>
        mount.mountPath === workspace && mount.readOnly !== true,
    ),
    "Scheduled or interactive tool proof requires a writable workspace mount in the selected workload",
  );
  const checkWorkload = async () => {
    const selected = await f.pod(agent, role);
    assert.ok(
      selected.metadata.uid === uid &&
        selected.metadata.namespace === namespace &&
        selected.metadata.name === name &&
        containerId(selected) === id,
      "Scheduled or interactive tool proof workload changed",
    );
  };
  const run = async (phase: "precheck" | "readback" | "cleanup") => {
    // The initial Pod lookup already binds the precheck. Recheck after the HTTP turn.
    if (phase !== "precheck") {
      await checkWorkload();
    }
    const stdout = await f.kubectl(
      "-n",
      namespace,
      "exec",
      name,
      "-c",
      role,
      "--",
      "node",
      "-e",
      toolProofFile,
      phase,
      file,
      marker,
    );
    await checkWorkload();
    return stdout;
  };

  await run("precheck");
  let failed = false;
  try {
    await turn(file);
    assert.equal(
      await run("readback"),
      "match",
      "the selected Harness must execute the requested tool action",
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await run("cleanup").catch((error: unknown) => {
      // Preserve the HTTP or readback failure when the owned path cannot be removed.
      if (!failed) {
        throw error;
      }
    });
  }
}
